import { Dimension, Entity, Vector3 } from "@minecraft/server";
import { locEquals, PrecisionSlotLine, StockTargetLine, WishlistLine } from "./state";

// ターミナルごとのローカル設定を保持する非表示エンティティ。ブロックには動的プロパティを
// 持たせられないため(docs/design.md 2章参照)。network.terminals(所属情報)とは意図的に
// 分離しており、設定を増やしてもネットワーク全体のJSONには影響しない。
//
// バッファ用途(6章の旧設計)と違い、保持するのは軽量な設定値だけで実物のアイテムは無いため、
// 万一エンティティが失われても実害は「設定がデフォルトに戻る」程度に留まる。そのため
// 自己修復のような作り込みはせず、無敵化(damage_sensor)だけ入れて事故を減らす程度にしている。
const SETTINGS_ENTITY_TYPE = "wh:terminal_settings";
const NOTIFY_ON_COMPLETE_PROPERTY = "wh:notify_on_complete";
const NAME_PROPERTY = "wh:name";
const WISHLIST_PROPERTY = "wh:wishlist";
const STOCK_TARGETS_PROPERTY = "wh:stock_targets";
const AUTO_DEPOSIT_PROPERTY = "wh:auto_deposit";
const INVENTORY_AUTO_DEPOSIT_PROPERTY = "wh:inventory_auto_deposit";
const PRECISION_SLOTS_PROPERTY = "wh:precision_slots";
const OWNER_LOCATION_PROPERTY = "wh:owner_loc";

function centerOf(loc: Vector3): Vector3 {
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

function getOwnerLocation(entity: Entity): Vector3 | undefined {
  const raw = entity.getDynamicProperty(OWNER_LOCATION_PROPERTY);
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as Vector3;
  } catch {
    return undefined;
  }
}

// dimension.getEntitiesは「近傍」の検索(maxDistanceによる球状の絞り込み)しかできず、
// 「その座標そのもの」を厳密に取得するAPIが無い。そのため、まず近傍で候補を絞り込んだ上で、
// 各エンティティが自己申告している所属ブロック座標(wh:owner_loc、spawnEntity直後に書き込む)
// と厳密一致するものだけを採用する。これにより、隣接ブロック同士が近い場合でも、距離の
// しきい値のチューニングに依存せず確実に正しいエンティティを取得できる(storageSettings.ts
// と同根の不具合が実機で発見され、修正済み。詳細はdocs/design.md参照)。
function findSettingsEntity(dimension: Dimension, terminalLoc: Vector3): Entity | undefined {
  const candidates = dimension.getEntities({
    type: SETTINGS_ENTITY_TYPE,
    location: centerOf(terminalLoc),
    maxDistance: 2,
  });
  return candidates.find((e) => {
    const owner = getOwnerLocation(e);
    return owner !== undefined && locEquals(owner, terminalLoc);
  });
}

function ensureEntity(dimension: Dimension, terminalLoc: Vector3): Entity {
  const existing = findSettingsEntity(dimension, terminalLoc);
  if (existing) return existing;
  const entity = dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(terminalLoc));
  entity.setDynamicProperty(OWNER_LOCATION_PROPERTY, JSON.stringify(terminalLoc));
  return entity;
}

export function ensureSettingsEntity(dimension: Dimension, terminalLoc: Vector3): void {
  ensureEntity(dimension, terminalLoc);
}

export function removeSettingsEntity(dimension: Dimension, terminalLoc: Vector3): void {
  findSettingsEntity(dimension, terminalLoc)?.remove();
}

export function getNotifyOnComplete(dimension: Dimension, terminalLoc: Vector3): boolean {
  const value = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(NOTIFY_ON_COMPLETE_PROPERTY);
  return typeof value === "boolean" ? value : true; // デフォルトtrue
}

export function setNotifyOnComplete(dimension: Dimension, terminalLoc: Vector3, value: boolean): void {
  ensureEntity(dimension, terminalLoc).setDynamicProperty(NOTIFY_ON_COMPLETE_PROPERTY, value);
}

