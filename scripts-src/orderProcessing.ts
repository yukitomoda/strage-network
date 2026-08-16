import { Dimension, system, Vector3, world } from "@minecraft/server";
import {
  appendPartial,
  getIssuing,
  getOrderCancels,
  getOrders,
  setIssuing,
  setOrderCancels,
  setOrders,
} from "./network";
import { extractFromStorages } from "./storageScan";
import { generateId, generateOrderId, locEquals, NetworkData, Order, OrderLine, PartialResultLine } from "./state";
import { getAttachedStorageLocation, isTerminalLikeBlock } from "./terminalBlock";
import { getNotifyOnComplete, getTerminalName } from "./terminalSettings";

// MVP: 十分大きい固定値(=実質即時処理)。将来はコントローラのグレードに応じて可変にする。
// docs/design.md 4章「スループット制」参照。
const THROUGHPUT_PER_TICK = 1_0;
// MVP: 発行遅延なし。将来はターミナルのグレードに応じて可変にする。
const ISSUE_DELAY_TICKS = 0;

// 戻り値の id はプレイヤーへの表示用(引き出し確定時のメッセージ、完了通知に使う)。
export function submitOrder(networkId: string, terminalLoc: Vector3, playerName: string, lines: OrderLine[]): string {
  const order: Order = { id: generateOrderId(), requestId: generateId(), playerName, terminal: terminalLoc, lines };
  const entries = getIssuing(networkId);
  entries.push({ order, readyAtTick: system.currentTick + ISSUE_DELAY_TICKS });
  setIssuing(networkId, entries);
  return order.id;
}

// コントローラの「状況」タブ(controllerUi.ts)向け: 発行待ち(issuing)・処理中(orders)を
// 合わせた「まだ完了していない引き出し」一覧。hasPendingOrderFor(autoOrderCheck.ts)と
// 同じ「両方見る」考え方。
export function listActiveOrders(networkId: string): Order[] {
  return [...getIssuing(networkId).map((entry) => entry.order), ...getOrders(networkId)];
}

// requestId(厳密な一意ID。表示用の緩いidとは別物)を指定して引き出しをキャンセルする。
// 即座には取り消さず、専用のキャンセルキューに積むだけにする(processNetworkOrdersが
// 次回実行時の先頭で優先的に処理する)。
export function cancelOrder(networkId: string, requestId: string): void {
  const cancels = getOrderCancels(networkId);
  cancels.push(requestId);
  setOrderCancels(networkId, cancels);
}

// キャンセル要求を、通常の引き出し処理より先に消費する。issuing(発行待ち)・orders(処理中の
// FIFO)のどちらに居ても、次にそれが処理される前に確実に取り除けるように、両方から探す。
// 巻き戻しは行わない: 既に配送済みの分はそのまま、残りの未処理ラインだけが無かったことになる。
function processOrderCancels(network: NetworkData): void {
  const cancelIds = getOrderCancels(network.id);
  if (cancelIds.length === 0) return;
  const cancelSet = new Set(cancelIds);

  const issuing = getIssuing(network.id).filter((entry) => !cancelSet.has(entry.order.requestId));
  setIssuing(network.id, issuing);

  const orders = getOrders(network.id).filter((order) => !cancelSet.has(order.requestId));
  setOrders(network.id, orders);

  setOrderCancels(network.id, []); // 消費済み
}

