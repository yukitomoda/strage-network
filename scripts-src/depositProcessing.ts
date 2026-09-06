import { system, Vector3, world } from "@minecraft/server";
import {
  appendDepositPartial,
  getDepositCancels,
  getDepositIssuing,
  getDeposits,
  setDepositCancels,
  setDepositIssuing,
  setDeposits,
} from "./network";
import { buildStorageIndex, insertIntoStorages } from "./storageScan";
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
import { reconcileAllTargetDeposits } from "./targetReconciliation";
import { getAttachedStorageLocation, isTerminalLikeBlock } from "./terminalBlock";
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
// remote: リモート配達ターミナル(アイテム)由来の預け入れの場合だけ渡す(state.tsのDepositRequest.remote参照)。
export function submitDeposit(
  networkId: string,
  terminalLoc: Vector3,
  playerName: string,
  lines: DepositLine[],
  remote?: DepositRequest["remote"]
): string {
  const request: DepositRequest = {
    id: generateId(),
    displayId: generateDepositId(),
    playerName,
    terminal: terminalLoc,
    lines,
    remote,
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
  let anyInserted = false;

  // 「どのストレージに何が既にあるか」の索引・Drain指定を除いた搬入先リストは、このtickの
  // このネットワーク分だけ1回作って使い回す(大規模ネットワークでのコスト対策)。固定量の
  // 「預け入れ」FIFOが無い(requests.length===0)場合は、ここでは作らずtargetReconciliation.ts側で
  // 遅延構築させる(25章。実際に何か搬入する可能性がある時だけコストを払うため)。
  let storageIndex;
  let depositTargets;
  if (requests.length > 0) {
    storageIndex = buildStorageIndex(dimension, network);
    depositTargets = network.storages.filter((loc) => !getDrain(dimension, loc));

    while (budget > 0 && requests.length > 0) {
      const request = requests[0];
      const line = request.lines.find((l) => !l.exhausted && l.delivered < l.requested);

      if (!line) {
        finalizeDeposit(network.id, request);
        requests = requests.slice(1);
        setDeposits(network.id, requests);
        continue;
      }

      let sourceContainer;

      if (request.remote) {
        // リモート配達ターミナル(アイテム)由来: orderProcessing.tsのorder.remoteと同じ考え方で、
        // 実在するブロックを一切参照しない。預け入れたプレイヤーがオンラインならインベントリから
        // 優先的に取り出す。オフラインなら張り付いた先のような代替の搬入元が無いため
        // sourceContainerはundefinedのままにし、下の「搬入元が無い」フォールバックへ合流させる
        // (ネットワーク在庫は一切増えないため消失リスクは無い)。
        const depositingPlayer = world.getPlayers().find((p) => p.name === request.playerName);
        sourceContainer = depositingPlayer?.getComponent("inventory")?.container;
      } else {
        // network.terminals(登録データ)を正とする。理由はorderProcessing.tsの同様の箇所を参照。
        const stillRegistered = network.terminals.some((t) => locEquals(t, request.terminal));
        if (!stillRegistered) {
          finalizeDeposit(network.id, request);
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
        // (搬入出パッドは25章の広告モデルへ移行済みでFIFOキュー(=ここ)に乗ることは無い。
        // 張り付いた先という概念が無いパッド専用の分岐は不要になったため削除した。)
        sourceContainer = dimension
          .getBlock(getAttachedStorageLocation(terminalBlock))
          ?.getComponent("inventory")?.container;
      }

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
  }

  // 目標系(自動端末/在庫管理ターミナル/精密ターミナル/搬入出パッド)は、固定量の「預け入れ」
  // FIFOを消化した残り予算で直接処理する(広告モデル、25章)。
  if (budget > 0) {
    const inserted = reconcileAllTargetDeposits(network, dimension, budget, storageIndex, depositTargets);
    if (inserted > 0) anyInserted = true;
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

// 預け入れは元々どのターミナルも完了通知の仕組みが無い(引き出しのfinalizeOrderと非対称)。
// 搬入出パッドは25章の広告モデルへ移行済みでこの関数を経由しないため、以前ここにあった
// io_pad専用のアクションバー通知はioPadProgress.ts側のライブ比較表示に統合した。
function finalizeDeposit(networkId: string, request: DepositRequest): void {
  const shortfall: PartialResultLine[] = request.lines
    .filter((l) => l.delivered < l.requested)
    .map((l) => ({ itemTypeId: l.itemTypeId, itemName: l.itemName, amount: l.requested - l.delivered }));

  if (shortfall.length > 0) {
    appendDepositPartial(networkId, { requestId: request.id, terminal: request.terminal, shortfall });
  }
}
