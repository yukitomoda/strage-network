import { system } from "@minecraft/server";
import { autoTerminalBlockComponent } from "./autoTerminalBlock";
import { startAutoTerminalCheckLoop } from "./autoOrderCheck";
import { controllerBlockComponent } from "./controllerBlock";
import { startInventoryTerminalCheckLoop } from "./inventoryCheck";
import { inventoryTerminalBlockComponent } from "./inventoryTerminalBlock";
import { startItemDescriptionWatcher } from "./itemDescriptions";
import { startNetworkProcessingLoop } from "./networkProcessing";
import { registerStorageBreakWatcher } from "./storageLifecycle";
import { testFillerItemComponent } from "./testFiller";
import { terminalBlockComponent } from "./terminalBlock";
import { upgradeKitItemComponent } from "./upgradeKit";
import { registerWrenchPlayerLeaveWatcher, startWrenchHighlightLoop, wrenchItemComponent } from "./wrench";

system.beforeEvents.startup.subscribe(({ blockComponentRegistry, itemComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent("wh:controller", controllerBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:terminal", terminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:auto_terminal", autoTerminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:inventory_terminal", inventoryTerminalBlockComponent);
  itemComponentRegistry.registerCustomComponent("wh:wrench", wrenchItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:test_filler", testFillerItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:upgrade_kit", upgradeKitItemComponent);
});

registerStorageBreakWatcher();
registerWrenchPlayerLeaveWatcher();
startNetworkProcessingLoop();
startWrenchHighlightLoop();
startAutoTerminalCheckLoop();
startInventoryTerminalCheckLoop();
startItemDescriptionWatcher();
