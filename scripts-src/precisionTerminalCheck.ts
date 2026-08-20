import { Container, system, Vector3, world } from "@minecraft/server";
import { hasPendingSlotDepositFor, submitDeposit } from "./depositProcessing";
import { getAllNetworks } from "./network";
import { hasPendingSlotOrderFor, submitOrder } from "./orderProcessing";
import { NetworkData, PrecisionSlotLine } from "./state";
import { getAttachedStorageLocation, PRECISION_TERMINAL_BLOCK_ID } from "./terminalBlock";
import { getPrecisionSlots } from "./terminalSettings";

// autoOrderCheck.tsのAUTO_CHECK_INTERVAL_TICKSと同じ間隔(5秒)。MVP: 固定値。
const CHECK_INTERVAL_TICKS = 100;

// 自動発注・自動回収には送信元プレイヤーが存在しないため、空文字列にしておく
// (autoOrderCheck.tsのAUTO_ORDER_PLAYER_NAMEと同じ考え方)。
const AUTO_ORDER_PLAYER_NAME = "";

export function startPrecisionTerminalCheckLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      checkNetworkPrecisionTerminals(network);
    }
  }, CHECK_INTERVAL_TICKS);
}

function checkNetworkPrecisionTerminals(network: NetworkData): void {
  const dimension = world.getDimension(network.dimensionId);

  for (const terminalLoc of network.terminals) {
    const block = dimension.getBlock(terminalLoc);
    if (!block?.isValid || block.typeId !== PRECISION_TERMINAL_BLOCK_ID) continue;

    const slots = getPrecisionSlots(dimension, terminalLoc);
    if (slots.length === 0) continue;

    const attachedLoc = getAttachedStorageLocation(block);
    const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
    if (!container) continue;

    for (const rule of slots) {
      checkSlot(network, terminalLoc, container, rule);
    }
  }
}

// スロットごとのルールを1つ処理する。
// 1. 目標(targetAmount > 0)があり、現在の中身が目標品目と一致(または空)なら不足分を補充する
//    (自動端末のcheckShortfallsと同じ発想)。
// 2. collectがtrueなら、目標外の品目、または目標を超えた余剰分をそのままネットワークへ回収する
//    (自動端末のcheckExcessと同じ発想)。目標なし(targetAmount=0)のスロットでcollect: trueなら、
//    中身は常に「全量が目標外」扱いになるため、事実上そのスロットを丸ごと回収する動きになる。
// この2つは同じtick内で同時に評価されるが、シャドウする(=同じスロットに対し両方が同時に
// 実行条件を満たす)ことは無い: 補充が起こるのは「中身が目標と一致 かつ 不足」の時だけで、
// その場合は余剰が発生しない(余剰 = 現在数 - 目標 <= 0)ため回収も発生しない。
// 品目が目標と一致しない場合は補充を行わず(上書きしない、安全側)、collectがtrueなら
// その場で全量回収する。回収でスロットが空になれば、次回のチェックで正しい品目の補充が始まる。
function checkSlot(network: NetworkData, terminalLoc: Vector3, container: Container, rule: PrecisionSlotLine): void {
  const current = container.getItem(rule.slotIndex);
  const hasTarget = rule.targetAmount > 0 && rule.itemTypeId !== undefined;
  const matchesTarget =
    hasTarget && current !== undefined && current.typeId === rule.itemTypeId && (current.nameTag ?? "") === (rule.itemName ?? "");

  if (hasTarget && (current === undefined || matchesTarget)) {
    const shortfall = rule.targetAmount - (current?.amount ?? 0);
    if (shortfall > 0 && !hasPendingSlotOrderFor(network.id, terminalLoc, rule.slotIndex)) {
      submitOrder(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, [
        {
          itemTypeId: rule.itemTypeId as string,
          itemName: rule.itemName,
          requested: shortfall,
          delivered: 0,
          exhausted: false,
          slotIndex: rule.slotIndex,
        },
      ]);
    }
  }

  if (rule.collect && current !== undefined) {
    const surplus = matchesTarget ? current.amount - rule.targetAmount : current.amount;
    if (surplus > 0 && !hasPendingSlotDepositFor(network.id, terminalLoc, rule.slotIndex)) {
      submitDeposit(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, [
        {
          itemTypeId: current.typeId,
          itemName: current.nameTag,
          requested: surplus,
          delivered: 0,
          exhausted: false,
          slotIndex: rule.slotIndex,
        },
      ]);
    }
  }
}
