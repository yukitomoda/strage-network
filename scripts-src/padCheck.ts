import { Dimension, Player, Vector3 } from "@minecraft/server";
import { hasPendingDepositFor, submitDeposit } from "./depositProcessing";
import { getNetworkCatalogCached } from "./networkCatalogCache";
import { startCycleAlignedLoop } from "./networkProcessing";
import { hasPendingOrderFor, submitOrder } from "./orderProcessing";
import { CatalogEntry, scanContainerCatalog } from "./storageScan";
import { DepositLine, NetworkData, OrderLine, PadMode, PadTargetLine } from "./state";
import { getPadMode, getPadTargets } from "./terminalSettings";
import { IO_PAD_BLOCK_ID, isRedstoneLocked } from "./terminalBlock";

// networkProcessing.tsのstartCycleAlignedLoop参照: 以前は固定100tick(5秒)間隔だったが、
// コントローラの周期短縮キットのTierに応じたサイクル間隔に検知頻度も追従するようにした
// (ユーザー指摘: パッドに乗ってから搬入出が始まるまでのラグの一因だった)。
export function startPadCheckLoop(): void {
  startCycleAlignedLoop(checkNetworkPads);
}

// dimension.getPlayersは球状の近傍検索(maxDistanceによる絞り込み)しかできないため、
// 候補を広めに取ってから、パッドのXZセル内・Y方向は「パッドの上に乗っている」とみなせる
// 範囲(足元がblock.y+1付近、ジャンプ等での多少の浮きは許容)に厳密に絞り込む。このアドオンで
// 「プレイヤーが特定のブロックの上に乗っているか」を判定条件に使うのは搬入出パッドが初めて
// (既存のlocEqualsはブロック座標同士の一致判定のみを想定しており、プレイヤーの連続座標には
// 使えない)。
function playersStandingOn(dimension: Dimension, loc: Vector3): Player[] {
  const candidates = dimension.getPlayers({
    location: { x: loc.x + 0.5, y: loc.y + 1, z: loc.z + 0.5 },
    maxDistance: 1.5,
  });
  return candidates.filter((player) => {
    const p = player.location;
    return Math.floor(p.x) === loc.x && Math.floor(p.z) === loc.z && p.y >= loc.y + 1 && p.y < loc.y + 2.5;
  });
}

function checkNetworkPads(network: NetworkData, dimension: Dimension): void {
  for (const padLoc of network.terminals) {
    const block = dimension.getBlock(padLoc);
    if (!block?.isValid || block.typeId !== IO_PAD_BLOCK_ID) continue;
    if (isRedstoneLocked(block)) continue;

    const targets = getPadTargets(dimension, padLoc);
    if (targets.length === 0) continue;

    const mode = getPadMode(dimension, padLoc);
    for (const player of playersStandingOn(dimension, padLoc)) {
      const inventory = player.getComponent("inventory")?.container;
      if (!inventory) continue;
      checkPlayer(network, dimension, padLoc, player.name, mode, targets, scanContainerCatalog(inventory));
    }
  }
}

// 目標(所持数)との過不足を、パッドのモードに応じて片方向または両方向に解消する。
// - "both": 超過分は預け入れ、不足分は引き出し(在庫管理ターミナルのcheckStockTargetsと同じ発想)。
// - "deposit_only": 超過分の預け入れのみ(不足があっても引き出さない)。
// - "withdraw_only": 不足分の引き出しのみ(超過があっても預け入れない)。
// submitOrder/submitDepositのplayerNameには実際に乗っているプレイヤーの名前を渡す。自動端末等の
// 匿名チェック(空文字列)と違い、orderProcessing.ts/depositProcessing.tsが搬入出先(=このプレイヤーの
// インベントリ)を解決する際にplayerNameから本人を再検索するため、ここで正しく持たせる必要がある。
function checkPlayer(
  network: NetworkData,
  dimension: Dimension,
  padLoc: Vector3,
  playerName: string,
  mode: PadMode,
  targets: PadTargetLine[],
  catalog: CatalogEntry[]
): void {
  const depositLines: DepositLine[] = [];
  // 引き出し候補はいったん集める。ネットワーク在庫の確認(scanCatalog、コストが高い)は
  // 候補が実際にある時だけ行いたいため(autoOrderCheck.tsのcheckShortfallsと同じ理由)。
  const orderCandidates: { target: PadTargetLine; shortfall: number }[] = [];

  for (const target of targets) {
    const current =
      catalog.find((e) => e.key.typeId === target.itemTypeId && (e.key.name ?? "") === (target.itemName ?? ""))
        ?.total ?? 0;

    if (current > target.targetAmount && mode !== "withdraw_only") {
      const excess = current - target.targetAmount;
      if (hasPendingDepositFor(network.id, padLoc, target.itemTypeId, target.itemName)) continue;
      depositLines.push({
        itemTypeId: target.itemTypeId,
        itemName: target.itemName,
        requested: excess,
        delivered: 0,
        exhausted: false,
      });
    } else if (current < target.targetAmount && mode !== "deposit_only") {
      const shortfall = target.targetAmount - current;
      if (hasPendingOrderFor(network.id, padLoc, target.itemTypeId, target.itemName)) continue;
      orderCandidates.push({ target, shortfall });
    }
    // current === targetAmount の場合は何もしない(安定状態)。
  }

  const orderLines: OrderLine[] = [];
  if (orderCandidates.length > 0) {
    // ネットワークに実際に無い(または明らかに足りない)品目は注文しない(autoOrderCheck.tsの
    // checkShortfallsと同じ理由・同じ手法。ユーザー要望)。
    const networkCatalog = getNetworkCatalogCached(dimension, network);
    for (const { target, shortfall } of orderCandidates) {
      const availableInNetwork =
        networkCatalog.find(
          (e) => e.key.typeId === target.itemTypeId && (e.key.name ?? "") === (target.itemName ?? "")
        )?.total ?? 0;
      const requestAmount = Math.min(shortfall, availableInNetwork);
      if (requestAmount <= 0) continue;
      orderLines.push({
        itemTypeId: target.itemTypeId,
        itemName: target.itemName,
        requested: requestAmount,
        delivered: 0,
        exhausted: false,
      });
    }
  }

  if (orderLines.length > 0) {
    submitOrder(network.id, padLoc, playerName, orderLines);
  }
  if (depositLines.length > 0) {
    submitDeposit(network.id, padLoc, playerName, depositLines);
  }
}
