import { system, world } from "@minecraft/server";
import { CONTROLLER_CYCLE_AXIS } from "./controllerAxes";
import { getAllNetworks, getDepositIssuing, getDeposits, getIssuing, getOrders } from "./network";
import { getCycleIntervalTicks } from "./networkProcessing";
import { IO_PAD_BLOCK_ID } from "./terminalBlock";
import { getAxisMaxTier } from "./upgrade";

// deliveryProgress.tsと同じ理由・同じ間隔(周期軸の最速Tierの間隔)でアクションバーの進捗表示を
// 更新する。搬入出パッドは「搬出のみ」「搬入のみ」だけでなく「搬入出」モードで両方向のキューを
// 同時に持ちうる(配達ターミナルは常に引き出し=搬出方向のみ)ため、プレイヤーごとに搬出/搬入の
// 行をまとめてから1回のsetActionBarで表示する(別々に呼ぶと後勝ちで片方が消えてしまうため)。
const PROGRESS_INTERVAL_TICKS = getCycleIntervalTicks(getAxisMaxTier(CONTROLLER_CYCLE_AXIS));

export function startPadProgressLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      const dimension = world.getDimension(network.dimensionId);
      const activeOrders = [...getIssuing(network.id).map((entry) => entry.order), ...getOrders(network.id)];
      const activeDeposits = [
        ...getDepositIssuing(network.id).map((entry) => entry.request),
        ...getDeposits(network.id),
      ];

      const linesByPlayer = new Map<string, string[]>();

      for (const order of activeOrders) {
        if (dimension.getBlock(order.terminal)?.typeId !== IO_PAD_BLOCK_ID) continue;
        const requested = order.lines.reduce((sum, l) => sum + l.requested, 0);
        const delivered = order.lines.reduce((sum, l) => sum + l.delivered, 0);
        const lines = linesByPlayer.get(order.playerName) ?? [];
        lines.push(`§a搬出中... ${delivered}/${requested}個`);
        linesByPlayer.set(order.playerName, lines);
      }

      for (const request of activeDeposits) {
        if (dimension.getBlock(request.terminal)?.typeId !== IO_PAD_BLOCK_ID) continue;
        const requested = request.lines.reduce((sum, l) => sum + l.requested, 0);
        const delivered = request.lines.reduce((sum, l) => sum + l.delivered, 0);
        const lines = linesByPlayer.get(request.playerName) ?? [];
        lines.push(`§b搬入中... ${delivered}/${requested}個`);
        linesByPlayer.set(request.playerName, lines);
      }

      for (const [playerName, lines] of linesByPlayer) {
        const player = world.getPlayers().find((p) => p.name === playerName);
        if (!player) continue; // オフライン等。オンライン中のみ表示(deliveryProgress.tsと同じMVP方針)。
        player.onScreenDisplay.setActionBar(lines.join("\n"));
      }
    }
  }, PROGRESS_INTERVAL_TICKS);
}
