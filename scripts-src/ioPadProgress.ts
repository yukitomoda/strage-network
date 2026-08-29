import { ItemStack, RawMessage, system, world } from "@minecraft/server";
import { CONTROLLER_CYCLE_AXIS } from "./controllerAxes";
import { getControllerEnabled } from "./controllerSettings";
import { getAllNetworks } from "./network";
import { getCycleIntervalTicks } from "./networkProcessing";
import { playersStandingOn } from "./padCheck";
import { PadTargetLine } from "./state";
import { CatalogEntry, scanContainerCatalog } from "./storageScan";
import { getPadTargets } from "./terminalSettings";
import { IO_PAD_BLOCK_ID } from "./terminalBlock";
import { getAxisMaxTier } from "./upgrade";

// 25章の広告モデルへの移行により、搬入出パッドの搬入出はOrder/DepositRequestのキューを
// 経由しなくなったため、以前のように delivered/requested を読んで進捗を出すことができなくなった。
// 代わりに、targetReconciliation.tsの実際の判定(目標 vs 現在の所持数)と同じ比較を表示専用に
// 行う(このループ自体は搬入出を行わない、読み取りのみ)。deliveryProgress.tsと同じ理由・同じ
// 間隔(周期軸の最速Tierの間隔)で更新する。
const PROGRESS_INTERVAL_TICKS = getCycleIntervalTicks(getAxisMaxTier(CONTROLLER_CYCLE_AXIS));

export function startPadProgressLoop(): void {
  system.runInterval(() => {
    for (const network of getAllNetworks()) {
      const dimension = world.getDimension(network.dimensionId);
      // 「起動」スイッチがOFFの間は搬入出自体が行われないため、表示更新もスキップする(networkProcessing.ts参照)。
      if (!getControllerEnabled(dimension, network.controller)) continue;

      for (const loc of network.terminals) {
        const block = dimension.getBlock(loc);
        if (!block?.isValid || block.typeId !== IO_PAD_BLOCK_ID) continue;

        const targets = getPadTargets(dimension, loc);
        if (targets.length === 0) continue;

        for (const player of playersStandingOn(dimension, loc)) {
          const inventory = player.getComponent("inventory")?.container;
          if (!inventory) continue;

          const message = buildStatusMessage(targets, scanContainerCatalog(inventory));
          if (message) player.onScreenDisplay.setActionBar(message);
        }
      }
    }
  }, PROGRESS_INTERVAL_TICKS);
}

// 目標に達していない品目を「現在N/目標M 品名」の行として並べる(不足=§a、超過=§b、旧来の
// 「搬出中」「搬入中」の色分けを踏襲)。全品目が目標通りなら何も表示しない(undefined)。
function buildStatusMessage(targets: PadTargetLine[], catalog: CatalogEntry[]): (RawMessage | string)[] | undefined {
  const parts: (RawMessage | string)[] = [];

  for (const target of targets) {
    const entry = catalog.find(
      (e) => e.key.typeId === target.itemTypeId && (e.key.name ?? "") === (target.itemName ?? "")
    );
    const current = entry?.total ?? 0;
    if (current === target.targetAmount) continue;

    if (parts.length > 0) parts.push("\n");
    const color = current < target.targetAmount ? "§a" : "§b";
    parts.push(`${color}${current}/${target.targetAmount} `);
    parts.push(
      target.itemName
        ? { text: target.itemName }
        : { translate: entry?.localizationKey ?? new ItemStack(target.itemTypeId, 1).localizationKey }
    );
  }

  return parts.length > 0 ? parts : undefined;
}
