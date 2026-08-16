import { BlockCustomComponent } from "@minecraft/server";
import { removeSettingsEntity } from "./controllerSettings";
import { showControllerUi } from "./controllerUi";
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
    removeSettingsEntity(dimension, block.location);
    player?.sendMessage("§e倉庫ネットワークを解体しました。");
  },
  onPlayerInteract(event) {
    // レンチでの右クリック(構築モードの開始/終了)は wrench.ts 側の ItemCustomComponent.onUseOn
    // が別途処理する。ここは素手等でのUI呼び出しのみを担当する。
    const player = event.player;
    if (!player) return;
    showControllerUi(player, event.block);
  },
};
