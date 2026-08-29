import { Dimension, Vector3 } from "@minecraft/server";
import { reconcileAutoTerminalDeposit, reconcileAutoTerminalWithdrawal } from "./autoOrderCheck";
import { reconcileInventoryTerminalDeposit, reconcileInventoryTerminalWithdrawal } from "./inventoryCheck";
import { reconcileIoPadDeposit, reconcileIoPadWithdrawal } from "./padCheck";
import { reconcilePrecisionTerminalDeposit, reconcilePrecisionTerminalWithdrawal } from "./precisionTerminalCheck";
import { NetworkData } from "./state";
import { buildStorageIndex, StorageIndex } from "./storageScan";
import { getDrain } from "./storageSettings";
import { reconcileSuctionPadDeposit } from "./suctionPadCheck";
import {
  AUTO_TERMINAL_BLOCK_ID,
  INVENTORY_TERMINAL_BLOCK_ID,
  IO_PAD_BLOCK_ID,
  isRedstoneLocked,
  PRECISION_TERMINAL_BLOCK_ID,
  SUCTION_PAD_BLOCK_ID,
} from "./terminalBlock";

// 目標系ターミナル(自動端末・在庫管理ターミナル・精密ターミナル・搬入出パッド)の「広告モデル」
// (吸い込みパッドも預け入れ方向のみ同じ枠組みに乗る。目標を持たず範囲内を無条件回収するだけの
// 点が他の4種と異なるため、reconcileAllTargetWithdrawals側には登録していない。30章参照)
// (25章、ユーザー提案)のディスパッチャ。以前は各ターミナルが専用のチェックループでshortfall/
// excessを計算し`submitOrder`/`submitDeposit`でキューに積んでいたが、目標値は既に
// terminalSettings.tsに永続化されているため、コントローラの処理サイクル(orderProcessing.tsの
// processNetworkOrders/depositProcessing.tsのprocessNetworkDeposits)がその場で直接読みに行き、
// 必要な分だけ動かす。`network.terminals`を1回だけ走査し、typeIdに応じて各ターミナル種別の
// 直接処理関数へ振り分ける(走査順=登録順。現行のFIFOと同じ「早い者勝ち」特性を維持する。
// ラウンドロビン等の公平性改善は今回のスコープ外)。
// レッドストーンロックの判定は4種で共通のため、ここで一括して行う(以前は各チェックループが
// 個別に判定していた)。

export function reconcileAllTargetWithdrawals(network: NetworkData, dimension: Dimension, budget: number): number {
  if (budget <= 0) return 0;
  let consumed = 0;
  for (const loc of network.terminals) {
    if (consumed >= budget) break;
    const block = dimension.getBlock(loc);
    if (!block?.isValid || isRedstoneLocked(block)) continue;
    const remaining = budget - consumed;

    switch (block.typeId) {
      case AUTO_TERMINAL_BLOCK_ID:
        consumed += reconcileAutoTerminalWithdrawal(network, dimension, block, remaining);
        break;
      case INVENTORY_TERMINAL_BLOCK_ID:
        consumed += reconcileInventoryTerminalWithdrawal(network, dimension, block, remaining);
        break;
      case PRECISION_TERMINAL_BLOCK_ID:
        consumed += reconcilePrecisionTerminalWithdrawal(network, dimension, block, remaining);
        break;
      case IO_PAD_BLOCK_ID:
        consumed += reconcileIoPadWithdrawal(network, dimension, block, remaining);
        break;
    }
  }
  return consumed;
}

// storageIndex/depositTargetsは呼び出し元(depositProcessing.ts)が固定量の「預け入れ」FIFO向けに
// 既に構築済みならそれを渡して使い回す(ネットワーク全体のスロットを走査するコストがあるため)。
// 渡されなければここで初めて構築する。depositTargets(Drain指定されたストレージを除外した
// リスト)は単なる最適化ではなく、渡さないとinsertIntoStorages側のデフォルト(network.storages
// 全体)にフォールバックしてDrain指定を無視してしまうため、未指定時は必ずここで構築する
// (省略不可)。
export function reconcileAllTargetDeposits(
  network: NetworkData,
  dimension: Dimension,
  budget: number,
  storageIndex?: StorageIndex,
  depositTargets?: Vector3[]
): number {
  if (budget <= 0) return 0;
  const index = storageIndex ?? buildStorageIndex(dimension, network);
  const targets = depositTargets ?? network.storages.filter((loc) => !getDrain(dimension, loc));

  let consumed = 0;
  for (const loc of network.terminals) {
    if (consumed >= budget) break;
    const block = dimension.getBlock(loc);
    if (!block?.isValid || isRedstoneLocked(block)) continue;
    const remaining = budget - consumed;

    switch (block.typeId) {
      case AUTO_TERMINAL_BLOCK_ID:
        consumed += reconcileAutoTerminalDeposit(network, dimension, block, remaining, index, targets);
        break;
      case INVENTORY_TERMINAL_BLOCK_ID:
        consumed += reconcileInventoryTerminalDeposit(network, dimension, block, remaining, index, targets);
        break;
      case PRECISION_TERMINAL_BLOCK_ID:
        consumed += reconcilePrecisionTerminalDeposit(network, dimension, block, remaining, index, targets);
        break;
      case IO_PAD_BLOCK_ID:
        consumed += reconcileIoPadDeposit(network, dimension, block, remaining, index, targets);
        break;
      case SUCTION_PAD_BLOCK_ID:
        consumed += reconcileSuctionPadDeposit(network, dimension, block, remaining, index, targets);
        break;
    }
  }
  return consumed;
}
