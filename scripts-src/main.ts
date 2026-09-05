import { system } from "@minecraft/server";
import { autoTerminalBlockComponent } from "./autoTerminalBlock";
import { controllerBlockComponent } from "./controllerBlock";
import { reconcileAllRemoteAccessChunkLoading } from "./controllerAxes";
import { inventoryTerminalBlockComponent } from "./inventoryTerminalBlock";
import { startItemDescriptionWatcher } from "./itemDescriptions";
import { networkObserverBlockComponent } from "./networkObserverBlock";
import { startNetworkProcessingLoop } from "./networkProcessing";
import { precisionTerminalBlockComponent } from "./precisionTerminalBlock";
import { deliveryTerminalBlockComponent } from "./deliveryTerminalBlock";
import { startDeliveryProgressLoop } from "./deliveryProgress";
import { ioPadBlockComponent } from "./ioPadBlock";
import { startPadProgressLoop } from "./ioPadProgress";
import { liquidPumpBlockComponent } from "./liquidPumpBlock";
import { remoteDeliveryTerminalItemComponent } from "./remoteDeliveryTerminalItem";
import { registerStorageBreakWatcher } from "./storageLifecycle";
import { suctionPadBlockComponent } from "./suctionPadBlock";
import { testFillerItemComponent } from "./testFiller";
import { terminalBlockComponent } from "./terminalBlock";
import { upgradeKitItemComponent } from "./upgradeKit";
import { registerWrenchPlayerLeaveWatcher, startWrenchHighlightLoop, wrenchItemComponent } from "./wrench";

system.beforeEvents.startup.subscribe(({ blockComponentRegistry, itemComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent("wh:controller", controllerBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:terminal", terminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:auto_terminal", autoTerminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:inventory_terminal", inventoryTerminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:precision_terminal", precisionTerminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:network_observer", networkObserverBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:delivery_terminal", deliveryTerminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:io_pad", ioPadBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:suction_pad", suctionPadBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:liquid_pump", liquidPumpBlockComponent);
  itemComponentRegistry.registerCustomComponent("wh:wrench", wrenchItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:test_filler", testFillerItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:upgrade_kit", upgradeKitItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:remote_delivery_terminal", remoteDeliveryTerminalItemComponent);
});

registerStorageBreakWatcher();
registerWrenchPlayerLeaveWatcher();
// 自動端末/在庫管理ターミナル/精密ターミナル/搬入出パッドの定期チェックループは、25章の
// 広告モデルへの移行により、startNetworkProcessingLoop(processNetworkOrders/
// processNetworkDeposits)に統合された。専用のstartXCheckLoopは廃止した。
startNetworkProcessingLoop();
startWrenchHighlightLoop();
startDeliveryProgressLoop();
startPadProgressLoop();
startItemDescriptionWatcher();
// world.tickingAreaManagerはこのスクリプト読み込み直後のタイミングでは呼べないため
// (restricted-execution mode)、system.runで次tickまで遅らせる。「リモート操作」アップグレードを
// 装着済みのコントローラのticking areaを、ワールド再読み込み後も正しい状態へ収束させる自己修復
// (controllerAxes.ts参照)。
system.run(() => reconcileAllRemoteAccessChunkLoading());
