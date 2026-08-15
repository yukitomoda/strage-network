import { system } from "@minecraft/server";
import { controllerBlockComponent } from "./controllerBlock";
import { startNetworkProcessingLoop } from "./networkProcessing";
import { registerStorageBreakWatcher } from "./storageLifecycle";
import { testFillerItemComponent } from "./testFiller";
import { terminalBlockComponent } from "./terminalBlock";
import { startWrenchHighlightLoop, wrenchItemComponent } from "./wrench";

system.beforeEvents.startup.subscribe(({ blockComponentRegistry, itemComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent("wh:controller", controllerBlockComponent);
  blockComponentRegistry.registerCustomComponent("wh:terminal", terminalBlockComponent);
  itemComponentRegistry.registerCustomComponent("wh:wrench", wrenchItemComponent);
  itemComponentRegistry.registerCustomComponent("wh:test_filler", testFillerItemComponent);
});

registerStorageBreakWatcher();
startNetworkProcessingLoop();
startWrenchHighlightLoop();
