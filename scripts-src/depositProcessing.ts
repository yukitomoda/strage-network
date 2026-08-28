import { Dimension, system, Vector3, world } from "@minecraft/server";
import {
  appendDepositPartial,
  getDepositCancels,
  getDepositIssuing,
  getDeposits,
  setDepositCancels,
  setDepositIssuing,
  setDeposits,
} from "./network";
import { buildStorageIndex, insertIntoStorages, insertSlotIntoStorages } from "./storageScan";
import {
  DepositLine,
  DepositRequest,
  generateDepositId,
  generateId,
  locEquals,
  NetworkData,
  PartialResultLine,
} from "./state";
import { getDrain } from "./storageSettings";
import { getAttachedStorageLocation, isTerminalLikeBlock, IO_PAD_BLOCK_ID } from "./terminalBlock";
import { CONTROLLER_SPEED_AXIS } from "./controllerAxes";
import { getAxisTier } from "./upgrade";

// 引き出し(orderProcessing.ts)と対称だが、方向が逆(ターミナルの張り付いた先 -> ネットワーク内の
// ストレージ群)で、スループット・発行遅延は個別に設定できるようにしている。
// docs/design.md 4章参照。コントローラの速度アップグレード軸(tier0〜4)ごとの予算。
// orderProcessing.tsのORDER_THROUGHPUT_BY_TIERと同じ値・同じ考え方(Minecraftのサーバーtick
// 単位のレートではなく処理ループ1回あたりの予算)。
const DEPOSIT_THROUGHPUT_BY_TIER = [128, 192, 384, 1024, 4096];
// コントローラUIの「状況」タブ表示用にexportしている。
export function getDepositThroughput(tier: number): number {
  return DEPOSIT_THROUGHPUT_BY_TIER[tier] ?? DEPOSIT_THROUGHPUT_BY_TIER[DEPOSIT_THROUGHPUT_BY_TIER.length - 1];
}
const DEPOSIT_ISSUE_DELAY_TICKS = 0;

// 戻り値のdisplayIdはプレイヤーへの表示用(submitOrderのidと同じ役割)。
export function submitDeposit(networkId: string, terminalLoc: Vector3, playerName: string, lines: DepositLine[]): string {
  const request: DepositRequest = {
    id: generateId(),
    displayId: generateDepositId(),
    playerName,
    terminal: terminalLoc,
    lines,
  };
  const entries = getDepositIssuing(networkId);
  entries.push({ request, readyAtTick: system.currentTick + DEPOSIT_ISSUE_DELAY_TICKS });
  setDepositIssuing(networkId, entries);
  return request.displayId;
}

// コントローラの「状況」タブ(controllerUi.ts)向け: orderProcessing.tsのlistActiveOrdersと
// 同じ考え方。DepositRequest.idは(Order.idと違い)元々generateId()による厳密な一意IDなので、
// 表示・キャンセル指定のどちらにもそのまま使える(別途requestIdを持たせる必要が無い)。
export function listActiveDeposits(networkId: string): DepositRequest[] {
  return [...getDepositIssuing(networkId).map((entry) => entry.request), ...getDeposits(networkId)];
}

// orderProcessing.tsのhasPendingOrderForと同じ発想。直前に送った預け入れがまだ処理中なら
// 同じ品目を二重に送らないための判定。自動端末・在庫管理ターミナルのどちらの定期チェックからも
// 使う共通処理なのでここに置いている。
export function hasPendingDepositFor(
  networkId: string,
  terminalLoc: Vector3,
  itemTypeId: string,
  itemName: string | undefined
): boolean {
  const pendingDeposits = [
    ...getDepositIssuing(networkId).map((entry) => entry.request),
    ...getDeposits(networkId),
  ];
  return pendingDeposits.some(
    (request) =>
      locEquals(request.terminal, terminalLoc) &&
      request.lines.some(
        (line) =>
          line.itemTypeId === itemTypeId &&
          (line.itemName ?? "") === (itemName ?? "") &&
          !line.exhausted &&
          line.delivered < line.requested
      )
  );
}

