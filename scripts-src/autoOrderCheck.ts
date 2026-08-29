import { Dimension, Vector3 } from "@minecraft/server";
import { hasPendingDepositFor, submitDeposit } from "./depositProcessing";
import { getNetworkCatalogCached } from "./networkCatalogCache";
import { startCycleAlignedLoop } from "./networkProcessing";
import { hasPendingOrderFor, submitOrder } from "./orderProcessing";
import { CatalogEntry, scanContainerCatalog } from "./storageScan";
import { AUTO_TERMINAL_BLOCK_ID, getAttachedStorageLocation, isRedstoneLocked } from "./terminalBlock";
import { getAutoDeposit, getWishlist } from "./terminalSettings";
import { DepositLine, NetworkData, OrderLine, WishlistLine } from "./state";

// 自動発注・自動預け入れには送信元プレイヤーが存在しないため、空文字列にしておく
// (引き出しの完了通知は既定でOFFだが、後からONにしても通知先が見つからず実害が無いように。
// コントローラUIの「状況」タブでも、空文字列は「自動」として表示される)。
const AUTO_ORDER_PLAYER_NAME = "";

// networkProcessing.tsのstartCycleAlignedLoop参照: 以前は固定100tick(5秒)間隔だったが、
// コントローラの周期短縮キットのTierに応じたサイクル間隔に検知頻度も追従するようにした。
export function startAutoTerminalCheckLoop(): void {
  startCycleAlignedLoop(checkNetworkAutoTerminals);
}

function checkNetworkAutoTerminals(network: NetworkData, dimension: Dimension): void {
  for (const terminalLoc of network.terminals) {
    const block = dimension.getBlock(terminalLoc);
    if (!block?.isValid || block.typeId !== AUTO_TERMINAL_BLOCK_ID) continue;
    if (isRedstoneLocked(block)) continue;

    const wishlist = getWishlist(dimension, terminalLoc);
    const autoDeposit = getAutoDeposit(dimension, terminalLoc);
    if (wishlist.length === 0 && !autoDeposit) continue;

    const attachedLoc = getAttachedStorageLocation(block);
    const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
    const catalog = container ? scanContainerCatalog(container) : [];

    if (wishlist.length > 0) {
      checkShortfalls(network, dimension, terminalLoc, wishlist, catalog);
    }
    if (autoDeposit) {
      checkExcess(network, terminalLoc, wishlist, catalog);
    }
  }
}

// 目標を下回っている品目を引き出しする(従来の「自動引き出し」相当)。
function checkShortfalls(
  network: NetworkData,
  dimension: Dimension,
  terminalLoc: Vector3,
  wishlist: WishlistLine[],
  catalog: CatalogEntry[]
): void {
  // アタッチ先の不足数だけで即submitOrderせず、いったん候補として集める。ネットワーク在庫の
  // 確認(scanCatalog、コストが高い)は候補が実際にある時だけ行いたいため。
  const candidates: { wish: WishlistLine; shortfall: number }[] = [];
  for (const wish of wishlist) {
    const current =
      catalog.find((e) => e.key.typeId === wish.itemTypeId && (e.key.name ?? "") === (wish.itemName ?? ""))?.total ??
      0;
    const shortfall = wish.targetAmount - current;
    if (shortfall <= 0) continue;
    if (hasPendingOrderFor(network.id, terminalLoc, wish.itemTypeId, wish.itemName)) continue;
    candidates.push({ wish, shortfall });
  }
  if (candidates.length === 0) return;

  // ネットワークに実際に無い(または明らかに足りない)品目は、注文しても搬入先解決時に
  // shortfallとして即終了するだけの無駄な注文になる(次のチェック周期でまた同じ注文を出し
  // 続けてしまう)。ここで初めてネットワーク在庫(networkCatalogCache.ts、tickごとに
  // キャッシュ)を確認し、要求量を実在庫にクランプする(完全な保証ではなく目安。処理までの
  // 間に他ターミナルが同時に消費してズレることは許容する。ユーザー要望)。
  const networkCatalog = getNetworkCatalogCached(dimension, network);
  const lines: OrderLine[] = [];
  for (const { wish, shortfall } of candidates) {
    const availableInNetwork =
      networkCatalog.find((e) => e.key.typeId === wish.itemTypeId && (e.key.name ?? "") === (wish.itemName ?? ""))
        ?.total ?? 0;
    const requestAmount = Math.min(shortfall, availableInNetwork);
    if (requestAmount <= 0) continue;

    lines.push({
      itemTypeId: wish.itemTypeId,
      itemName: wish.itemName,
      requested: requestAmount,
      delivered: 0,
      exhausted: false,
    });
  }

  if (lines.length > 0) {
    submitOrder(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, lines);
  }
}

// リストに無い、またはリストの目標を上回っている品目を預け入れる(自動預け入れ)。
// 目標分は残す(送るのは超過分のみ)。リストに無い品目は目標0扱いなので全量が対象になる。
function checkExcess(
  network: NetworkData,
  terminalLoc: Vector3,
  wishlist: WishlistLine[],
  catalog: CatalogEntry[]
): void {
  const lines: DepositLine[] = [];
  for (const entry of catalog) {
    const wish = wishlist.find(
      (w) => w.itemTypeId === entry.key.typeId && (w.itemName ?? "") === (entry.key.name ?? "")
    );
    const target = wish?.targetAmount ?? 0;
    const excess = entry.total - target;
    if (excess <= 0) continue;
    if (hasPendingDepositFor(network.id, terminalLoc, entry.key.typeId, entry.key.name)) continue;

    lines.push({
      itemTypeId: entry.key.typeId,
      itemName: entry.key.name,
      requested: excess,
      delivered: 0,
      exhausted: false,
    });
  }

  if (lines.length > 0) {
    submitDeposit(network.id, terminalLoc, AUTO_ORDER_PLAYER_NAME, lines);
  }
}
