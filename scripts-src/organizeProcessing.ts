import { Dimension, Vector3, world } from "@minecraft/server";
import { getNotifyOnOrganizeComplete } from "./controllerSettings";
import { DisplayKey, stackMatchesKey } from "./itemIdentity";
import { getOrganizeCancels, getOrganizeQueue, setOrganizeCancels, setOrganizeQueue } from "./network";
import { generateId, generateOrganizeId, NetworkData, OrganizeLine, OrganizeRequest } from "./state";
import { getDrain } from "./storageSettings";
import { insertIntoStorages } from "./storageScan";

// 倉庫の整理(引き出し/預け入れと同じくコントローラのタスク定期実行の仕組みに乗せる)。
// MVP: 十分大きい固定値(=実質即時処理)。将来はコントローラのグレードに応じて可変にする。
// docs/design.md 4章「スループット制」参照。
const ORGANIZE_THROUGHPUT_PER_TICK = 100;

// ネットワークにつき同時に1件まで。整理中に再度ボタンを押しても、既存のリクエストが
// 終わるまでは何も起きない(整理はスナップショット時点の品目を対象にするだけの
// ワンショットの処理で、キューに複数積んでも得るものが無いため)。
// 戻り値のdisplayIdはプレイヤーへの表示用(submitOrder/submitDepositと同じ役割)。
// 既に整理中で新規キューイングを弾いた場合はundefinedを返す。
export function submitOrganize(
  networkId: string,
  playerName: string,
  lines: { itemTypeId: string; itemName?: string }[]
): string | undefined {
  if (lines.length === 0) return undefined;
  if (getOrganizeQueue(networkId).length > 0) return undefined;

  const request: OrganizeRequest = {
    id: generateId(),
    displayId: generateOrganizeId(),
    playerName,
    lines: lines.map((l) => ({ itemTypeId: l.itemTypeId, itemName: l.itemName, done: false })),
  };
  setOrganizeQueue(networkId, [request]);
  return request.displayId;
}

// コントローラの「状況」タブ(controllerUi.ts)向け: orderProcessing.tsのlistActiveOrdersと
// 同じ考え方。整理は同時に1件までなので、実質0件か1件の配列になる。
export function listActiveOrganize(networkId: string): OrganizeRequest[] {
  return getOrganizeQueue(networkId);
}

// orderProcessing.tsのcancelOrderと同じ発想の専用キャンセルキュー。
export function cancelOrganize(networkId: string, requestId: string): void {
  const cancels = getOrganizeCancels(networkId);
  cancels.push(requestId);
  setOrganizeCancels(networkId, cancels);
}

// orderProcessing.tsのprocessOrderCancelsと同じ発想。整理には発行待ち(issuing)相当の
// ステージング queue が無く`wh:organize`一本なので、そこだけ除去すればよい。
function processOrganizeCancels(networkId: string): void {
  const cancelIds = getOrganizeCancels(networkId);
  if (cancelIds.length === 0) return;
  const cancelSet = new Set(cancelIds);

  const queue = getOrganizeQueue(networkId).filter((request) => !cancelSet.has(request.id));
  setOrganizeQueue(networkId, queue);

  setOrganizeCancels(networkId, []); // 消費済み
}

