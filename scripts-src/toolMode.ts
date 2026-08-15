import { Player } from "@minecraft/server";

// 倉庫レンチのモード。プレイヤーごとに保持する(構築モードの編集対象ネットワークと同じ考え方)。
// 将来モードが増えても、ここに型を足すだけで toolModeUi.ts の選択肢に反映される。
export type ToolMode = "build" | "drain";

const TOOL_MODE_PROPERTY = "wh:tool_mode";

export function getToolMode(player: Player): ToolMode {
  const value = player.getDynamicProperty(TOOL_MODE_PROPERTY);
  return value === "drain" ? "drain" : "build"; // デフォルトは従来通りのネットワーク構築モード
}

export function setToolMode(player: Player, mode: ToolMode): void {
  player.setDynamicProperty(TOOL_MODE_PROPERTY, mode);
}
