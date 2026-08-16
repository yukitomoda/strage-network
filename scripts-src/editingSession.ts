import { Player, world } from "@minecraft/server";
import { getAllNetworks } from "./network";
import { syncRangeIndicator } from "./rangeIndicator";

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
  syncRangeIndicator(dimension, network, isAnyoneEditingNetwork(network.id));
}
