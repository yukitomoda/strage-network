import { BlockCustomComponent } from "@minecraft/server";
import { showInventoryTerminalUi } from "./inventoryTerminalUi";
import { generateInventoryTerminalName } from "./state";
import { ensureSettingsEntity, setTerminalName } from "./terminalSettings";
import { INVENTORY_TERMINAL_BLOCK_ID, teardownTerminal } from "./terminalBlock";

export const INVENTORY_TERMINAL_COMPONENT_ID = INVENTORY_TERMINAL_BLOCK_ID;

export const inventoryTerminalBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    ensureSettingsEntity(dimension, block.location);
    setTerminalName(dimension, block.location, generateInventoryTerminalName());
  },
  onPlayerBreak(event) {
    teardownTerminal(event.dimension, event.block.location);
  },
  onPlayerInteract(event) {
    const player = event.player;
    const block = event.block;
    if (!player) return;
    showInventoryTerminalUi(player, block);
  },
};