// orderProcessing.tsのhasPendingSlotOrderForと同じ発想。精密ターミナルの「リスト外スロットの
// 回収」は送信のたびに品目が変わりうるため、(terminal, slotIndex)ベースで判定する。
export function hasPendingSlotDepositFor(networkId: string, terminalLoc: Vector3, slotIndex: number): boolean {
  const pendingDeposits = [
    ...getDepositIssuing(networkId).map((entry) => entry.request),
    ...getDeposits(networkId),
  ];
  return pendingDeposits.some(
    (request) =>
      locEquals(request.terminal, terminalLoc) &&
      request.lines.some((line) => line.slotIndex === slotIndex && !line.exhausted && line.delivered < line.requested)
  );
}

// orderProcessing.tsのcancelOrderと同じ発想の専用キャンセルキュー。
export function cancelDeposit(networkId: string, requestId: string): void {
  const cancels = getDepositCancels(networkId);
  cancels.push(requestId);
  setDepositCancels(networkId, cancels);
}

// orderProcessing.tsのprocessOrderCancelsと同じ発想。issuing・requests両方から探して除去する。
function processDepositCancels(network: NetworkData): void {
  const cancelIds = getDepositCancels(network.id);
  if (cancelIds.length === 0) return;
  const cancelSet = new Set(cancelIds);

  const issuing = getDepositIssuing(network.id).filter((entry) => !cancelSet.has(entry.request.id));
  setDepositIssuing(network.id, issuing);

  const requests = getDeposits(network.id).filter((request) => !cancelSet.has(request.id));
  setDeposits(network.id, requests);

  setDepositCancels(network.id, []); // 消費済み
}

// 戻り値は、このtickで1個以上のアイテムが実際にネットワークへ搬入されたか
// (networkObserverProcessing.tsの再計算を直ちにトリガすべきか、networkProcessing.ts参照)。
export function processNetworkDeposits(network: NetworkData): boolean {
  const dimension = world.getDimension(network.dimensionId);

  processDepositCancels(network);
  moveReadyDepositIssuingEntries(network);

  let budget = getDepositThroughput(getAxisTier(dimension, network.controller, CONTROLLER_SPEED_AXIS));
  let requests = getDeposits(network.id);
  if (requests.length === 0) return false;

  // 「どのストレージに何が既にあるか」の索引は、このtickのこのネットワーク分だけ1回作って使い回す。
  // 品目ごとに全ストレージを舐め直すと、大規模なネットワーク(例:ラージチェスト30個=1620スロット)で
  // 重くなりすぎるため。スナップショットなので、このtick中に新しく届いた品目までは反映されないが、
  // 次のtickには自然に反映されるので実用上は問題ない。
  const storageIndex = buildStorageIndex(dimension, network);
  // Drain指定されたストレージは預け入れ先として選ばれない(倉庫レンチのDrainモード参照)。
  // これも品目ごとに問い合わせず、ネットワークにつき1tick1回だけ判定してリストにしておく。
  const depositTargets = network.storages.filter((loc) => !getDrain(dimension, loc));
  let anyInserted = false;

  while (budget > 0 && requests.length > 0) {
    const request = requests[0];
    const line = request.lines.find((l) => !l.exhausted && l.delivered < l.requested);

    if (!line) {
      finalizeDeposit(network.id, dimension, request);
      requests = requests.slice(1);
      setDeposits(network.id, requests);
      continue;
    }

    // network.terminals(登録データ)を正とする。理由はorderProcessing.tsの同様の箇所を参照。
    const stillRegistered = network.terminals.some((t) => locEquals(t, request.terminal));
    if (!stillRegistered) {
      finalizeDeposit(network.id, dimension, request);
      requests = requests.slice(1);
      setDeposits(network.id, requests);
      continue;
    }

    const terminalBlock = dimension.getBlock(request.terminal);
    if (!terminalBlock?.isValid || !isTerminalLikeBlock(terminalBlock.typeId)) {
      // 登録はあるが今はブロックを取得できない(チャンク未読み込み等)。次tickに再試行する。
      break;
    }

    // 預け入れ元はターミナルが張り付いている面(引き出しの搬入先と同じ場所)。毎回動的に見る。
    // 搬入出パッド: orderProcessing.tsの搬入先解決と対称に、張り付いた先の代わりにパッドの上に
    // 乗っているプレイヤー(request.playerName)のインベントリを預け入れ元にする。見つからなければ
    // (ログアウト・パッドから離れた等)sourceContainerはundefinedのままとなり、下のif文の
    // 「預け入れ元が無い」処理(shortfallとして確定)にそのまま乗る。
    const sourceContainer =
      terminalBlock.typeId === IO_PAD_BLOCK_ID
        ? world.getPlayers().find((p) => p.name === request.playerName)?.getComponent("inventory")?.container
        : dimension.getBlock(getAttachedStorageLocation(terminalBlock))?.getComponent("inventory")?.container;
    if (!sourceContainer) {
      finalizeDeposit(network.id, dimension, request);
      requests = requests.slice(1);
      setDeposits(network.id, requests);
      continue;
    }

    const attempt = Math.min(line.requested - line.delivered, budget);
    // 精密ターミナルからの依頼(line.slotIndexあり)は指定スロットのみから取り出す
    // (storageScan.tsのinsertSlotIntoStorages参照)。それ以外は従来通りコンテナ全体を対象にする。
    const inserted =
      line.slotIndex !== undefined
        ? insertSlotIntoStorages(
            dimension,
            network,
            { typeId: line.itemTypeId, name: line.itemName },
            attempt,
            sourceContainer,
            line.slotIndex,
            storageIndex,
            depositTargets
          )
        : insertIntoStorages(
            dimension,
            network,
            { typeId: line.itemTypeId, name: line.itemName },
            attempt,
            sourceContainer,
            storageIndex,
            depositTargets
          );
    line.delivered += inserted;
    budget -= inserted;
    if (inserted > 0) anyInserted = true;

    // inserted < attempt は「予算不足」ではなく「搬入元に無い/搬入先が満杯」を意味する
    // (attempt自体が budget で既に絞られているため)
    if (inserted < attempt) line.exhausted = true;

    setDeposits(network.id, requests); // ラインを1つ処理するたびに書き戻す

    if (budget <= 0) break;
  }

  return anyInserted;
}

