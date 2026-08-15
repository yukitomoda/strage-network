import { system } from "@minecraft/server";
import { processNetworkDeposits } from "./depositProcessing";
import { getAllNetworks } from "./network";
import { processNetworkOrders } from "./orderProcessing";
import { processNetworkOrganize } from "./organizeProcessing";

const TICK_INTERVAL = 20;

// 引き出し・預け入れ・整理を同じtickループで処理する。それぞれ独立したスループット・
// キューを持つため、いずれかが詰まっても他には影響しない。docs/design.md 4章参照。
export function startNetworkProcessingLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      processNetworkOrders(network);
      processNetworkDeposits(network);
      processNetworkOrganize(network);
    }
  }, TICK_INTERVAL);
}
