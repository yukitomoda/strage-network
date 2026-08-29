import { system, world } from "@minecraft/server";
import { CONTROLLER_CYCLE_AXIS } from "./controllerAxes";
import { getControllerEnabled } from "./controllerSettings";
import { getAllNetworks, getIssuing, getOrders } from "./network";
import { getCycleIntervalTicks } from "./networkProcessing";
import { DELIVERY_TERMINAL_BLOCK_ID } from "./terminalBlock";
import { getAxisMaxTier } from "./upgrade";

// 配達ターミナルからの配達が進行中の間、アクションバーに集計進捗を表示し続ける。
// delivered の値自体は周期アップグレード軸(コントローラの処理サイクル間隔)より速くは
// 変化しないため、それより短い間隔で表示を更新しても無意味(実際の更新が無いのに同じ値を
// 描き直すだけ)。周期軸の最速Tier(T4)の間隔に合わせることで、無駄な更新を避けつつ、
// 実際に値が変わりうる最短間隔には確実に追従する。
const PROGRESS_INTERVAL_TICKS = getCycleIntervalTicks(getAxisMaxTier(CONTROLLER_CYCLE_AXIS));

export function startDeliveryProgressLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      const dimension = world.getDimension(network.dimensionId);
      // 「起動」スイッチがOFFの間は進捗も変化しないため、表示更新もスキップする(networkProcessing.ts参照)。
      if (!getControllerEnabled(dimension, network.controller)) continue;
      const activeOrders = [...getIssuing(network.id).map((entry) => entry.order), ...getOrders(network.id)];

      for (const order of activeOrders) {
        if (dimension.getBlock(order.terminal)?.typeId !== DELIVERY_TERMINAL_BLOCK_ID) continue;

        const player = world.getPlayers().find((p) => p.name === order.playerName);
        if (!player) continue; // オフライン等。オンライン中のみ表示(MVP)。

        const requested = order.lines.reduce((sum, l) => sum + l.requested, 0);
        const delivered = order.lines.reduce((sum, l) => sum + l.delivered, 0);
        player.onScreenDisplay.setActionBar(`§a配達中... ${delivered}/${requested}個`);
      }
    }
  }, PROGRESS_INTERVAL_TICKS);
}
