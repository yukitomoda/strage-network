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
export const DELIVERY_TERMINAL_BLOCK_ID = "wh:delivery_terminal";
export const IO_PAD_BLOCK_ID = "wh:io_pad";
export const SUCTION_PAD_BLOCK_ID = "wh:suction_pad";

// 引き出し・預け入れキュー処理、レンチでの接続対象など、「ターミナルとして扱ってよいブロックか」の判定を
// 一箇所にまとめる。通常のターミナル・自動端末・在庫管理ターミナル・精密ターミナル・配達ターミナル・
// 搬入出パッド・吸い込みパッドのいずれも対象。
export function isTerminalLikeBlock(typeId: string): boolean {
  return (
    typeId === TERMINAL_BLOCK_ID ||
    typeId === AUTO_TERMINAL_BLOCK_ID ||
    typeId === INVENTORY_TERMINAL_BLOCK_ID ||
    typeId === PRECISION_TERMINAL_BLOCK_ID ||
    typeId === DELIVERY_TERMINAL_BLOCK_ID ||
    typeId === IO_PAD_BLOCK_ID ||
    typeId === SUCTION_PAD_BLOCK_ID
  );
}

// ターミナル系のうち、フルブロックではなく「張り付いた面に対して薄い板」の見た目を持つもの
// (通常ターミナル/自動端末/在庫管理ターミナル/精密ターミナル/配達ターミナル。搬入出パッド・
// 吸い込みパッドはフルブロックのため対象外)。memberHighlight.tsが、フルブロック用の立方体の
// 輪郭ではなく、張り付いている面1面分の枠だけを表示する対象を判定するのに使う(ユーザー要望)。
export function isThinTerminalBlock(typeId: string): boolean {
  return (
    typeId === TERMINAL_BLOCK_ID ||
    typeId === AUTO_TERMINAL_BLOCK_ID ||
    typeId === INVENTORY_TERMINAL_BLOCK_ID ||
    typeId === PRECISION_TERMINAL_BLOCK_ID ||
    typeId === DELIVERY_TERMINAL_BLOCK_ID
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

// minecraft:placement_position トレイト(enabled_states: minecraft:block_face)が持つ
// 「クリックした面」のステート値(例: 隣接ブロックの南面をクリックしたら'south'。上面/底面も
// 含めた6方向に対応)。getAttachedStorageLocationのほか、memberHighlight.tsが薄い板の
// ハイライトをどの面に表示するか決めるのにも使う。
export function getBlockFacing(block: Block): string | undefined {
  return block.permutation.getAllStates()[FACING_STATE] as string | undefined;
}

// 搬入先(支持ブロック)はクリックした面の逆側にある。見た目の回転(BP側permutations)も
// 同じステートを見ているため、表示とロジックが食い違わない。設置時にチェストが存在している
// 必要はなく、引き出し処理のたびに動的に搬入先を確認する(orderProcessing.ts側で既に
// その作りになっている)。
export function getAttachedStorageLocation(block: Block): Vector3 {
  const face = getBlockFacing(block);
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
