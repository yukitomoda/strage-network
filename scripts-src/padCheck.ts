import { Block, Container, Dimension, Player, Vector3 } from "@minecraft/server";
import { extractFromStorages, insertIntoStorages, scanContainerCatalog, StorageIndex } from "./storageScan";
import { getPadMode, getPadTargets } from "./terminalSettings";
import { NetworkData, PadTargetLine } from "./state";

// 目標系ターミナルの「広告モデル」(25章)。搬入出パッドはモード("both"/"deposit_only"/
// "withdraw_only")に応じて片方向または両方向に過不足を解消する(在庫管理ターミナルの
// reconcileInventoryTerminalWithdrawal/Depositと同じ発想)。既にプレイヤーのインベントリ
// Containerを手にしているため、他の3種と違い搬入先解決の間接参照(order.playerNameからの
// 再検索)を経由しない。

// dimension.getPlayersは球状の近傍検索(maxDistanceによる絞り込み)しかできないため、
// 候補を広めに取ってから、パッドのXZセル内・Y方向は「パッドの上に乗っている」とみなせる
// 範囲(足元がblock.y+1付近、ジャンプ等での多少の浮きは許容)に厳密に絞り込む。
// ioPadProgress.tsの表示専用ライブ比較からも同じ判定を使うためexportしている。
export function playersStandingOn(dimension: Dimension, loc: Vector3): Player[] {
  const candidates = dimension.getPlayers({
    location: { x: loc.x + 0.5, y: loc.y + 1, z: loc.z + 0.5 },
    maxDistance: 1.5,
  });
  return candidates.filter((player) => {
    const p = player.location;
    return Math.floor(p.x) === loc.x && Math.floor(p.z) === loc.z && p.y >= loc.y + 1 && p.y < loc.y + 2.5;
  });
}

export function reconcileIoPadWithdrawal(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number
): number {
  if (budget <= 0) return 0;
  const targets = getPadTargets(dimension, block.location);
  if (targets.length === 0) return 0;
  const mode = getPadMode(dimension, block.location);
  if (mode === "deposit_only") return 0;

  let remaining = budget;
  let consumed = 0;
  for (const player of playersStandingOn(dimension, block.location)) {
    if (remaining <= 0) break;
    const inventory = player.getComponent("inventory")?.container;
    if (!inventory) continue;
    const delivered = reconcilePlayerWithdrawal(network, dimension, inventory, targets, remaining);
    remaining -= delivered;
    consumed += delivered;
  }
  return consumed;
}

function reconcilePlayerWithdrawal(
  network: NetworkData,
  dimension: Dimension,
  inventory: Container,
  targets: PadTargetLine[],
  budget: number
): number {
  const catalog = scanContainerCatalog(inventory);
  let remaining = budget;
  let consumed = 0;
  for (const target of targets) {
    if (remaining <= 0) break;
    const current =
      catalog.find((e) => e.key.typeId === target.itemTypeId && (e.key.name ?? "") === (target.itemName ?? ""))
        ?.total ?? 0;
    const shortfall = target.targetAmount - current;
    if (shortfall <= 0) continue;

    const attempt = Math.min(shortfall, remaining);
    const extracted = extractFromStorages(
      dimension,
      network,
      { typeId: target.itemTypeId, name: target.itemName },
      attempt,
      inventory
    );
    remaining -= extracted;
    consumed += extracted;
  }
  return consumed;
}

export function reconcileIoPadDeposit(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number,
  storageIndex?: StorageIndex,
  depositTargets?: Vector3[]
): number {
  if (budget <= 0) return 0;
  const targets = getPadTargets(dimension, block.location);
  if (targets.length === 0) return 0;
  const mode = getPadMode(dimension, block.location);
  if (mode === "withdraw_only") return 0;

  let remaining = budget;
  let consumed = 0;
  for (const player of playersStandingOn(dimension, block.location)) {
    if (remaining <= 0) break;
    const inventory = player.getComponent("inventory")?.container;
    if (!inventory) continue;
    const delivered = reconcilePlayerDeposit(network, dimension, inventory, targets, remaining, storageIndex, depositTargets);
    remaining -= delivered;
    consumed += delivered;
  }
  return consumed;
}

function reconcilePlayerDeposit(
  network: NetworkData,
  dimension: Dimension,
  inventory: Container,
  targets: PadTargetLine[],
  budget: number,
  storageIndex: StorageIndex | undefined,
  depositTargets: Vector3[] | undefined
): number {
  const catalog = scanContainerCatalog(inventory);
  let remaining = budget;
  let consumed = 0;
  for (const target of targets) {
    if (remaining <= 0) break;
    const current =
      catalog.find((e) => e.key.typeId === target.itemTypeId && (e.key.name ?? "") === (target.itemName ?? ""))
        ?.total ?? 0;
    const excess = current - target.targetAmount;
    if (excess <= 0) continue;

    const attempt = Math.min(excess, remaining);
    const inserted = insertIntoStorages(
      dimension,
      network,
      { typeId: target.itemTypeId, name: target.itemName },
      attempt,
      inventory,
      storageIndex,
      depositTargets
    );
    remaining -= inserted;
    consumed += inserted;
  }
  return consumed;
}
