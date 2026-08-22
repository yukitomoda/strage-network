import { Block, BlockCustomComponent, Dimension, Vector3 } from "@minecraft/server";
import { findMembership, removeTerminal } from "./network";
import { generateTerminalName } from "./state";
import { ensureSettingsEntity, removeSettingsEntity, setTerminalName } from "./terminalSettings";
import { showOrderUi } from "./terminalUi";

export const TERMINAL_BLOCK_ID = "wh:terminal";
export const TERMINAL_COMPONENT_ID = "wh:terminal";
export const AUTO_TERMINAL_BLOCK_ID = "wh:auto_terminal";
export const INVENTORY_TERMINAL_BLOCK_ID = "wh:inventory_terminal";
export const PRECISION_TERMINAL_BLOCK_ID = "wh:precision_terminal";

// 引き出し・預け入れキュー処理、レンチでの接続対象など、「ターミナルとして扱ってよいブロックか」の判定を
// 一箇所にまとめる。通常のターミナル・自動端末・在庫管理ターミナル・精密ターミナルのいずれも対象。
export function isTerminalLikeBlock(typeId: string): boolean {
  return (
    typeId === TERMINAL_BLOCK_ID ||
    typeId === AUTO_TERMINAL_BLOCK_ID ||
    typeId === INVENTORY_TERMINAL_BLOCK_ID ||
    typeId === PRECISION_TERMINAL_BLOCK_ID
  );
}

// onPlayerBreak の共通処理(設定エンティティの削除+ネットワークからの除去)。
// 通常のターミナル/自動端末の両方から呼ばれる。
export function teardownTerminal(dimension: Dimension, loc: Vector3): void {
  removeSettingsEntity(dimension, loc);
  const membership = findMembership(dimension.id, loc);
  if (membership && membership.role === "terminal") {
    removeTerminal(membership.network.id, loc);
  }
}

const FACING_STATE = "minecraft:block_face";

// minecraft:placement_position トレイト(enabled_states: minecraft:block_face)により、
// 「クリックした面」がそのままステートの値になる(例: 隣接ブロックの南面をクリックしたら'south'。
// 上面/底面も含めた6方向に対応)。搬入先(支持ブロック)はクリックした面の逆側にある。
// 見た目の回転(BP側permutations)も同じステートを見ているため、表示とロジックが食い違わない。
// 設置時にチェストが存在している必要はなく、引き出し処理のたびに動的に搬入先を確認する
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

// ターミナル自身がレッドストーン通電中かどうか。
// 当初は張り付いた先の実コンテナ(チェスト等)で受信する設計だったが、
// Block.getRedstonePower()は通常のコンテナブロックでは値が定義されない(実機で確認済み)ため、
// minecraft:redstone_consumerを持つターミナル自身の位置で受信する方式に変更した(docs/design.md参照)。
export function isRedstoneLocked(block: Block): boolean {
  return (block.getRedstonePower() ?? 0) > 0;
}

export const terminalBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    ensureSettingsEntity(dimension, block.location);
    // 設定タブでいつでも変えられる前提の、区別のためだけのデフォルト名。
    setTerminalName(dimension, block.location, generateTerminalName());
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
