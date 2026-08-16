import { system, Vector3, world } from "@minecraft/server";
import { hasPendingDepositFor, submitDeposit } from "./depositProcessing";
import { getAllNetworks } from "./network";
import { hasPendingOrderFor, submitOrder } from "./orderProcessing";
import { CatalogEntry, scanContainerCatalog } from "./storageScan";
import { AUTO_TERMINAL_BLOCK_ID, getAttachedStorageLocation } from "./terminalBlock";
import { getAutoDeposit, getWishlist } from "./terminalSettings";
import { DepositLine, NetworkData, OrderLine, WishlistLine } from "./state";

// MVP: 固定値(5秒)。将来はコントローラ/ターミナルのグレードに応じて可変にする。
// docs/design.md 4章「スループット制」と同様の考え方。
const AUTO_CHECK_INTERVAL_TICKS = 100;

// 自動発注・自動預け入れには送信元プレイヤーが存在しないため、空文字列にしておく
// (引き出しの完了通知は既定でOFFだが、後からONにしても通知先が見つからず実害が無いように。
// コントローラUIの「状況」タブでも、空文字列は「自動」として表示される)。
const AUTO_ORDER_PLAYER_NAME = "";

export function startAutoTerminalCheckLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      checkNetworkAutoTerminals(network);
    }
  }, AUTO_CHECK_INTERVAL_TICKS);
}

function checkNetworkAutoTerminals(network: NetworkData): void {
  const dimension = world.getDimension(network.dimensionId);

  for (const terminalLoc of network.terminals) {
    const block = dimension.getBlock(terminalLoc);
    if (!block?.isValid || block.typeId !== AUTO_TERMINAL_BLOCK_ID) continue;

    const wishlist = getWishlist(dimension, terminalLoc);
    const autoDeposit = getAutoDeposit(dimension, terminalLoc);
    if (wishlist.length === 0 && !autoDeposit) continue;

    const attachedLoc = getAttachedStorageLocation(block);
    const container = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;
    const catalog = container ? scanContainerCatalog(container) : [];

    if (wishlist.length > 0) {
      checkShortfalls(network, terminalLoc, wishlist, catalog);
    }
    if (autoDeposit) {
      checkExcess(network, terminalLoc, wishlist, catalog);
    }
  }
}

// 目標を下回っている品目を引き出しする(従来の「自動引き出し」相当)。
function checkShortfalls(
  network: NetworkData,
  terminalLoc: Vector3,
  wishlist: WishlistLine[],
  catalog: CatalogEntry[]
): void {
  const lines: OrderLine[] = [];
  for (const wish of wishlist) {
    const current =
      catalog.find((e) => e.key.typeId === wish.itemTypeId && (e.key.name ?? "") === (wish.itemName ?? ""))?.total ??
      0;
    const shortfall = wish.targetAmount - current;
    if (shortfall <= 0) continue;
    if (hasPendingOrderFor(network.id, terminalLoc, wish.itemTypeId, wish.itemName)) continue;

    lines.push({
      itemTypeId: wish.itemTypeId,
      itemName: wish.itemName,
      requested: shortfall,
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
