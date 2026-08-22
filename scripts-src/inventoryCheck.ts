import { Block, system, Vector3, world } from "@minecraft/server";
import { hasPendingDepositFor, submitDeposit } from "./depositProcessing";
import { getAllNetworks } from "./network";
import { hasPendingOrderFor, submitOrder } from "./orderProcessing";
import { DepositLine, NetworkData, OrderLine, StockTargetLine } from "./state";
import { CatalogEntry, scanCatalog, scanContainerCatalog } from "./storageScan";
import { getAttachedStorageLocation, INVENTORY_TERMINAL_BLOCK_ID, isRedstoneLocked } from "./terminalBlock";
import { getInventoryAutoDeposit, getStockTargets } from "./terminalSettings";

// MVP: 固定値(5秒)。自動端末(autoOrderCheck.ts)と同じ考え方。
// docs/design.md 4章「スループット制」参照。
const INVENTORY_CHECK_INTERVAL_TICKS = 100;

// 自動発注・自動預け入れと同じダミー値(autoOrderCheck.tsのAUTO_ORDER_PLAYER_NAME参照)。
const AUTO_ORDER_PLAYER_NAME = "";

export function startInventoryTerminalCheckLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      checkNetworkInventoryTerminals(network);
    }
  }, INVENTORY_CHECK_INTERVAL_TICKS);
}

function checkNetworkInventoryTerminals(network: NetworkData): void {
  const dimension = world.getDimension(network.dimensionId);

  const inventoryTerminals: { loc: Vector3; block: Block }[] = [];
  for (const loc of network.terminals) {
    const block = dimension.getBlock(loc);
    if (block?.isValid && block.typeId === INVENTORY_TERMINAL_BLOCK_ID) {
      inventoryTerminals.push({ loc, block });
    }
  }
  if (inventoryTerminals.length === 0) return;

  // 自動端末(アタッチ先1個だけをスキャン)と違い、判定にネットワーク全体の在庫数が必要なため、
  // scanCatalogはコストが高い。このネットワーク分だけ1回スキャンして全ターミナルで使い回す
  // (depositProcessing.tsのbuildStorageIndexと同じ考え方)。
  const networkCatalog = scanCatalog(dimension, network);

  for (const { loc: terminalLoc, block } of inventoryTerminals) {
    if (isRedstoneLocked(block)) continue;

    const targets = getStockTargets(dimension, terminalLoc);
    const autoDeposit = getInventoryAutoDeposit(dimension, terminalLoc);
    if (targets.length === 0 && !autoDeposit) continue;

    if (targets.length > 0) {
      checkStockTargets(network, terminalLoc, targets, networkCatalog);
    }
    if (autoDeposit) {
      checkUnlistedItems(network, terminalLoc, block, targets);
    }
  }
}

// ネットワーク在庫が目標を上回っていれば引き出し(ネットワークから減らしてアタッチ先へ)、
// 下回っていれば預け入れ(アタッチ先から補充してネットワークへ)。自動端末のcheckShortfalls/
// checkExcessと対称な構造だが、比較の基準がアタッチ先の中身ではなくネットワーク全体の
// 在庫数である点が異なる(docs/design.md参照)。
function checkStockTargets(
  network: NetworkData,
  terminalLoc: Vector3,
  targets: StockTargetLine[],
  networkCatalog: CatalogEntry[]
): void {
  const orderLines: OrderLine[] = [];
  const depositLines: DepositLine[] = [];

  for (const target of targets) {
    const current =
      networkCatalog.find(
        (e) => e.key.typeId === target.itemTypeId && (e.key.name ?? "") === (target.itemName ?? "")
      )?.total ?? 0;

    if (current > target.targetAmount) {
      const excess = current - target.targetAmount;
      if (hasPendingOrderFor(network.id, terminalLoc, target.itemTypeId, target.itemName)) continue;
      orderLines.push({
        itemTypeId: target.itemTypeId,
        itemName: target.itemName,
        requested: excess,
        delivered: 0,
        exhausted: false,
      });
    } else if (current < target.targetAmount) {
      const shortfall = target.targetAmount - current;
      if (hasPendingDepositFor(network.id, terminalLoc, target.itemTypeId, target.itemName)) continue;
      depositLines.push({
        itemTypeId: target.itemTypeId,
        itemName: target.itemName,
        requested: shortfall,
        delivered: 0,
        exhausted: false,
      });
    }
    // current === targetAmount の場合は何もしない(安定状態)。
  }

  if (orderLines.length > 0) {
    submitOrder(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, orderLines);
  }
  if (depositLines.length > 0) {
    submitDeposit(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, depositLines);
  }
}

// 自動預け入れ(設定タブのトグル、デフォルトOFF): リストに無い品目がアタッチ先にあれば
// 全量預け入れる(自動端末のcheckExcessのうち「リストに無い品目」のケースと同じ考え方)。
// リストにある品目はネットワーク在庫を基準にcheckStockTargetsが別途扱うため、ここでは
// 対象外にする(二重に預け入れ判定をしないように)。
function checkUnlistedItems(
  network: NetworkData,
  terminalLoc: Vector3,
  block: Block,
  targets: StockTargetLine[]
): void {
  const dimension = block.dimension;
  const attachedLoc = getAttachedStorageLocation(block);
  const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
  if (!container) return;

  const depositLines: DepositLine[] = [];
  for (const entry of scanContainerCatalog(container)) {
    const isListed = targets.some(
      (t) => t.itemTypeId === entry.key.typeId && (t.itemName ?? "") === (entry.key.name ?? "")
    );
    if (isListed) continue;
    if (hasPendingDepositFor(network.id, terminalLoc, entry.key.typeId, entry.key.name)) continue;

    depositLines.push({
      itemTypeId: entry.key.typeId,
      itemName: entry.key.name,
      requested: entry.total,
      delivered: 0,
      exhausted: false,
    });
  }

  if (depositLines.length > 0) {
    submitDeposit(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, depositLines);
  }
}
