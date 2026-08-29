import { Container, Dimension, ItemStack, Vector3 } from "@minecraft/server";
import { hasPendingSlotDepositFor, submitDeposit } from "./depositProcessing";
import { getNetworkCatalogCached } from "./networkCatalogCache";
import { startCycleAlignedLoop } from "./networkProcessing";
import { hasPendingSlotOrderFor, submitOrder } from "./orderProcessing";
import { NetworkData, PrecisionSlotLine } from "./state";
import { evenSplit } from "./storageScan";
import { getAttachedStorageLocation, isRedstoneLocked, PRECISION_TERMINAL_BLOCK_ID } from "./terminalBlock";
import { getPrecisionSlots } from "./terminalSettings";

// 自動発注・自動回収には送信元プレイヤーが存在しないため、空文字列にしておく
// (autoOrderCheck.tsのAUTO_ORDER_PLAYER_NAMEと同じ考え方)。
const AUTO_ORDER_PLAYER_NAME = "";

// networkProcessing.tsのstartCycleAlignedLoop参照: 以前は固定100tick(5秒)間隔だったが、
// コントローラの周期短縮キットのTierに応じたサイクル間隔に検知頻度も追従するようにした。
export function startPrecisionTerminalCheckLoop(): void {
  startCycleAlignedLoop(checkNetworkPrecisionTerminals);
}

function checkNetworkPrecisionTerminals(network: NetworkData, dimension: Dimension): void {
  for (const terminalLoc of network.terminals) {
    const block = dimension.getBlock(terminalLoc);
    if (!block?.isValid || block.typeId !== PRECISION_TERMINAL_BLOCK_ID) continue;
    if (isRedstoneLocked(block)) continue;

    const slots = getPrecisionSlots(dimension, terminalLoc);
    if (slots.length === 0) continue;

    const attachedLoc = getAttachedStorageLocation(block);
    const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
    if (!container) continue;

    for (const rule of slots) {
      checkSlotGroup(network, dimension, terminalLoc, container, rule);
    }
  }
}

// 1つのルール(スロット群)を処理する。1エントリが複数スロットを指定できる(ユーザー要望、
// スロット番号欄に「1,2,3」「1-3」等の書式で入力する。precisionTerminalUi.ts/slotRange.ts参照)。
// 1. 目標(targetAmount > 0)があり、各スロットの現在の中身が目標品目と一致(または空)なら、
//    それらのスロット(=補充してよいスロット)の合計不足分を1本のOrderLineとして注文する。
//    実際の搬入時にスロットへできるだけ均等に分配される(storageScan.tsのextractFromStoragesIntoSlots)。
// 2. collectがtrueなら、各スロットを独立に評価し、目標外の品目、またはそのスロットの
//    「あるべき量」(targetAmountをスロット数へ均等分配した値。evenSplit)を超えた余剰分を
//    そのままネットワークへ回収する(自動端末のcheckExcessと同じ発想)。目標なし(targetAmount=0)
//    のスロットでcollect: trueなら、中身は常に「全量が目標外」扱いになるため、事実上そのスロットを
//    丸ごと回収する動きになる。
// 品目が目標と一致しない場合は補充を行わず(上書きしない、安全側)、collectがtrueならその場で
// 全量回収する。回収でスロットが空になれば、次回のチェックで正しい品目の補充対象に加わる。
//
// 注意(既知の簡略化): 各スロットの「あるべき量」はグループ全体の目標を単純に均等分配した値
// (evenSplit)であり、スロットごとの実際の現在量の偏りまでは考慮しない。例えばスロット1だけ
// 既に多めに入っている状態で目標を再設定した場合、補充(不足しているスロット向け)と回収
// (スロット1の超過分)が同じチェック周期で同時に走ることがある。数サイクルのうちに均される
// ため実用上は問題ないと判断しているが、常に完全に安定した状態を保つわけではない。
function checkSlotGroup(
  network: NetworkData,
  dimension: Dimension,
  terminalLoc: Vector3,
  container: Container,
  rule: PrecisionSlotLine
): void {
  const hasTarget = rule.targetAmount > 0 && rule.itemTypeId !== undefined;

  const slotItems = rule.slotIndices.map((slotIndex) => ({ slotIndex, item: container.getItem(slotIndex) }));
  const matchesTarget = (item: ItemStack | undefined) =>
    hasTarget && item !== undefined && item.typeId === rule.itemTypeId && (item.nameTag ?? "") === (rule.itemName ?? "");

  if (hasTarget) {
    // 補充してよいスロット(空、または既に目標品目が入っている)だけを対象にする(単一スロット
    // 時代と同じ「矛盾する品目は上書きしない」安全側の判断)。
    const eligible = slotItems.filter(({ item }) => item === undefined || matchesTarget(item));
    if (eligible.length > 0) {
      const currentSum = eligible.reduce((sum, { item }) => sum + (item?.amount ?? 0), 0);
      const shortfall = rule.targetAmount - currentSum;
      const eligibleIndices = eligible.map((e) => e.slotIndex);

      if (shortfall > 0 && !hasPendingSlotOrderFor(network.id, terminalLoc, eligibleIndices)) {
        // ネットワークに実際に無い(または明らかに足りない)品目は注文しない(autoOrderCheck.ts
        // のcheckShortfallsと同じ理由・同じ手法。ユーザー要望)。
        const networkCatalog = getNetworkCatalogCached(dimension, network);
        const availableInNetwork =
          networkCatalog.find(
            (e) => e.key.typeId === rule.itemTypeId && (e.key.name ?? "") === (rule.itemName ?? "")
          )?.total ?? 0;
        const requestAmount = Math.min(shortfall, availableInNetwork);
        if (requestAmount > 0) {
          submitOrder(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, [
            {
              itemTypeId: rule.itemTypeId as string,
              itemName: rule.itemName,
              requested: requestAmount,
              delivered: 0,
              exhausted: false,
              slotIndices: eligibleIndices,
            },
          ]);
        }
      }
    }
  }

  if (rule.collect) {
    // 回収は物理スロット単位でしか行えない(insertSlotIntoStoragesが1スロット分の中身しか
    // 扱えないため)。各スロットの「あるべき量」は目標をスロット数へ均等分配した値とみなす。
    const perSlotTarget = evenSplit(hasTarget ? rule.targetAmount : 0, rule.slotIndices.length);
    slotItems.forEach(({ slotIndex, item }, i) => {
      if (item === undefined) return;
      const surplus = matchesTarget(item) ? item.amount - perSlotTarget[i] : item.amount;
      if (surplus > 0 && !hasPendingSlotDepositFor(network.id, terminalLoc, slotIndex)) {
        submitDeposit(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, [
          {
            itemTypeId: item.typeId,
            itemName: item.nameTag,
            requested: surplus,
            delivered: 0,
            exhausted: false,
            slotIndex,
          },
        ]);
      }
    });
  }
}
