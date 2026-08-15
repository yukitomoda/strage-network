import { Player } from "@minecraft/server";

// プレイヤーが現在編集中のネットワークID。コントローラをShift+右クリックした時に開始/終了する
// (wrench.tsのhandleControllerUse)。wrench.ts/toolModeUi.tsの両方から参照するため、
// toolMode.tsと同じ考え方で専用モジュールに切り出している(循環importを避ける目的もある)。
const EDITING_NETWORK_PROPERTY = "wh:editing_network";

export function getEditingNetworkId(player: Player): string | undefined {
  const value = player.getDynamicProperty(EDITING_NETWORK_PROPERTY);
  return typeof value === "string" ? value : undefined;
}

export function setEditingNetworkId(player: Player, networkId: string | undefined): void {
  player.setDynamicProperty(EDITING_NETWORK_PROPERTY, networkId);
}