// 通知等に表示するターミナルの名前。設置時に区別用の仮名が自動で入るほか、
// 設定タブからいつでも自由に変更/削除できる。
export function getTerminalName(dimension: Dimension, terminalLoc: Vector3): string | undefined {
  const value = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(NAME_PROPERTY);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function setTerminalName(dimension: Dimension, terminalLoc: Vector3, name: string | undefined): void {
  ensureEntity(dimension, terminalLoc).setDynamicProperty(NAME_PROPERTY, name && name.length > 0 ? name : undefined);
}

// 自動端末の「維持したい在庫量」リスト。通常のターミナルは使わない。
export function getWishlist(dimension: Dimension, terminalLoc: Vector3): WishlistLine[] {
  const raw = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(WISHLIST_PROPERTY);
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as WishlistLine[];
  } catch {
    return [];
  }
}

export function setWishlist(dimension: Dimension, terminalLoc: Vector3, wishlist: WishlistLine[]): void {
  ensureEntity(dimension, terminalLoc).setDynamicProperty(WISHLIST_PROPERTY, JSON.stringify(wishlist));
}

// 在庫管理ターミナルの「維持したいネットワーク在庫数」リスト。他のターミナルは使わない。
export function getStockTargets(dimension: Dimension, terminalLoc: Vector3): StockTargetLine[] {
  const raw = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(STOCK_TARGETS_PROPERTY);
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as StockTargetLine[];
  } catch {
    return [];
  }
}

export function setStockTargets(dimension: Dimension, terminalLoc: Vector3, targets: StockTargetLine[]): void {
  ensureEntity(dimension, terminalLoc).setDynamicProperty(STOCK_TARGETS_PROPERTY, JSON.stringify(targets));
}

// 自動端末の「自動預け入れ」設定。リストに無い、または目標を上回るアイテムがあれば
// 自動でネットワークへ預け入れる。
export function getAutoDeposit(dimension: Dimension, terminalLoc: Vector3): boolean {
  const value = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(AUTO_DEPOSIT_PROPERTY);
  return typeof value === "boolean" ? value : true; // デフォルトtrue
}

export function setAutoDeposit(dimension: Dimension, terminalLoc: Vector3, value: boolean): void {
  ensureEntity(dimension, terminalLoc).setDynamicProperty(AUTO_DEPOSIT_PROPERTY, value);
}

// 在庫管理ターミナルの「自動預け入れ」設定。自動端末のAUTO_DEPOSIT_PROPERTYとは意味が狭く
// (在庫目標を上回った分の扱いは常時有効の在庫管理ロジック側で既に行っているため)、
// 「リストに無いアイテムをアタッチ先から一掃するか」だけを指す。デフォルトは自動端末と違い
// false(意図せずアタッチ先の物を全部持っていかれる事故を避けるため、明示的にONにする方式)。
export function getInventoryAutoDeposit(dimension: Dimension, terminalLoc: Vector3): boolean {
  const value = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(INVENTORY_AUTO_DEPOSIT_PROPERTY);
  return typeof value === "boolean" ? value : false; // デフォルトfalse
}

export function setInventoryAutoDeposit(dimension: Dimension, terminalLoc: Vector3, value: boolean): void {
  ensureEntity(dimension, terminalLoc).setDynamicProperty(INVENTORY_AUTO_DEPOSIT_PROPERTY, value);
}

// 精密ターミナルの「スロットごとのルール」(入力/出力)。他のターミナルは使わない。
export function getPrecisionSlots(dimension: Dimension, terminalLoc: Vector3): PrecisionSlotLine[] {
  const raw = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(PRECISION_SLOTS_PROPERTY);
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as PrecisionSlotLine[];
  } catch {
    return [];
  }
}

export function setPrecisionSlots(dimension: Dimension, terminalLoc: Vector3, slots: PrecisionSlotLine[]): void {
  ensureEntity(dimension, terminalLoc).setDynamicProperty(PRECISION_SLOTS_PROPERTY, JSON.stringify(slots));
}
