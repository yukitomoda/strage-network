import { Block, BlockPermutation, Dimension, ItemStack, Player, Vector3 } from "@minecraft/server";

// ブロック種別に依存しない、汎用の「アップグレード軸」抽象。1つのブロックが複数の軸を独立に
// 持てる(例: コントローラの「速度」と将来の「範囲」)。docs/design.md 4章参照。
export type UpgradeAxis = {
  id: string; // "controller_speed" のような内部識別子(ログ・デバッグ用)
  label: string; // UI/メッセージ表示用の日本語名("速度"等)
  blockTypeId: string; // このアップグレードが有効なブロックのtypeId
  stateKey: string; // このブロックが持つカスタムブロックステート名(例: "wh:speed_tier")
  kitItemIds: string[]; // index i の要素 = Tier i+1 に直接設定するキットのアイテムtypeId(飛び級可、upgradeKit.ts参照)
  // Tier変更(setAxisTier)直後に呼ばれる、軸固有の追加処理(任意)。範囲軸のように
  // 「Tierダウンで範囲外になったメンバーを自動切断する」といった副作用が必要な軸だけが
  // 指定する。呼び出し元はupgradeKit.tsのキット使用時とcontrollerUi.tsの取り出しボタン。
  onTierChanged?: (dimension: Dimension, block: Block, player?: Player) => void;
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

// 破壊/排出時、そのブロックに装着されていたキットを返す(軸に依存しない共通処理)。
// キットはどのTierのものでも直接1個だけ装着する方式(upgradeKit.ts参照)になったため、
// 返すのも装着されていたTierに対応するキット1個だけでよい(以前は0〜Tierの累積で
// 複数個返していたが、飛び級運用に合わせて廃止した)。Tierという「装着した状態」自体は
// 失われるが(design.md参照)、消費した素材は無駄にならないようにする。playerが分かる場合は
// まずインベントリへ直接渡し、入りきらなかった分(と、playerが分からない場合の全量)だけを
// プレイヤーの足元(分からない場合はlocation=ブロック付近)にドロップする。
export function giveOrDropKits(
  dimension: Dimension,
  location: Vector3,
  axis: UpgradeAxis,
  tier: number,
  player?: Player
): void {
  if (tier <= 0) return;

  const inventory = player?.getComponent("inventory")?.container;
  const dropLocation = player?.location ?? location;
  const stack = new ItemStack(axis.kitItemIds[tier - 1], 1);
  const leftover = inventory?.addItem(stack);
  if (!inventory || leftover) {
    dimension.spawnItem(leftover ?? stack, dropLocation);
  }
}