export function processNetworkOrders(network: NetworkData): void {
  const dimension = world.getDimension(network.dimensionId);

  processOrderCancels(network);
  moveReadyIssuingEntries(network);

  let budget = THROUGHPUT_PER_TICK;
  let orders = getOrders(network.id);

  while (budget > 0 && orders.length > 0) {
    const order = orders[0];
    const line = order.lines.find((l) => !l.exhausted && l.delivered < l.requested);

    if (!line) {
      finalizeOrder(network, dimension, order);
      orders = orders.slice(1);
      setOrders(network.id, orders);
      continue;
    }

    // network.terminals(登録データ)を正とする。ここに無ければ本当に切断/破壊されたとみなす。
    // 登録はあるのにブロックが今取得できない場合は、ワールド再読み込み直後などでその
    // チャンクがまだ読み込まれていないだけの可能性があるため、打ち切らずに次tickへ持ち越す
    // (実機で、これが原因で処理中の引き出しが誤って消えることを確認済み)。
    const stillRegistered = network.terminals.some((t) => locEquals(t, order.terminal));
    if (!stillRegistered) {
      finalizeOrder(network, dimension, order);
      orders = orders.slice(1);
      setOrders(network.id, orders);
      continue;
    }

    const terminalBlock = dimension.getBlock(order.terminal);
    if (!terminalBlock?.isValid || !isTerminalLikeBlock(terminalBlock.typeId)) {
      // 登録はあるが、今はブロックを取得できない(チャンク未読み込み等)。今回はここで諦めて
      // 次tickに再試行する(FIFOを守るため、後続の引き出しの処理には進まない)。
      break;
    }

    // 搬入先はターミナルが張り付いている面(wh:facing)の先のブロック。毎回動的に見る。
    const attachedLoc = getAttachedStorageLocation(terminalBlock);
    const destContainer = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
    if (!destContainer) {
      // 張り付いた先にコンテナが無い: 全ラインが不足として記録される
      finalizeOrder(network, dimension, order);
      orders = orders.slice(1);
      setOrders(network.id, orders);
      continue;
    }

    const attempt = Math.min(line.requested - line.delivered, budget);
    const extracted = extractFromStorages(
      dimension,
      network,
      { typeId: line.itemTypeId, name: line.itemName },
      attempt,
      destContainer
    );
    line.delivered += extracted;
    budget -= extracted;

    // extracted < attempt は「予算不足」ではなく「真の在庫/受け皿不足」を意味する
    // (attempt自体が budget で既に絞られているため)
    if (extracted < attempt) line.exhausted = true;

    setOrders(network.id, orders); // ラインを1つ処理するたびに書き戻す

    if (budget <= 0) break;
  }
}

function moveReadyIssuingEntries(network: NetworkData): void {
  const issuing = getIssuing(network.id);
  if (issuing.length === 0) return;

  const stillWaiting = issuing.filter((entry) => entry.readyAtTick > system.currentTick);
  const ready = issuing.filter((entry) => entry.readyAtTick <= system.currentTick);
  if (ready.length === 0) return;

  setIssuing(network.id, stillWaiting);
  const orders = getOrders(network.id);
  for (const entry of ready) orders.push(entry.order);
  setOrders(network.id, orders);
}

function finalizeOrder(network: NetworkData, dimension: Dimension, order: Order): void {
  const shortfall: PartialResultLine[] = order.lines
    .filter((l) => l.delivered < l.requested)
    .map((l) => ({ itemTypeId: l.itemTypeId, itemName: l.itemName, amount: l.requested - l.delivered }));

  if (shortfall.length > 0) {
    appendPartial(network.id, { orderId: order.id, terminal: order.terminal, shortfall });
  }

  // ターミナルごとの設定(通知の有無)は非表示エンティティ側に持たせている(terminalSettings.ts)。
  // ターミナルが切断/破壊済みでエンティティが無い場合はデフォルト(true)扱いになる。
  if (!getNotifyOnComplete(dimension, order.terminal)) return;

  const player = world.getPlayers().find((p) => p.name === order.playerName);
  if (!player) return; // オフライン等。ログイン中の通知のみサポート(MVP)

  const terminalName = getTerminalName(dimension, order.terminal);
  const namePrefix = terminalName ? `「${terminalName}」の` : "";

  player.sendMessage(
    shortfall.length > 0
      ? `§e${namePrefix}引き出し #${order.id} の受け取り準備ができました(一部品切れで届かなかった品があります)。`
      : `§b${namePrefix}引き出し #${order.id} の受け取り準備ができました。`
  );
}
