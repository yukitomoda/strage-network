import { Player, world } from "@minecraft/server";
import { getAllNetworks } from "./network";
import { syncMemberHighlight } from "./memberHighlight";
import { syncRangeIndicator } from "./rangeIndicator";
import { NetworkData } from "./state";
import { getToolMode } from "./toolMode";

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

// 接続範囲インジケータ(rangeIndicator.ts)の表示要否判定に使う: 複数人が同時に同じ
// ネットワークを編集していることもあるため、「自分が終了する」だけでは即座に隠してよいか
// 判断できない。ログイン中の全プレイヤーを見て、誰か1人でもまだ編集中なら表示を続ける。
export function isAnyoneEditingNetwork(networkId: string): boolean {
  return world.getPlayers().some((p) => getEditingNetworkId(p) === networkId);
}

// このネットワークを編集中のプレイヤーを(誰でもよいので)1人見つける。メンバーハイライト
// (memberHighlight.ts)の色分け(構築/Drain)に使う: エンティティ1セットに対してモードは
// 1つしか持てないため、複数人が同時に異なるモードで同じネットワークを編集している場合は
// 先に見つかった1人のモードを採用する(稀なケースであり、致命的な不整合にはならない)。
// memberHighlight.ts自身がgetEditingNetworkIdに依存すると循環importになるため、
// (memberHighlight.tsからeditingSession.tsを参照する形にはできないため)ここに置く。
function findAnyEditor(networkId: string): Player | undefined {
  return world.getPlayers().find((p) => getEditingNetworkId(p) === networkId);
}

export function currentHighlightMode(network: NetworkData): "off" | "build" | "drain" {
  const editor = findAnyEditor(network.id);
  if (!editor) return "off";
  return getToolMode(editor);
}

// 編集セッションを終了し、接続範囲インジケータの表示状態も合わせて同期する。
// コントローラでの終了(wrench.tsのhandleControllerUse)・レンチメニューからの終了
// (toolModeUi.ts)・プレイヤー退出時の強制終了(wrench.tsのplayerLeaveフック)の
// 3箇所から共通で使う(表示同期のし忘れを防ぐため、setEditingNetworkIdを直接
// 呼ばせずここに一本化している)。
export function endEditingSession(player: Player): void {
  const networkId = getEditingNetworkId(player);
  if (networkId === undefined) return;
  setEditingNetworkId(player, undefined);

  const network = getAllNetworks().find((n) => n.id === networkId);
  if (!network) return; // 編集中にネットワーク自体が解体された等。表示すべきインジケータも無い
  const dimension = world.getDimension(network.dimensionId);
  const stillEditing = isAnyoneEditingNetwork(network.id);
  syncRangeIndicator(dimension, network, stillEditing);
  // 他に編集中のプレイヤーがいればそのモードで表示を維持する(currentHighlightModeが
  // 内部でfindAnyEditorするため、ここで自分は既にsetEditingNetworkId(undefined)済み)。
  syncMemberHighlight(dimension, network, stillEditing ? currentHighlightMode(network) : "off");
}
