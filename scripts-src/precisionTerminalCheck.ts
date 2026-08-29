import { Block, Container, Dimension, ItemStack, Vector3 } from "@minecraft/server";
import { evenSplit, extractFromStoragesIntoSlots, insertSlotIntoStorages, StorageIndex } from "./storageScan";
import { getAttachedStorageLocation } from "./terminalBlock";
import { getPrecisionSlots } from "./terminalSettings";
import { NetworkData, PrecisionSlotLine } from "./state";

// 目標系ターミナルの「広告モデル」(25章)。1つのルールが複数スロットを指定できる
// (24章、スロット番号欄に「1,2,3」「1-3」等の書式で入力する)。
// 1. 目標(targetAmount > 0)があり、各スロットの現在の中身が目標品目と一致(または空)なら、
//    それらのスロット(=補充してよいスロット)の合計不足分をextractFromStoragesIntoSlotsで
//    できるだけ均等に分配して補充する。
// 2. collectがtrueなら、各スロットを独立に評価し、目標外の品目、またはそのスロットの
//    「あるべき量」(targetAmountをスロット数へ均等分配した値。evenSplit)を超えた余剰分を
//    そのままネットワークへ回収する。目標なし(targetAmount=0)のスロットでcollect: trueなら、
//    中身は常に「全量が目標外」扱いになるため、事実上そのスロットを丸ごと回収する動きになる。
// 品目が目標と一致しない場合は補充を行わず(上書きしない、安全側)、collectがtrueならその場で
// 全量回収する。回収でスロットが空になれば、次回の処理で正しい品目の補充対象に加わる。
//
// 注意(既知の簡略化): 各スロットの「あるべき量」はグループ全体の目標を単純に均等分配した値
// (evenSplit)であり、スロットごとの実際の現在量の偏りまでは考慮しない(24章参照)。

export function reconcilePrecisionTerminalWithdrawal(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number
): number {
  if (budget <= 0) return 0;
  const slots = getPrecisionSlots(dimension, block.location);
  if (slots.length === 0) return 0;

  const attachedLoc = getAttachedStorageLocation(block);
  const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
  if (!container) return 0;

  let remaining = budget;
  let consumed = 0;
  for (const rule of slots) {
    if (remaining <= 0) break;
    const delivered = reconcileSlotGroupWithdrawal(network, dimension, container, rule, remaining);
    remaining -= delivered;
    consumed += delivered;
  }
  return consumed;
}

function reconcileSlotGroupWithdrawal(
  network: NetworkData,
  dimension: Dimension,
  container: Container,
  rule: PrecisionSlotLine,
  budget: number
): number {
  const hasTarget = rule.targetAmount > 0 && rule.itemTypeId !== undefined;
  if (!hasTarget) return 0;

  const matchesTarget = (item: ItemStack | undefined) =>
    item !== undefined && item.typeId === rule.itemTypeId && (item.nameTag ?? "") === (rule.itemName ?? "");

  // 各スロットの「あるべき量」上限は、回収側(reconcileSlotGroupDeposit)と同じ計算式
  // (グループ全体のスロット数で均等分配)を使う。矛盾する品目が入っている対象外のスロット分の
  // 割り当ては、そのスロットが空になる(回収される)までは埋まらない。
  const cap = evenSplit(rule.targetAmount, rule.slotIndices.length);

  // 補充してよいスロット(空、または既に目標品目が入っている)だけを対象にする(単一スロット
  // 時代と同じ「矛盾する品目は上書きしない」安全側の判断)。
  const eligibleIndices: number[] = [];
  const eligibleCap: number[] = [];
  rule.slotIndices.forEach((slotIndex, i) => {
    const item = container.getItem(slotIndex);
    if (item !== undefined && !matchesTarget(item)) return;
    eligibleIndices.push(slotIndex);
    eligibleCap.push(cap[i]);
  });
  if (eligibleIndices.length === 0) return 0;

  return extractFromStoragesIntoSlots(
    dimension,
    network,
    { typeId: rule.itemTypeId as string, name: rule.itemName },
    eligibleCap,
    budget,
    container,
    eligibleIndices
  );
}

export function reconcilePrecisionTerminalDeposit(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number,
  storageIndex?: StorageIndex,
  depositTargets?: Vector3[]
): number {
  if (budget <= 0) return 0;
  const slots = getPrecisionSlots(dimension, block.location);
  if (slots.length === 0) return 0;

  const attachedLoc = getAttachedStorageLocation(block);
  const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
  if (!container) return 0;

  let remaining = budget;
  let consumed = 0;
  for (const rule of slots) {
    if (!rule.collect) continue;
    if (remaining <= 0) break;
    const delivered = reconcileSlotGroupDeposit(network, dimension, container, rule, remaining, storageIndex, depositTargets);
    remaining -= delivered;
    consumed += delivered;
  }
  return consumed;
}

function reconcileSlotGroupDeposit(
  network: NetworkData,
  dimension: Dimension,
  container: Container,
  rule: PrecisionSlotLine,
  budget: number,
  storageIndex: StorageIndex | undefined,
  depositTargets: Vector3[] | undefined
): number {
  const hasTarget = rule.targetAmount > 0 && rule.itemTypeId !== undefined;
  // 回収は物理スロット単位でしか行えない(insertSlotIntoStoragesが1スロット分の中身しか
  // 扱えないため)。各スロットの「あるべき量」は目標をスロット数へ均等分配した値とみなす。
  const perSlotTarget = evenSplit(hasTarget ? rule.targetAmount : 0, rule.slotIndices.length);
  const matchesTarget = (item: ItemStack | undefined) =>
    hasTarget && item !== undefined && item.typeId === rule.itemTypeId && (item.nameTag ?? "") === (rule.itemName ?? "");

  let remaining = budget;
  let consumed = 0;
  for (let i = 0; i < rule.slotIndices.length; i++) {
    if (remaining <= 0) break;
    const slotIndex = rule.slotIndices[i];
    const item = container.getItem(slotIndex);
    if (item === undefined) continue;
    const surplus = matchesTarget(item) ? item.amount - perSlotTarget[i] : item.amount;
    if (surplus <= 0) continue;

    const attempt = Math.min(surplus, remaining);
    const inserted = insertSlotIntoStorages(
      dimension,
      network,
      { typeId: item.typeId, name: item.nameTag },
      attempt,
      container,
      slotIndex,
      storageIndex,
      depositTargets
    );
    remaining -= inserted;
    consumed += inserted;
  }
  return consumed;
}