export function processNetworkOrganize(network: NetworkData): void {
  processOrganizeCancels(network.id);

  let queue = getOrganizeQueue(network.id);
  if (queue.length === 0) return;

  const dimension = world.getDimension(network.dimensionId);
  const request = queue[0];
  let budget = ORGANIZE_THROUGHPUT_PER_TICK;

  // Drain指定の有無は、このtickのこのネットワーク分だけ1回判定して使い回す
  // (depositProcessing.tsのdepositTargetsと同じ理由。品目ごとに問い合わせない)。
  const drainLocs = network.storages.filter((loc) => getDrain(dimension, loc));
  const regularLocs = network.storages.filter((loc) => !getDrain(dimension, loc));

  // 退避先に空きが無く、今回は1個も退避できなかったライン。「予算切れ」と違い、今すぐ
  // 同じラインを再試行しても状況は変わらない可能性が高いため、tick内では後回しにして
  // 他のラインに進む(このSetはtickごとに作り直すので、次tickでは必ず再挑戦する)。
  const stuckThisTick = new Set<OrganizeLine>();
  // このtickのこの1周(スイープ)で実際に動かせた総数。「行き詰まったラインしか残って
  // いない状態」に達した時点でこれが0なら、他のラインの整理でも状況は一切変わらなかった
  // ということなので、本当にもう手段が尽きたと判断できる(詳細は下のコメント参照)。
  let movedThisSweep = 0;

  while (budget > 0) {
    const line = request.lines.find((l) => !l.done && !stuckThisTick.has(l));
    if (!line) {
      // 残っている未完了ラインは全て行き詰まっている(このtickで一通り試した)。
      // 1個も動かせなかった(=退避先のどの品目の空きも今回の行き詰まりの解消には
      // 使えなかった)なら、これ以上粘っても無駄なので諦めて完了扱いにする。1個でも
      // 動いていれば、その変化(空きスロットの発生)が他の行き詰まりを解消する
      // 可能性が残っているので、次tickにもう一度チャンスを与える。
      // (「ストレージ全体に何らかの空きがあるか」という粗い判定だと、その空きが
      // 実際には行き詰まっている品目と噛み合わない端数スタックの場合に誤って
      // 「まだ望みがある」と判定してしまい、同じ無限リトライ不具合が再発するため、
      // 「実際に動かせたか」という直接的な進捗の有無で判定している。)
      if (movedThisSweep === 0) {
        for (const stuck of stuckThisTick) stuck.done = true;
        setOrganizeQueue(network.id, queue);
      }
      break;
    }

    const { moved, complete, budgetExhausted } = compactKeyInStorages(
      dimension,
      network,
      { typeId: line.itemTypeId, name: line.itemName },
      budget,
      drainLocs,
      regularLocs
    );
    budget -= moved;
    movedThisSweep += moved;
    if (complete) {
      line.done = true;
    } else if (!budgetExhausted) {
      // 退避先が満杯で進めなかった。このtickでは諦めず、他のラインを先に処理させる
      // (実機で発見された不具合の修正: 以前はここで即座にdone扱いにしてしまい、後続の
      // ラインの整理で退避先に空きが生まれても、既に諦めたアイテムが二度と退避されなかった)。
      stuckThisTick.add(line);
    }
    setOrganizeQueue(network.id, queue); // ラインを1つ処理するたびに書き戻す

    if (budgetExhausted) break; // 予算切れ。次tickに同じラインから再開する(再スキャンするので続きから進む)
  }

  if (request.lines.every((l) => l.done)) {
    queue = queue.slice(1);
    setOrganizeQueue(network.id, queue);
    notifyOrganizeComplete(dimension, network, request, drainLocs);
  }
}

// 完了通知(設定タブの「整理完了時に通知する」がONの場合のみ)。「本当に全品目を退避しきれた
// か、それとも(空き不足で)一部を諦めたか」は専用のフラグを持たせず、完了時点で改めて
// Drain指定ストレージの中にリクエスト対象の品目が残っているかを調べることで判定する
// (諦めたラインだけが検知漏れなくここに反映される。orderProcessing.tsのfinalizeOrderの
// shortfallと同じ考え方)。
function notifyOrganizeComplete(
  dimension: Dimension,
  network: NetworkData,
  request: OrganizeRequest,
  drainLocs: Vector3[]
): void {
  if (!getNotifyOnOrganizeComplete(dimension, network.controller)) return;

  const player = world.getPlayers().find((p) => p.name === request.playerName);
  if (!player) return; // オフライン等。ログイン中の通知のみサポート(MVP)

  const leftover = request.lines.some((l) =>
    anyMatchingItem(dimension, drainLocs, { typeId: l.itemTypeId, name: l.itemName })
  );

  player.sendMessage(
    leftover
      ? `§e倉庫の整理 #${request.displayId} が完了しました(退避先の空き不足で一部の品目は整理できませんでした)。`
      : `§b倉庫の整理 #${request.displayId} が完了しました。`
  );
}

type SlotRef = { loc: Vector3; slot: number };

function containerAt(dimension: Dimension, loc: Vector3) {
  return dimension.getBlock(loc)?.getComponent("inventory")?.container;
}

