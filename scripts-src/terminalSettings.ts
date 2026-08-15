import { Dimension, Vector3 } from "@minecraft/server";
import { WishlistLine } from "./state";

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
const AUTO_DEPOSIT_PROPERTY = "wh:auto_deposit";

function centerOf(loc: Vector3): Vector3 {
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

function findSettingsEntity(dimension: Dimension, terminalLoc: Vector3) {
  return dimension.getEntities({ type: SETTINGS_ENTITY_TYPE, location: centerOf(terminalLoc), maxDistance: 2 })[0];
}

export function ensureSettingsEntity(dimension: Dimension, terminalLoc: Vector3): void {
  if (findSettingsEntity(dimension, terminalLoc)) return;
  dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(terminalLoc));
}

export function removeSettingsEntity(dimension: Dimension, terminalLoc: Vector3): void {
  findSettingsEntity(dimension, terminalLoc)?.remove();
}

export function getNotifyOnComplete(dimension: Dimension, terminalLoc: Vector3): boolean {
  const value = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(NOTIFY_ON_COMPLETE_PROPERTY);
  return typeof value === "boolean" ? value : true; // デフォルトtrue
}

export function setNotifyOnComplete(dimension: Dimension, terminalLoc: Vector3, value: boolean): void {
  const entity = findSettingsEntity(dimension, terminalLoc) ?? dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(terminalLoc));
  entity.setDynamicProperty(NOTIFY_ON_COMPLETE_PROPERTY, value);
}

// 通知等に表示するターミナルの名前。設置時に区別用の仮名が自動で入るほか、
// 設定タブからいつでも自由に変更/削除できる。
export function getTerminalName(dimension: Dimension, terminalLoc: Vector3): string | undefined {
  const value = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(NAME_PROPERTY);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function setTerminalName(dimension: Dimension, terminalLoc: Vector3, name: string | undefined): void {
  const entity = findSettingsEntity(dimension, terminalLoc) ?? dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(terminalLoc));
  entity.setDynamicProperty(NAME_PROPERTY, name && name.length > 0 ? name : undefined);
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
  const entity = findSettingsEntity(dimension, terminalLoc) ?? dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(terminalLoc));
  entity.setDynamicProperty(WISHLIST_PROPERTY, JSON.stringify(wishlist));
}

// 自動端末の「自動預け入れ」設定。リストに無い、または目標を上回るアイテムがあれば
// 自動でネットワークへ預け入れる。
export function getAutoDeposit(dimension: Dimension, terminalLoc: Vector3): boolean {
  const value = findSettingsEntity(dimension, terminalLoc)?.getDynamicProperty(AUTO_DEPOSIT_PROPERTY);
  return typeof value === "boolean" ? value : true; // デフォルトtrue
}

export function setAutoDeposit(dimension: Dimension, terminalLoc: Vector3, value: boolean): void {
  const entity = findSettingsEntity(dimension, terminalLoc) ?? dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(terminalLoc));
  entity.setDynamicProperty(AUTO_DEPOSIT_PROPERTY, value);
}
