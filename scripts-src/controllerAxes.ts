import { UpgradeAxis } from "./upgrade";

// controllerBlock.ts/controllerUi.tsとorderProcessing.ts等の処理モジュールは互いに依存し合う
// 関係にある(controllerBlock.ts -> controllerUi.ts -> orderProcessing.ts等)ため、コントローラの
// アップグレード軸の定義だけはどこからも安全にimportできる末端モジュールとして切り出している
// (処理モジュール側からcontrollerBlock.tsを直接importすると循環importになってしまう)。
export const CONTROLLER_BLOCK_ID = "wh:controller";

// コントローラの「速度」アップグレード軸(引き出し/預け入れ/整理のスループット)。
// 将来「範囲」等の軸を追加する場合は、同じ形でUpgradeAxisを定義しCONTROLLER_AXESに加える
// (docs/design.md 4章「グレード管理」参照。upgrade.ts自体は変更不要)。
export const CONTROLLER_SPEED_AXIS: UpgradeAxis = {
  id: "controller_speed",
  label: "速度",
  blockTypeId: CONTROLLER_BLOCK_ID,
  stateKey: "wh:speed_tier",
  kitItemIds: ["wh:speed_kit_copper", "wh:speed_kit_iron", "wh:speed_kit_diamond", "wh:speed_kit_netherite"],
};

// コントローラが持つ全アップグレード軸。upgradeKit.tsのアイテム対応表・controllerBlock.tsの
// onPlayerBreakのドロップ処理はここを見て軸ごとに処理するので、軸を増やす時はこの配列に
// 加えるだけでよい。
export const CONTROLLER_AXES: UpgradeAxis[] = [CONTROLLER_SPEED_AXIS];
