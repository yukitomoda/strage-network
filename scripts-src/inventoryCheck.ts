import { Block, Dimension, Vector3 } from "@minecraft/server";
import { getNetworkCatalogCached } from "./networkCatalogCache";
import { extractFromStorages, insertIntoStorages, scanContainerCatalog, StorageIndex } from "./storageScan";
import { getAttachedStorageLocation } from "./terminalBlock";
import { getInventoryAutoDeposit, getStockTargets } from "./terminalSettings";
import { NetworkData } from "./state";

// 目標系ターミナルの「広告モデル」(25章)。autoOrderCheck.tsと同じ考え方だが、比較基準が
// アタッチ先の中身ではなくネットワーク全体の在庫数である点が異なる(docs/design.md参照)。
// ネットワーク在庫が目標を上回っていれば引き出し(ネットワークから減らしてアタッチ先へ)、
// 下回っていれば預け入れ(アタッチ先から補充してネットワークへ)。

export function reconcileInventoryTerminalWithdrawal(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number
): number {
  if (budget <= 0) return 0;
  const targets = getStockTargets(dimension, block.location);
  if (targets.length === 0) return 0;

  const attachedLoc = getAttachedStorageLocation(block);
  const destContainer = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
  if (!destContainer) return 0;

  // ネットワーク全体の在庫数が比較基準そのものなので、クランプ用途ではなく本質的に必要
  // (networkCatalogCache.tsによりtickごとにキャッシュされるため、他のターミナルの
  // 定期処理と同じtickで重複走査にはならない)。
  const networkCatalog = getNetworkCatalogCached(dimension, network);

  let remaining = budget;
  let consumed = 0;
  for (const target of targets) {
    if (remaining <= 0) break;
    const current =
      networkCatalog.find((e) => e.key.typeId === target.itemTypeId && (e.key.name ?? "") === (target.itemName ?? ""))
        ?.total ?? 0;
    const excess = current - target.targetAmount;
    if (excess <= 0) continue;

    const attempt = Math.min(excess, remaining);
    const extracted = extractFromStorages(
      dimension,
      network,
      { typeId: target.itemTypeId, name: target.itemName },
      attempt,
      destContainer
    );
    remaining -= extracted;
    consumed += extracted;
  }
  return consumed;
}

export function reconcileInventoryTerminalDeposit(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number,
  storageIndex?: StorageIndex,
  depositTargets?: Vector3[]
): number {
  if (budget <= 0) return 0;
  const targets = getStockTargets(dimension, block.location);
  const autoDeposit = getInventoryAutoDeposit(dimension, block.location);
  if (targets.length === 0 && !autoDeposit) return 0;

  const attachedLoc = getAttachedStorageLocation(block);
  const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
  if (!container) return 0;

  let remaining = budget;
  let consumed = 0;

  if (targets.length > 0) {
    const networkCatalog = getNetworkCatalogCached(dimension, network);
    for (const target of targets) {
      if (remaining <= 0) break;
      const current =
        networkCatalog.find(
          (e) => e.key.typeId === target.itemTypeId && (e.key.name ?? "") === (target.itemName ?? "")
        )?.total ?? 0;
      const shortfall = target.targetAmount - current;
      if (shortfall <= 0) continue;

      const attempt = Math.min(shortfall, remaining);
      const inserted = insertIntoStorages(
        dimension,
        network,
        { typeId: target.itemTypeId, name: target.itemName },
        attempt,
        container,
        storageIndex,
        depositTargets
      );
      remaining -= inserted;
      consumed += inserted;
    }
  }

  // 自動預け入れ(設定タブのトグル、デフォルトOFF): リストに無い品目がアタッチ先にあれば
  // 全量預け入れる。リストにある品目は上のループで既に扱っているため、ここでは対象外にする
  // (二重に預け入れ判定をしないように)。
  if (autoDeposit && remaining > 0) {
    for (const entry of scanContainerCatalog(container)) {
      if (remaining <= 0) break;
      const isListed = targets.some(
        (t) => t.itemTypeId === entry.key.typeId && (t.itemName ?? "") === (entry.key.name ?? "")
      );
      if (isListed) continue;

      const attempt = Math.min(entry.total, remaining);
      const inserted = insertIntoStorages(dimension, network, entry.key, attempt, container, storageIndex, depositTargets);
      remaining -= inserted;
      consumed += inserted;
    }
  }

  return consumed;
}
