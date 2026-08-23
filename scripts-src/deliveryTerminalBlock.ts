import { BlockCustomComponent } from "@minecraft/server";
import { generateDeliveryTerminalName } from "./state";
import { ensureSettingsEntity, setTerminalName } from "./terminalSettings";
import { DELIVERY_TERMINAL_BLOCK_ID, teardownTerminal } from "./terminalBlock";
import { showOrderUi } from "./terminalUi";

export const DELIVERY_TERMINAL_COMPONENT_ID = DELIVERY_TERMINAL_BLOCK_ID;

// UIは通常のターミナルと全く同じ(showOrderUi)。「注文したプレイヤーへ優先的に直接届ける」という
// 差別化点はUI側ではなく引き出し処理側(orderProcessing.ts)にある。
export const deliveryTerminalBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    ensureSettingsEntity(dimension, block.location);
    setTerminalName(dimension, block.location, generateDeliveryTerminalName());
  },
  onPlayerBreak(event) {
    teardownTerminal(event.dimension, event.block.location);
  },
  onPlayerInteract(event) {
    const player = event.player;
    const block = event.block;
    if (!player) return;
    showOrderUi(player, block);
  },
};
