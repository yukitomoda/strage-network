import { BlockCustomComponent } from "@minecraft/server";
import { generateAutoTerminalName } from "./state";
import { ensureSettingsEntity, setTerminalName } from "./terminalSettings";
import { AUTO_TERMINAL_BLOCK_ID, teardownTerminal } from "./terminalBlock";
import { showAutoTerminalUi } from "./autoTerminalUi";

export const AUTO_TERMINAL_COMPONENT_ID = AUTO_TERMINAL_BLOCK_ID;

export const autoTerminalBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    ensureSettingsEntity(dimension, block.location);
    setTerminalName(dimension, block.location, generateAutoTerminalName());
  },
  onPlayerBreak(event) {
    teardownTerminal(event.dimension, event.block.location);
  },
  onPlayerInteract(event) {
    const player = event.player;
    const block = event.block;
    if (!player) return;
    showAutoTerminalUi(player, block);
  },
};
