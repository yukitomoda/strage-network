import { Block, Dimension, Vector3 } from "@minecraft/server";
import { extractFromStorages, insertIntoStorages, scanContainerCatalog, StorageIndex } from "./storageScan";
import { getAttachedStorageLocation } from "./terminalBlock";
import { getAutoDeposit, getWishlist } from "./terminalSettings";
import { NetworkData, WishlistLine } from "./state";

// 目標系ターミナルの「広告モデル」(25章、ユーザー提案)。以前はここでshortfall/excessを
// 計算して`submitOrder`/`submitDeposit`でキューに積んでいたが、今は`targetReconciliation.ts`の
// ディスパッチャから直接呼ばれ、共有予算(budget)の範囲内でその場で搬入出まで行う。
// 戻り値は実際に消費した予算(=実際に動かした個数)。レッドストーンロックの判定は
// targetReconciliation.ts側で共通に行うため、ここでは行わない。

// 目標を下回っている品目を引き出しする(従来の「自動引き出し」相当)。
export function reconcileAutoTerminalWithdrawal(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number
): number {
  if (budget <= 0) return 0;
  const wishlist = getWishlist(dimension, block.location);
  if (wishlist.length === 0) return 0;

  const attachedLoc = getAttachedStorageLocation(block);
  const destContainer = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
  if (!destContainer) return 0;
  const catalog = scanContainerCatalog(destContainer);

  let remaining = budget;
  let consumed = 0;
  for (const wish of wishlist) {
    if (remaining <= 0) break;
    const current =
      catalog.find((e) => e.key.typeId === wish.itemTypeId && (e.key.name ?? "") === (wish.itemName ?? ""))?.total ??
      0;
    const shortfall = wish.targetAmount - current;
    if (shortfall <= 0) continue;

    const attempt = Math.min(shortfall, remaining);
    const extracted = extractFromStorages(
      dimension,
      network,
      { typeId: wish.itemTypeId, name: wish.itemName },
      attempt,
      destContainer
    );
    remaining -= extracted;
    consumed += extracted;
  }
  return consumed;
}

// リストに無い、またはリストの目標を上回っている品目を預け入れる(自動預け入れ)。
// 目標分は残す(送るのは超過分のみ)。リストに無い品目は目標0扱いなので全量が対象になる。
export function reconcileAutoTerminalDeposit(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number,
  storageIndex?: StorageIndex,
  depositTargets?: Vector3[]
): number {
  if (budget <= 0) return 0;
  const autoDeposit = getAutoDeposit(dimension, block.location);
  if (!autoDeposit) return 0;

  const wishlist = getWishlist(dimension, block.location);
  const attachedLoc = getAttachedStorageLocation(block);
  const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
  if (!container) return 0;
  const catalog = scanContainerCatalog(container);

  let remaining = budget;
  let consumed = 0;
  for (const entry of catalog) {
    if (remaining <= 0) break;
    const wish = wishlist.find(
      (w: WishlistLine) => w.itemTypeId === entry.key.typeId && (w.itemName ?? "") === (entry.key.name ?? "")
    );
    const target = wish?.targetAmount ?? 0;
    const excess = entry.total - target;
    if (excess <= 0) continue;

    const attempt = Math.min(excess, remaining);
    const inserted = insertIntoStorages(dimension, network, entry.key, attempt, container, storageIndex, depositTargets);
    remaining -= inserted;
    consumed += inserted;
  }
  return consumed;
}
