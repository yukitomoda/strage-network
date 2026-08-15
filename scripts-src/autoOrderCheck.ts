import { system, Vector3, world } from "@minecraft/server";
import { submitDeposit } from "./depositProcessing";
import { getAllNetworks, getDepositIssuing, getDeposits, getIssuing, getOrders } from "./network";
import { submitOrder } from "./orderProcessing";
import { CatalogEntry, scanContainerCatalog } from "./storageScan";
import { AUTO_TERMINAL_BLOCK_ID, getAttachedStorageLocation } from "./terminalBlock";
import { getAutoDeposit, getWishlist } from "./terminalSettings";
import { DepositLine, locEquals, NetworkData, OrderLine, WishlistLine } from "./state";

// MVP: 固定値(5秒)。将来はコントローラ/ターミナルのグレードに応じて可変にする。
// docs/design.md 4章「スループット制」と同様の考え方。
const AUTO_CHECK_INTERVAL_TICKS = 100;

// 自動発注には送信元プレイヤーが存在しないため、通知先が絶対に見つからないダミー名にしておく
// (自動端末は既定で通知OFFだが、プレイヤーが後から通知ONにしても実害が無いように)。
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
    submitDeposit(network.id, terminalLoc, lines);
  }
}

// 直前のチェックで出した引き出しがまだ処理中(発行待ち含む)なら、同じ品目を二重に引き出ししない。
function hasPendingOrderFor(
  networkId: string,
  terminalLoc: Vector3,
  itemTypeId: string,
  itemName: string | undefined
): boolean {
  const pendingOrders = [...getIssuing(networkId).map((entry) => entry.order), ...getOrders(networkId)];
  return pendingOrders.some(
    (order) =>
      locEquals(order.terminal, terminalLoc) &&
      order.lines.some(
        (line) =>
          line.itemTypeId === itemTypeId &&
          (line.itemName ?? "") === (itemName ?? "") &&
          !line.exhausted &&
          line.delivered < line.requested
      )
  );
}

// 自動預け入れ版のhasPendingOrderFor。直前に送った預け入れがまだ処理中なら同じ品目を二重に送らない。
function hasPendingDepositFor(
  networkId: string,
  terminalLoc: Vector3,
  itemTypeId: string,
  itemName: string | undefined
): boolean {
  const pendingDeposits = [
    ...getDepositIssuing(networkId).map((entry) => entry.request),
    ...getDeposits(networkId),
  ];
  return pendingDeposits.some(
    (request) =>
      locEquals(request.terminal, terminalLoc) &&
      request.lines.some(
        (line) =>
          line.itemTypeId === itemTypeId &&
          (line.itemName ?? "") === (itemName ?? "") &&
          !line.exhausted &&
          line.delivered < line.requested
      )
  );
}
