import { ItemCustomComponent, Player, system, world } from "@minecraft/server";
import {
  findAdjacentConnectedStorage,
  findNetworkByController,
  getAllNetworks,
  getNetwork,
  toggleStorage,
  toggleTerminal,
} from "./network";
import { locEquals } from "./state";

const EDITING_NETWORK_PROPERTY = "wh:editing_network";
const HIGHLIGHT_INTERVAL = 10;

function getEditingNetworkId(player: Player): string | undefined {
  const value = player.getDynamicProperty(EDITING_NETWORK_PROPERTY);
  return typeof value === "string" ? value : undefined;
}

function setEditingNetworkId(player: Player, networkId: string | undefined): void {
  player.setDynamicProperty(EDITING_NETWORK_PROPERTY, networkId);
}

export const wrenchItemComponent: ItemCustomComponent = {
  onUseOn(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;

    const block = event.block;
    const dimension = block.dimension;

    if (block.typeId === "wh:controller") {
      if (player.isSneaking) {
        if (getEditingNetworkId(player) !== undefined) {
          setEditingNetworkId(player, undefined);
          player.sendMessage("§e倉庫ネットワーク構築モードを終了しました。");
        }
        return;
      }

      const network = findNetworkByController(dimension.id, block.location);
      if (!network) {
        player.sendMessage("§cこのコントローラのネットワーク情報が見つかりません。");
        return;
      }
      setEditingNetworkId(player, network.id);
      player.sendMessage("§b倉庫ネットワーク構築モードを開始しました。ストレージ/ターミナルを右クリックして接続してください。");
      return;
    }

    const editingNetworkId = getEditingNetworkId(player);
    if (editingNetworkId === undefined) {
      player.sendMessage("§cまずコントローラを右クリックして構築モードを開始してください。");
      return;
    }

    if (block.typeId === "wh:terminal") {
      const result = toggleTerminal(editingNetworkId, block.location);
      player.sendMessage(result === "connected" ? "§bターミナルを接続しました。" : "§eターミナルを切断しました。");
      return;
    }

    if (block.getComponent("inventory")?.container) {
      const network = getNetwork(editingNetworkId);
      const alreadyConnected = network?.storages.some((s) => locEquals(s, block.location));
      if (network && !alreadyConnected) {
        const paired = findAdjacentConnectedStorage(dimension, network, block.location);
        if (paired) {
          player.sendMessage(
            "§c隣接するチェストと中身を共有しているため、既にネットワークに含まれています(二重登録を防止しました)。"
          );
          return;
        }
      }

      const result = toggleStorage(editingNetworkId, block.location);
      player.sendMessage(result === "connected" ? "§bストレージを接続しました。" : "§eストレージを切断しました。");
      return;
    }

    player.sendMessage("§cこのブロックは接続できません(コンテナを持つブロックのみ接続可能です)。");
  },
};

// 構築モード中のプレイヤーに、接続済みブロックの位置をパーティクルで示す簡易ハイライト。
export function startWrenchHighlightLoop(): void {
  system.runInterval(() => {
    for (const player of world.getPlayers()) {
      const networkId = getEditingNetworkId(player);
      if (networkId === undefined) continue;

      const network = getAllNetworks().find((n) => n.id === networkId);
      if (!network) continue;

      const dimension = world.getDimension(network.dimensionId);
      const points = [network.controller, ...network.storages, ...network.terminals];
      for (const p of points) {
        try {
          dimension.spawnParticle("minecraft:villager_happy", { x: p.x + 0.5, y: p.y + 1.2, z: p.z + 0.5 });
        } catch {
          // チャンク未読み込み等は無視
        }
      }
    }
  }, HIGHLIGHT_INTERVAL);
}
