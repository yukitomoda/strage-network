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
import { extractFromStorages, extractFromStoragesIntoSlot } from "./storageScan";
import { generateId, generateOrderId, locEquals, NetworkData, Order, OrderLine, PartialResultLine } from "./state";
import { getAttachedStorageLocation, isTerminalLikeBlock } from "./terminalBlock";
import { getNotifyOnComplete, getTerminalName } from "./terminalSettings";
import { CONTROLLER_SPEED_AXIS } from "./controllerAxes";
import { getAxisTier } from "./upgrade";

// コントローラの速度アップグレード軸(tier0〜4)ごとの予算。docs/design.md 4章「スループット制」
// 参照。「CYCLE」は「processNetworkOrdersが1回呼ばれるたびの予算」という意味で、Minecraftの
// サーバーtick単位のレートではない(呼ばれる間隔はコントローラの「周期」アップグレード軸の
// Tierに応じて可変。networkProcessing.tsのgetCycleIntervalTicks参照)。
const ORDER_THROUGHPUT_BY_TIER = [128, 192, 384, 1024, 4096];
// コントローラUIの「状況」タブ表示用にexportしている。
export function getOrderThroughput(tier: number): number {
  return ORDER_THROUGHPUT_BY_TIER[tier] ?? ORDER_THROUGHPUT_BY_TIER[ORDER_THROUGHPUT_BY_TIER.length - 1];
}
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
// 合わせた「まだ完了していない引き出し」一覧。hasPendingOrderForと同じ「両方見る」考え方。
export function listActiveOrders(networkId: string): Order[] {
  return [...getIssuing(networkId).map((entry) => entry.order), ...getOrders(networkId)];
}

// 直前のチェックで出した引き出しがまだ処理中(発行待ち含む)なら、同じ品目を二重に引き出し
// しないための判定。自動端末(autoOrderCheck.ts)・在庫管理ターミナル(inventoryCheck.ts)の
// どちらの定期チェックからも使う共通処理なのでここに置いている。
export function hasPendingOrderFor(
  networkId: string,
  terminalLoc: Vector3,
  itemTypeId: string,
  itemName: string | undefined
): boolean {
  const pendingOrders = [...getIssuing(networkId).map((entry) => entry.order), ...getOrders(networkId)];
  return pendingOrders.some(
    (order) =>
      locEquals(order.terminal, terminalLoc) &&
      order.lines.some(
        (line) =>
          line.itemTypeId === itemTypeId &&
          (line.itemName ?? "") === (itemName ?? "") &&
          !line.exhausted &&
          line.delivered < line.requested
      )
  );
}

// hasPendingOrderForは品目ベースの判定だが、精密ターミナルの「リスト外スロットの回収」は
// 送信のたびに品目が変わりうるため、(terminal, slotIndex)ベースで判定する必要がある
// (precisionTerminalCheck.ts参照)。
export function hasPendingSlotOrderFor(networkId: string, terminalLoc: Vector3, slotIndex: number): boolean {
  const pendingOrders = [...getIssuing(networkId).map((entry) => entry.order), ...getOrders(networkId)];
  return pendingOrders.some(
    (order) =>
      locEquals(order.terminal, terminalLoc) &&
      order.lines.some((line) => line.slotIndex === slotIndex && !line.exhausted && line.delivered < line.requested)
  );
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

// 戻り値は、このtickで1個以上のアイテムが実際にネットワークから搬出されたか
// (networkObserverProcessing.tsの再計算を直ちにトリガすべきか、networkProcessing.ts参照)。
export function processNetworkOrders(network: NetworkData): boolean {
  const dimension = world.getDimension(network.dimensionId);

  processOrderCancels(network);
  moveReadyIssuingEntries(network);

  let budget = getOrderThroughput(getAxisTier(dimension, network.controller, CONTROLLER_SPEED_AXIS));
  let orders = getOrders(network.id);
  let anyDelivered = false;

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
    // 精密ターミナルからの依頼(line.slotIndexあり)は指定スロットのみへ搬入する
    // (storageScan.tsのextractFromStoragesIntoSlot参照)。それ以外は従来通りコンテナのどこでもいい。
    const extracted =
      line.slotIndex !== undefined
        ? extractFromStoragesIntoSlot(
            dimension,
            network,
            { typeId: line.itemTypeId, name: line.itemName },
            attempt,
            destContainer,
            line.slotIndex
          )
        : extractFromStorages(
            dimension,
            network,
            { typeId: line.itemTypeId, name: line.itemName },
            attempt,
            destContainer
          );
    line.delivered += extracted;
    budget -= extracted;
    if (extracted > 0) anyDelivered = true;

    // extracted < attempt は「予算不足」ではなく「真の在庫/受け皿不足」を意味する
    // (attempt自体が budget で既に絞られているため)
    if (extracted < attempt) line.exhausted = true;

    setOrders(network.id, orders); // ラインを1つ処理するたびに書き戻す

    if (budget <= 0) break;
  }

  return anyDelivered;
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
      ? `§e${namePrefix}引き出し #${order.id} の受け取り準備ができました(一部搬送できなかった品があります)。`
      : `§b${namePrefix}引き出し #${order.id} の受け取り準備ができました。`
  );
}
