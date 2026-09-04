import { Dimension, Entity, Vector3 } from "@minecraft/server";
import { generateControllerName, locEquals } from "./state";

// コントローラごとのローカル設定を保持する非表示エンティティ。terminalSettings.ts/
// storageSettings.ts と全く同じ発想(ブロックには動的プロパティを持たせられないため)。
// ネットワークにつきコントローラは1台なので設定項目もごく少数だが、NetworkData(構造情報の
// JSON)を肥大化させない一貫性のため、同じ非表示エンティティ方式に揃えている。
const SETTINGS_ENTITY_TYPE = "wh:controller_settings";
const NOTIFY_ON_ORGANIZE_COMPLETE_PROPERTY = "wh:notify_on_organize_complete";
const ENABLED_PROPERTY = "wh:enabled";
const NAME_PROPERTY = "wh:name";
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

// ネットワークの「起動」スイッチ(ユーザー要望)。OFFの間、このネットワークの定期Tick処理
// (引き出し/預け入れ/整理/オブザーバー再計算、および配達・搬入出パッドの進捗表示)を
// すべてスキップする。アドオンの更新作業中に安全に一時停止させる用途を想定しているため、
// デフォルトはtrue(既存ワールドをこのバージョンへ更新した直後も、エンティティ未生成の間は
// この既定値が使われるため今まで通り動き続ける)。
export function getControllerEnabled(dimension: Dimension, controllerLoc: Vector3): boolean {
  const value = findSettingsEntity(dimension, controllerLoc)?.getDynamicProperty(ENABLED_PROPERTY);
  return typeof value === "boolean" ? value : true; // デフォルトtrue
}

export function setControllerEnabled(dimension: Dimension, controllerLoc: Vector3, value: boolean): void {
  ensureSettingsEntity(dimension, controllerLoc).setDynamicProperty(ENABLED_PROPERTY, value);
}

// コントローラの名前(ユーザー要望: ターミナルと同様に名付けられるようにしてほしい)。
// ターミナルの名前(terminalSettings.ts)と違い、リモート配達ターミナルの「状況」タブでの
// 表示など「常に何か読める名前がある」ことが前提の使い方があるため、未設定(この機能を
// 追加する前に設置された既存ワールドのコントローラ等)ならこの場でランダムに生成して
// 永続化する(getTerminalNameのように無名(undefined)のままにはしない)。
export function getControllerName(dimension: Dimension, controllerLoc: Vector3): string {
  const existing = findSettingsEntity(dimension, controllerLoc)?.getDynamicProperty(NAME_PROPERTY);
  if (typeof existing === "string" && existing.length > 0) return existing;
  const generated = generateControllerName();
  setControllerName(dimension, controllerLoc, generated);
  return generated;
}

export function setControllerName(dimension: Dimension, controllerLoc: Vector3, name: string | undefined): void {
  ensureSettingsEntity(dimension, controllerLoc).setDynamicProperty(NAME_PROPERTY, name && name.length > 0 ? name : undefined);
}
