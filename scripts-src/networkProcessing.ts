import { system } from "@minecraft/server";
import { processNetworkDeposits } from "./depositProcessing";
import { getAllNetworks } from "./network";
import { processNetworkOrders } from "./orderProcessing";

const TICK_INTERVAL = 20;

// 注文(引き出し)と納入(格納)を同じtickループで処理する。それぞれ独立したスループット・
// キューを持つため、片方が詰まってももう片方には影響しない。docs/design.md 4章参照。
export function startNetworkProcessingLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      processNetworkOrders(network);
      processNetworkDeposits(network);
    }
  }, TICK_INTERVAL);
}