// 退避しきれず、まだ指定キーのアイテムがどこかのストレージに残っているか。
function anyMatchingItem(dimension: Dimension, locs: Vector3[], key: DisplayKey): boolean {
  for (const loc of locs) {
    const container = containerAt(dimension, loc);
    if (!container) continue;
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (item && stackMatchesKey(item, key)) return true;
    }
  }
  return false;
}

// 指定キーのスタックをネットワーク内のストレージ群にわたって寄せ集め、部分スタックを減らす。
// 2段階で処理する:
//   1. Drain指定ストレージの中身を、非Drainストレージへ可能な限り退避する(空きが無ければ残る)。
//   2. 非Drainストレージ同士で、部分スタックを寄せて空きスロットを増やす(Drain側は対象外、
//      新たにDrain側へ何かが入ることは無い)。
// 実際に積み重ね可能か(耐久値・エンチャント等の一致)は ItemStack.isStackableWith で判定するため、
// 見た目のdisplayKeyが同じでも実際には積めない組(例: 耐久が違う剣同士)は無理にマージしない。
// 呼び出しのたびに現在のコンテナの状態を再スキャンして進めるだけなので、予算切れで中断しても
// 次回呼び出しは自然に続きから再開できる(専用の再開カーソルは持たない)。
function compactKeyInStorages(
  dimension: Dimension,
  network: NetworkData,
  key: DisplayKey,
  budget: number,
  drainLocs: Vector3[],
  regularLocs: Vector3[]
): { moved: number; complete: boolean; budgetExhausted: boolean } {
  let moved = 0;
  let remaining = budget;

  // フェーズ1: Drain指定ストレージの退避。
  for (const drainLoc of drainLocs) {
    if (remaining <= 0) return { moved, complete: false, budgetExhausted: true };
    const drainContainer = containerAt(dimension, drainLoc);
    if (!drainContainer) continue;

    const evacuated = insertIntoStorages(dimension, network, key, remaining, drainContainer, undefined, regularLocs);
    moved += evacuated;
    remaining -= evacuated;
  }

  // 退避先(非Drainストレージ)が満杯で、まだDrain側にこのキーが残っているか。
  // 予算切れとは違い、今すぐ再試行しても状況は変わらない(呼び出し元でtick内は
  // 後回しにしてもらう)。
  const stillInDrain = anyMatchingItem(dimension, drainLocs, key);

  // フェーズ2: 非Drainストレージ同士の圧縮。
  const slots: SlotRef[] = [];
  for (const loc of regularLocs) {
    const container = containerAt(dimension, loc);
    if (!container) continue;
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (item && stackMatchesKey(item, key)) slots.push({ loc, slot: i });
    }
  }

  let dst = 0;
  let src = slots.length - 1;

  while (dst < src) {
    const dstContainer = containerAt(dimension, slots[dst].loc);
    const dstItem = dstContainer?.getItem(slots[dst].slot);
    if (!dstContainer || !dstItem || dstItem.amount >= dstItem.maxAmount) {
      dst++;
      continue;
    }

    const srcContainer = containerAt(dimension, slots[src].loc);
    const srcItem = srcContainer?.getItem(slots[src].slot);
    if (!srcContainer || !srcItem || srcItem.amount <= 0) {
      src--;
      continue;
    }

    if (!dstItem.isStackableWith(srcItem)) {
      // 耐久値等の違いで実際には積めない組。srcは維持したまま、dstだけ進めて
      // 別の組み合わせを試す(このsrcが他のdstとなら積める可能性があるため)。
      dst++;
      continue;
    }

    if (remaining <= 0) return { moved, complete: false, budgetExhausted: true };

    const take = Math.min(dstItem.maxAmount - dstItem.amount, srcItem.amount, remaining);
    dstItem.amount += take;
    dstContainer.setItem(slots[dst].slot, dstItem);

    if (take >= srcItem.amount) {
      srcContainer.setItem(slots[src].slot, undefined);
      src--;
    } else {
      srcItem.amount -= take;
      srcContainer.setItem(slots[src].slot, srcItem);
    }

    moved += take;
    remaining -= take;
  }

  return { moved, complete: !stillInDrain, budgetExhausted: false };
}
