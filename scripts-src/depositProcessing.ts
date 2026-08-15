import { system, Vector3, world } from "@minecraft/server";
import {
  appendDepositPartial,
  getDepositIssuing,
  getDeposits,
  setDepositIssuing,
  setDeposits,
} from "./network";
import { buildStorageIndex, insertIntoStorages } from "./storageScan";
import { DepositLine, DepositRequest, generateId, locEquals, NetworkData, PartialResultLine } from "./state";
import { getAttachedStorageLocation } from "./terminalBlock";

// 注文(orderProcessing.ts)と対称だが、方向が逆(ターミナルの張り付いた先 -> ネットワーク内の
// ストレージ群)で、スループット・発行遅延は個別に設定できるようにしている。
// MVPでは両方とも十分大きい固定値/0で、実質即時処理になる。docs/design.md 4章参照。
const DEPOSIT_THROUGHPUT_PER_TICK = 1_000_000;
const DEPOSIT_ISSUE_DELAY_TICKS = 0;

export function submitDeposit(networkId: string, terminalLoc: Vector3, lines: DepositLine[]): void {
  const request: DepositRequest = { id: generateId(), terminal: terminalLoc, lines };
  const entries = getDepositIssuing(networkId);
  entries.push({ request, readyAtTick: system.currentTick + DEPOSIT_ISSUE_DELAY_TICKS });
  setDepositIssuing(networkId, entries);
}

export function processNetworkDeposits(network: NetworkData): void {
  const dimension = world.getDimension(network.dimensionId);

  moveReadyDepositIssuingEntries(network);

  let budget = DEPOSIT_THROUGHPUT_PER_TICK;
  let requests = getDeposits(network.id);
  if (requests.length === 0) return;

  // 「どのストレージに何が既にあるか」の索引は、このtickのこのネットワーク分だけ1回作って使い回す。
  // 品目ごとに全ストレージを舐め直すと、大規模なネットワーク(例:ラージチェスト30個=1620スロット)で
  // 重くなりすぎるため。スナップショットなので、このtick中に新しく届いた品目までは反映されないが、
  // 次のtickには自然に反映されるので実用上は問題ない。
  const storageIndex = buildStorageIndex(dimension, network);

  while (budget > 0 && requests.length > 0) {
    const request = requests[0];
    const line = request.lines.find((l) => !l.exhausted && l.delivered < l.requested);

    if (!line) {
      finalizeDeposit(network.id, request);
      requests = requests.slice(1);
      setDeposits(network.id, requests);
      continue;
    }

    // network.terminals(登録データ)を正とする。理由はorderProcessing.tsの同様の箇所を参照。
    const stillRegistered = network.terminals.some((t) => locEquals(t, request.terminal));
    if (!stillRegistered) {
      finalizeDeposit(network.id, request);
      requests = requests.slice(1);
      setDeposits(network.id, requests);
      continue;
    }

    const terminalBlock = dimension.getBlock(request.terminal);
    if (!terminalBlock?.isValid || terminalBlock.typeId !== "wh:terminal") {
      // 登録はあるが今はブロックを取得できない(チャンク未読み込み等)。次tickに再試行する。
      break;
    }

    // 納入元はターミナルが張り付いている面(注文の搬入先と同じ場所)。毎回動的に見る。
    const attachedLoc = getAttachedStorageLocation(terminalBlock);
    const sourceContainer = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
    if (!sourceContainer) {
      finalizeDeposit(network.id, request);
      requests = requests.slice(1);
      setDeposits(network.id, requests);
      continue;
    }

    const attempt = Math.min(line.requested - line.delivered, budget);
    const inserted = insertIntoStorages(
      dimension,
      network,
      { typeId: line.itemTypeId, name: line.itemName },
      attempt,
      sourceContainer,
      storageIndex
    );
    line.delivered += inserted;
    budget -= inserted;

    // inserted < attempt は「予算不足」ではなく「搬入元に無い/搬入先が満杯」を意味する
    // (attempt自体が budget で既に絞られているため)
    if (inserted < attempt) line.exhausted = true;

    setDeposits(network.id, requests); // ラインを1つ処理するたびに書き戻す

    if (budget <= 0) break;
  }
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

function finalizeDeposit(networkId: string, request: DepositRequest): void {
  const shortfall: PartialResultLine[] = request.lines
    .filter((l) => l.delivered < l.requested)
    .map((l) => ({ itemTypeId: l.itemTypeId, itemName: l.itemName, amount: l.requested - l.delivered }));

  if (shortfall.length > 0) {
    appendDepositPartial(networkId, { requestId: request.id, terminal: request.terminal, shortfall });
  }
}
