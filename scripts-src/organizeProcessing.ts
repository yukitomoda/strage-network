import { Dimension, Vector3, world } from "@minecraft/server";
import { DisplayKey, stackMatchesKey } from "./itemIdentity";
import { getOrganizeQueue, setOrganizeQueue } from "./network";
import { generateId, NetworkData, OrganizeRequest } from "./state";
import { getDrain } from "./storageSettings";
import { insertIntoStorages } from "./storageScan";

// 倉庫の整理(注文/納入と同じくコントローラのタスク定期実行の仕組みに乗せる)。
// MVP: 十分大きい固定値(=実質即時処理)。将来はコントローラのグレードに応じて可変にする。
// docs/design.md 4章「スループット制」参照。
const ORGANIZE_THROUGHPUT_PER_TICK = 1_000_000;

// ネットワークにつき同時に1件まで。整理中に再度ボタンを押しても、既存のリクエストが
// 終わるまでは何も起きない(整理はスナップショット時点の品目を対象にするだけの
// ワンショットの処理で、キューに複数積んでも得るものが無いため)。
export function submitOrganize(
  networkId: string,
  lines: { itemTypeId: string; itemName?: string }[]
): boolean {
  if (lines.length === 0) return false;
  if (getOrganizeQueue(networkId).length > 0) return false;

  const request: OrganizeRequest = {
    id: generateId(),
    lines: lines.map((l) => ({ itemTypeId: l.itemTypeId, itemName: l.itemName, done: false })),
  };
  setOrganizeQueue(networkId, [request]);
  return true;
}

export function processNetworkOrganize(network: NetworkData): void {
  let queue = getOrganizeQueue(network.id);
  if (queue.length === 0) return;

  const dimension = world.getDimension(network.dimensionId);
  const request = queue[0];
  let budget = ORGANIZE_THROUGHPUT_PER_TICK;

  // Drain指定の有無は、このtickのこのネットワーク分だけ1回判定して使い回す
  // (depositProcessing.tsのdepositTargetsと同じ理由。品目ごとに問い合わせない)。
  const drainLocs = network.storages.filter((loc) => getDrain(dimension, loc));
  const regularLocs = network.storages.filter((loc) => !getDrain(dimension, loc));

  while (budget > 0) {
    const line = request.lines.find((l) => !l.done);
    if (!line) {
      queue = queue.slice(1);
      setOrganizeQueue(network.id, queue);
      return;
    }

    const { moved, complete } = compactKeyInStorages(
      dimension,
      network,
      { typeId: line.itemTypeId, name: line.itemName },
      budget,
      drainLocs,
      regularLocs
    );
    budget -= moved;
    if (complete) line.done = true;
    setOrganizeQueue(network.id, queue); // ラインを1つ処理するたびに書き戻す

    if (!complete) break; // 予算切れ。次tickに同じラインから再開する(再スキャンするので続きから進む)
  }
}

type SlotRef = { loc: Vector3; slot: number };

function containerAt(dimension: Dimension, loc: Vector3) {
  return dimension.getBlock(loc)?.getComponent("inventory")?.container;
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
): { moved: number; complete: boolean } {
  let moved = 0;
  let remaining = budget;

  // フェーズ1: Drain指定ストレージの退避。
  for (const drainLoc of drainLocs) {
    if (remaining <= 0) return { moved, complete: false };
    const drainContainer = containerAt(dimension, drainLoc);
    if (!drainContainer) continue;

    const evacuated = insertIntoStorages(dimension, network, key, remaining, drainContainer, undefined, regularLocs);
    moved += evacuated;
    remaining -= evacuated;
  }

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

    if (remaining <= 0) return { moved, complete: false };

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

  return { moved, complete: true };
}
