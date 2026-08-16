import { system } from "@minecraft/server";
import { processNetworkDeposits } from "./depositProcessing";
import { getAllNetworks } from "./network";
import { processNetworkOrders } from "./orderProcessing";
import { processNetworkOrganize } from "./organizeProcessing";

// このループ自体は「Minecraftのサーバーtick」20回につき1回だけ実行される(system.runIntervalの
// 第2引数)。各処理内の「スループット」定数(ORDER_THROUGHPUT_PER_CYCLE等)は、あくまで
// 「このループが1回実行されるたびに消費できる予算」であり、Minecraftのサーバーtick単位の
// レートそのものではない(1/20のこの間隔で処理をまとめて行っているだけ)。コントローラUIの
// 「状況」タブでサーバーtick基準のレートに換算する際に参照できるようexportしている。
export const NETWORK_PROCESSING_INTERVAL_TICKS = 20;

// 引き出し・預け入れ・整理を同じtickループで処理する。それぞれ独立したスループット・
// キューを持つため、いずれかが詰まっても他には影響しない。docs/design.md 4章参照。
export function startNetworkProcessingLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      processNetworkOrders(network);
      processNetworkDeposits(network);
      processNetworkOrganize(network);
    }
  }, NETWORK_PROCESSING_INTERVAL_TICKS);
}
