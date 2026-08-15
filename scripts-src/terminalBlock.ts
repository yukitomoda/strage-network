import { Block, BlockCustomComponent, Vector3 } from "@minecraft/server";
import { findMembership, removeTerminal } from "./network";
import { showOrderUi } from "./terminalUi";

export const TERMINAL_BLOCK_ID = "wh:terminal";
export const TERMINAL_COMPONENT_ID = "wh:terminal";

const FACING_STATE = "minecraft:block_face";

// minecraft:placement_position トレイト(enabled_states: minecraft:block_face)により、
// 「クリックした面」がそのままステートの値になる(例: 隣接ブロックの南面をクリックしたら'south'。
// 上面/底面も含めた6方向に対応)。搬入先(支持ブロック)はクリックした面の逆側にある。
// 見た目の回転(BP側permutations)も同じステートを見ているため、表示とロジックが食い違わない。
// 設置時にチェストが存在している必要はなく、注文処理のたびに動的に搬入先を確認する
// (orderProcessing.ts側で既にその作りになっている)。
export function getAttachedStorageLocation(block: Block): Vector3 {
  const face = block.permutation.getAllStates()[FACING_STATE] as string | undefined;
  const loc = block.location;
  switch (face) {
    case "north":
      return { x: loc.x, y: loc.y, z: loc.z + 1 };
    case "south":
      return { x: loc.x, y: loc.y, z: loc.z - 1 };
    case "east":
      return { x: loc.x - 1, y: loc.y, z: loc.z };
    case "west":
      return { x: loc.x + 1, y: loc.y, z: loc.z };
    case "up":
      return { x: loc.x, y: loc.y - 1, z: loc.z };
    case "down":
      return { x: loc.x, y: loc.y + 1, z: loc.z };
    default:
      return { x: loc.x, y: loc.y, z: loc.z + 1 };
  }
}

export const terminalBlockComponent: BlockCustomComponent = {
  onPlayerBreak(event) {
    const { block, dimension } = event;
    const membership = findMembership(dimension.id, block.location);
    if (membership && membership.role === "terminal") {
      removeTerminal(membership.network.id, block.location);
    }
  },
  onPlayerInteract(event) {
    const player = event.player;
    const block = event.block;
    if (!player) return;
    showOrderUi(player, block);
  },
};
