import { Block, BlockPermutation, Dimension, ItemStack, Player, Vector3 } from "@minecraft/server";

// ブロック種別に依存しない、汎用の「アップグレード軸」抽象。1つのブロックが複数の軸を独立に
// 持てる(例: コントローラの「速度」と将来の「範囲」)。docs/design.md 4章参照。
export type UpgradeAxis = {
  id: string; // "controller_speed" のような内部識別子(ログ・デバッグ用)
  label: string; // UI/メッセージ表示用の日本語名("速度"等)
  blockTypeId: string; // このアップグレードが有効なブロックのtypeId
  stateKey: string; // このブロックが持つカスタムブロックステート名(例: "wh:speed_tier")
  kitItemIds: string[]; // index i の要素 = Tier i -> i+1 に使うキットのアイテムtypeId
};

export function getAxisMaxTier(axis: UpgradeAxis): number {
  return axis.kitItemIds.length;
}

// BlockPermutation.getState/withStateの型はバニラの既知ステートのみを対象にしたジェネリックで、
// カスタムステート名(例: "wh:speed_tier")は型に存在しない。読み取りはgetAllStates()(型が緩く
// 安全)を使う。
function readTier(permutation: BlockPermutation, stateKey: string): number {
  const tier = permutation.getAllStates()[stateKey];
  return typeof tier === "number" ? tier : 0;
}

export function getAxisTier(dimension: Dimension, location: Vector3, axis: UpgradeAxis): number {
  const block = dimension.getBlock(location);
  if (!block?.isValid || block.typeId !== axis.blockTypeId) return 0;
  return readTier(block.permutation, axis.stateKey);
}

export function getAxisTierFromPermutation(permutation: BlockPermutation, axis: UpgradeAxis): number {
  return readTier(permutation, axis.stateKey);
}

// withStateの引数も同じ理由でカスタムステート名を型が受け付けないため、asでキャストする。
export function setAxisTier(block: Block, axis: UpgradeAxis, tier: number): void {
  block.setPermutation(block.permutation.withState(axis.stateKey as any, tier as any));
}

// 破壊/排出時、そのブロックが積んでいたTier分のキットを返す(軸に依存しない共通処理)。
// Tierという「積み上げた状態」自体は失われるが(design.md参照)、消費した素材は無駄にならない
// ようにする。playerが分かる場合はまずインベントリへ直接渡し、入りきらなかった分(と、playerが
// 分からない場合の全量)だけをlocationにその場でドロップする。
export function giveOrDropKits(
  dimension: Dimension,
  location: Vector3,
  axis: UpgradeAxis,
  tier: number,
  player?: Player
): void {
  const inventory = player?.getComponent("inventory")?.container;
  const dropLocation = player?.location ?? location;
  for (let t = 0; t < tier; t++) {
    const stack = new ItemStack(axis.kitItemIds[t], 1);
    const leftover = inventory?.addItem(stack);
    if (!inventory || leftover) {
      dimension.spawnItem(leftover ?? stack, dropLocation);
    }
  }
}
