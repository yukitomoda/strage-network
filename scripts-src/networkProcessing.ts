import { system, world } from "@minecraft/server";
import { CONTROLLER_CYCLE_AXIS } from "./controllerAxes";
import { processNetworkDeposits } from "./depositProcessing";
import { getAllNetworks } from "./network";
import { processNetworkOrders } from "./orderProcessing";
import { processNetworkOrganize } from "./organizeProcessing";
import { getAxisTier } from "./upgrade";

// ネットワークごとの実際の処理サイクル間隔(tick数)。コントローラの「周期」アップグレード軸
// (tier0〜4)ごとに変わる。docs/design.md 4章「スループット制」参照。値が小さいほどサイクルが
// 頻繁に回る=速くなる。
const CYCLE_TICKS_BY_TIER = [100, 80, 50, 25, 10];
// コントローラUIの「状況」タブ表示用にexportしている。
export function getCycleIntervalTicks(tier: number): number {
  return CYCLE_TICKS_BY_TIER[tier] ?? CYCLE_TICKS_BY_TIER[CYCLE_TICKS_BY_TIER.length - 1];
}

// 基準ループの間隔。個々のネットワークの実際のサイクル間隔はCYCLE_TICKS_BY_TIERにより
// ネットワークごとに異なる(最短10tick)ため、この基準ループはそれより十分細かい間隔で回し、
// ネットワークごとに「前回処理からこの間隔以上経過したか」を判定する。
const BASE_LOOP_INTERVAL_TICKS = 5;

// ネットワークID -> 最後に処理したsystem.currentTick。メモリ上だけで持てば十分
// (ワールド再読み込みで消えても、次のtickで即座に再計測されるだけで実害が無い)。
const lastProcessedTick = new Map<string, number>();

// 引き出し・預け入れ・整理を同じサイクルで処理する。それぞれ独立したスループット・
// キューを持つため、いずれかが詰まっても他には影響しない。docs/design.md 4章参照。
export function startNetworkProcessingLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      const dimension = world.getDimension(network.dimensionId);
      const cycleTicks = getCycleIntervalTicks(getAxisTier(dimension, network.controller, CONTROLLER_CYCLE_AXIS));
      const last = lastProcessedTick.get(network.id);
      if (last !== undefined && system.currentTick - last < cycleTicks) continue;
      lastProcessedTick.set(network.id, system.currentTick);

      processNetworkOrders(network);
      processNetworkDeposits(network);
      processNetworkOrganize(network);
    }
  }, BASE_LOOP_INTERVAL_TICKS);
}
