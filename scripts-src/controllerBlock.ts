import { BlockCustomComponent } from "@minecraft/server";
import { createNetwork, destroyNetwork, findNetworkByController } from "./network";

export const CONTROLLER_BLOCK_ID = "wh:controller";
export const CONTROLLER_COMPONENT_ID = "wh:controller";

export const controllerBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    createNetwork(dimension.id, { x: block.location.x, y: block.location.y, z: block.location.z });
  },
  onPlayerBreak(event) {
    const { block, dimension, player } = event;
    const network = findNetworkByController(dimension.id, block.location);
    if (!network) return;
    destroyNetwork(network.id);
    player?.sendMessage("§e倉庫ネットワークを解体しました。");
  },
};
