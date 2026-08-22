import { BlockCustomComponent, Dimension, Vector3 } from "@minecraft/server";
import { findMembership, removeObserver } from "./network";
import { removeSettingsEntity } from "./observerSettings";
import { showObserverUi } from "./observerUi";

export const NETWORK_OBSERVER_BLOCK_ID = "wh:network_observer";
export const NETWORK_OBSERVER_COMPONENT_ID = "wh:network_observer";

// terminalBlock.tsのteardownTerminalと同じ発想(設定エンティティの削除+ネットワークからの除去)。
function teardownObserver(dimension: Dimension, loc: Vector3): void {
  removeSettingsEntity(dimension, loc);
  const membership = findMembership(dimension.id, loc);
  if (membership && membership.role === "observer") {
    removeObserver(membership.network.id, loc);
  }
}

export const networkObserverBlockComponent: BlockCustomComponent = {
  // ネットワークへの参加は倉庫レンチでの接続時(wrench.ts)に行うため、設置時は何もしない。
  onPlayerBreak(event) {
    teardownObserver(event.dimension, event.block.location);
  },
  onPlayerInteract(event) {
    const player = event.player;
    if (!player) return;
    showObserverUi(player, event.block);
  },
};
