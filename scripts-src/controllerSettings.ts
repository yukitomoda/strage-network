import { Dimension, Entity, Vector3 } from "@minecraft/server";
import { locEquals } from "./state";

// コントローラごとのローカル設定を保持する非表示エンティティ。terminalSettings.ts/
// storageSettings.ts と全く同じ発想(ブロックには動的プロパティを持たせられないため)。
// ネットワークにつきコントローラは1台なので設定項目もごく少数だが、NetworkData(構造情報の
// JSON)を肥大化させない一貫性のため、同じ非表示エンティティ方式に揃えている。
const SETTINGS_ENTITY_TYPE = "wh:controller_settings";
const NOTIFY_ON_ORGANIZE_COMPLETE_PROPERTY = "wh:notify_on_organize_complete";
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

// dimension.getEntitiesは「近傍」の検索しかできないため、近傍で候補を絞り込んだ上で
// 自己申告の所属座標(wh:owner_loc)と厳密一致するものだけを採用する(terminalSettings.ts/
// storageSettings.tsと同じ、実機で発見された不具合の修正パターン)。
function findSettingsEntity(dimension: Dimension, controllerLoc: Vector3): Entity | undefined {
  const candidates = dimension.getEntities({
    type: SETTINGS_ENTITY_TYPE,
    location: centerOf(controllerLoc),
    maxDistance: 2,
  });
  return candidates.find((e) => {
    const owner = getOwnerLocation(e);
    return owner !== undefined && locEquals(owner, controllerLoc);
  });
}

function ensureSettingsEntity(dimension: Dimension, controllerLoc: Vector3): Entity {
  const existing = findSettingsEntity(dimension, controllerLoc);
  if (existing) return existing;
  const entity = dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(controllerLoc));
  entity.setDynamicProperty(OWNER_LOCATION_PROPERTY, JSON.stringify(controllerLoc));
  return entity;
}

export function removeSettingsEntity(dimension: Dimension, controllerLoc: Vector3): void {
  findSettingsEntity(dimension, controllerLoc)?.remove();
}

// 整理完了時に通知するか。ターミナルの引き出し完了通知(terminalSettings.ts)と同じ考え方。
export function getNotifyOnOrganizeComplete(dimension: Dimension, controllerLoc: Vector3): boolean {
  const value = findSettingsEntity(dimension, controllerLoc)?.getDynamicProperty(
    NOTIFY_ON_ORGANIZE_COMPLETE_PROPERTY
  );
  return typeof value === "boolean" ? value : true; // デフォルトtrue
}

export function setNotifyOnOrganizeComplete(dimension: Dimension, controllerLoc: Vector3, value: boolean): void {
  ensureSettingsEntity(dimension, controllerLoc).setDynamicProperty(NOTIFY_ON_ORGANIZE_COMPLETE_PROPERTY, value);
}
