import { Dimension, Entity, Vector3 } from "@minecraft/server";
import { locEquals } from "./state";

// ストレージごとのローカル設定を保持する非表示エンティティ。terminalSettings.ts と全く同じ
// 発想: ブロック(バニラのコンテナ)には動的プロパティを持たせられないため、位置に紐づく
// 非表示エンティティ側に持たせる。二連チェストは物理的に2つのブロックがあるため、
// 設定は(該当する場合)両方の座標にそれぞれ個別のエンティティとして持たせる。
const SETTINGS_ENTITY_TYPE = "wh:storage_settings";
const DRAIN_PROPERTY = "wh:drain";
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
// しきい値のチューニングに依存せず確実に正しいエンティティを取得できる(実機で発見された
// 不具合の修正済み。詳細はdocs/design.md参照)。
function findSettingsEntity(dimension: Dimension, storageLoc: Vector3): Entity | undefined {
  const candidates = dimension.getEntities({
    type: SETTINGS_ENTITY_TYPE,
    location: centerOf(storageLoc),
    maxDistance: 2,
  });
  return candidates.find((e) => {
    const owner = getOwnerLocation(e);
    return owner !== undefined && locEquals(owner, storageLoc);
  });
}

function ensureSettingsEntity(dimension: Dimension, storageLoc: Vector3): Entity {
  const existing = findSettingsEntity(dimension, storageLoc);
  if (existing) return existing;
  const entity = dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(storageLoc));
  entity.setDynamicProperty(OWNER_LOCATION_PROPERTY, JSON.stringify(storageLoc));
  return entity;
}

export function removeSettingsEntity(dimension: Dimension, storageLoc: Vector3): void {
  findSettingsEntity(dimension, storageLoc)?.remove();
}

// Drain指定: 有効なストレージには、預け入れ(倉庫端末からの預け入れ・自動端末からの自動預け入れ)が新たに行われなくなり、
// 倉庫の整理は逆にこのストレージの中身を他のストレージへできる限り退避させる(倉庫レンチ参照)。
export function getDrain(dimension: Dimension, storageLoc: Vector3): boolean {
  const value = findSettingsEntity(dimension, storageLoc)?.getDynamicProperty(DRAIN_PROPERTY);
  return typeof value === "boolean" ? value : false; // デフォルトfalse
}

export function setDrain(dimension: Dimension, storageLoc: Vector3, value: boolean): void {
  ensureSettingsEntity(dimension, storageLoc).setDynamicProperty(DRAIN_PROPERTY, value);
}
