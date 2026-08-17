import { system } from "@minecraft/server";
import { autoTerminalBlockComponent } from "./autoTerminalBlock";
import { startAutoTerminalCheckLoop } from "./autoOrderCheck";
import { testChestScreenBlockComponent, testChestScreenItemComponent } from "./chestScreenPoc";
import { controllerBlockComponent } from "./controllerBlock";
import { startInventoryTerminalCheckLoop } from "./inventoryCheck";
import { inventoryTerminalBlockComponent } from "./inventoryTerminalBlock";
import { startNetworkProcessingLoop } from "./networkProcessing";
import { startOrderClickPocLoop, testOrderClickItemComponent } from "./orderClickPoc";
import { registerStorageBreakWatcher } from "./storageLifecycle";
import { testFillerItemComponent } from "./testFiller";
import { terminalBlockComponent } from "./terminalBlock";
import { registerWrenchPlayerLeaveWatcher, startWrenchHighlightLoop, wrenchItemComponent } from "./wrench";

system.beforeEvents.startup.subscribe(({ blockComponentRegistry, itemComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent("wh:controller", controllerBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:terminal", terminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:auto_terminal", autoTerminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:inventory_terminal", inventoryTerminalBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:test_chest_screen_block", testChestScreenBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:test_chest_screen_terminal_block", testChestScreenBlockComponent);
  itemComponentRegistry.registerCustomComponent("wh:wrench", wrenchItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:test_filler", testFillerItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:test_chest_screen", testChestScreenItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:test_order_click", testOrderClickItemComponent);
});

registerStorageBreakWatcher();
registerWrenchPlayerLeaveWatcher();
startNetworkProcessingLoop();
startWrenchHighlightLoop();
startAutoTerminalCheckLoop();
startInventoryTerminalCheckLoop();
startOrderClickPocLoop();