function moveReadyDepositIssuingEntries(network: NetworkData): void {
  const issuing = getDepositIssuing(network.id);
  if (issuing.length === 0) return;

  const stillWaiting = issuing.filter((entry) => entry.readyAtTick > system.currentTick);
  const ready = issuing.filter((entry) => entry.readyAtTick <= system.currentTick);
  if (ready.length === 0) return;

  setDepositIssuing(network.id, stillWaiting);
  const requests = getDeposits(network.id);
  for (const entry of ready) requests.push(entry.request);
  setDeposits(network.id, requests);
}

function finalizeDeposit(networkId: string, dimension: Dimension, request: DepositRequest): void {
  const shortfall: PartialResultLine[] = request.lines
    .filter((l) => l.delivered < l.requested)
    .map((l) => ({ itemTypeId: l.itemTypeId, itemName: l.itemName, amount: l.requested - l.delivered }));

  if (shortfall.length > 0) {
    appendDepositPartial(networkId, { requestId: request.id, terminal: request.terminal, shortfall });
  }

  // 預け入れは元々どのターミナルも完了通知の仕組みが無いが、搬入出パッドはioPadProgress.tsの
  // 進捗表示に続けて完了もアクションバーに表示する(orderProcessing.tsのfinalizeOrderと対称、
  // ユーザー要望)。他のターミナルの挙動は変えないため、io_padだけに絞る。
  if (dimension.getBlock(request.terminal)?.typeId !== IO_PAD_BLOCK_ID) return;
  const player = world.getPlayers().find((p) => p.name === request.playerName);
  if (!player) return; // オフライン等。ログイン中の通知のみサポート(MVP、orderProcessing.tsと同じ方針)。
  player.onScreenDisplay.setActionBar(
    shortfall.length > 0 ? "§e搬入完了(一部搬入できませんでした)" : "§a搬入完了!"
  );
}
