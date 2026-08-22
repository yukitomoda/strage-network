import { Dimension, Entity, Vector3 } from "@minecraft/server";
import { locEquals, ObserverSettings } from "./state";

// ネットワークオブザーバーの設定を保持する非表示エンティティ。storageSettings.tsと全く同じ発想
// (ブロックには動的プロパティを持たせられないため)。
const SETTINGS_ENTITY_TYPE = "wh:observer_settings";
const SETTINGS_PROPERTY = "wh:settings";
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

// storageSettings.ts/terminalSettings.tsと同じ理由(dimension.getEntitiesは近傍検索のみ)で、
// 近傍候補から自己申告の所属座標が厳密一致するものだけを採用する。
function findSettingsEntity(dimension: Dimension, observerLoc: Vector3): Entity | undefined {
  const candidates = dimension.getEntities({
    type: SETTINGS_ENTITY_TYPE,
    location: centerOf(observerLoc),
    maxDistance: 2,
  });
  return candidates.find((e) => {
    const owner = getOwnerLocation(e);
    return owner !== undefined && locEquals(owner, observerLoc);
  });
}

function ensureSettingsEntity(dimension: Dimension, observerLoc: Vector3): Entity {
  const existing = findSettingsEntity(dimension, observerLoc);
  if (existing) return existing;
  const entity = dimension.spawnEntity(SETTINGS_ENTITY_TYPE, centerOf(observerLoc));
  entity.setDynamicProperty(OWNER_LOCATION_PROPERTY, JSON.stringify(observerLoc));
  return entity;
}

export function removeSettingsEntity(dimension: Dimension, observerLoc: Vector3): void {
  findSettingsEntity(dimension, observerLoc)?.remove();
}

export function getObserverSettings(dimension: Dimension, observerLoc: Vector3): ObserverSettings | undefined {
  const raw = findSettingsEntity(dimension, observerLoc)?.getDynamicProperty(SETTINGS_PROPERTY);
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as ObserverSettings;
  } catch {
    return undefined;
  }
}

export function setObserverSettings(dimension: Dimension, observerLoc: Vector3, settings: ObserverSettings): void {
  ensureSettingsEntity(dimension, observerLoc).setDynamicProperty(SETTINGS_PROPERTY, JSON.stringify(settings));
}
