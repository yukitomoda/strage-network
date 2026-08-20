import { BlockCustomComponent } from "@minecraft/server";
import { generatePrecisionTerminalName } from "./state";
import { ensureSettingsEntity, setTerminalName } from "./terminalSettings";
import { PRECISION_TERMINAL_BLOCK_ID, teardownTerminal } from "./terminalBlock";
import { showPrecisionTerminalUi } from "./precisionTerminalUi";

export const PRECISION_TERMINAL_COMPONENT_ID = PRECISION_TERMINAL_BLOCK_ID;

export const precisionTerminalBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    ensureSettingsEntity(dimension, block.location);
    setTerminalName(dimension, block.location, generatePrecisionTerminalName());
  },
  onPlayerBreak(event) {
    teardownTerminal(event.dimension, event.block.location);
  },
  onPlayerInteract(event) {
    const player = event.player;
    const block = event.block;
    if (!player) return;
    showPrecisionTerminalUi(player, block);
  },
};
