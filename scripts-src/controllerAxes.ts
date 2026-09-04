import { Block, Dimension, Player, world } from "@minecraft/server";
import {
  findNetworkByController,
  findPhysicalStoragePair,
  getAllNetworks,
  pruneOutOfRangeMembers,
} from "./network";
import { resetObserverSignal } from "./networkObserverProcessing";
import { removeSettingsEntity as removeObserverSettingsEntity } from "./observerSettings";
import { syncTickingAreaForNetwork } from "./remoteAccessChunkLoading";
import { removeSettingsEntity as removeStorageSettingsEntity } from "./storageSettings";
import { getAxisTier, UpgradeAxis } from "./upgrade";

// controllerBlock.ts/controllerUi.tsとorderProcessing.ts等の処理モジュールは互いに依存し合う
// 関係にある(controllerBlock.ts -> controllerUi.ts -> orderProcessing.ts等)ため、コントローラの
// アップグレード軸の定義だけはどこからも安全にimportできる末端モジュールとして切り出している
// (処理モジュール側からcontrollerBlock.tsを直接importすると循環importになってしまう)。
export const CONTROLLER_BLOCK_ID = "wh:controller";

// コントローラの「速度」アップグレード軸(引き出し/預け入れ/整理のスループット)。
// 新しい軸を追加する場合は、同じ形でUpgradeAxisを定義しCONTROLLER_AXESに加える
// (docs/design.md 4章「グレード管理」参照。upgrade.ts自体は変更不要)。
export const CONTROLLER_SPEED_AXIS: UpgradeAxis = {
  id: "controller_speed",
  label: "速度",
  blockTypeId: CONTROLLER_BLOCK_ID,
  stateKey: "wh:speed_tier",
  kitItemIds: ["wh:speed_kit_tier1", "wh:speed_kit_tier2", "wh:speed_kit_tier3", "wh:speed_kit_tier4"],
};

// コントローラの「周期」アップグレード軸(処理サイクル1回あたりのtick数。値が小さいほど
// サイクルの間隔が短くなり=速くなる)。テーブル本体はnetworkProcessing.tsが持つ
// (実際の処理ループを回しているのがそこのため)。
export const CONTROLLER_CYCLE_AXIS: UpgradeAxis = {
  id: "controller_cycle",
  label: "周期",
  blockTypeId: CONTROLLER_BLOCK_ID,
  stateKey: "wh:cycle_tier",
  kitItemIds: ["wh:cycle_kit_tier1", "wh:cycle_kit_tier2", "wh:cycle_kit_tier3", "wh:cycle_kit_tier4"],
};

// コントローラの「範囲」アップグレード軸(接続可能な立方体の半径、ブロック数)。
// tools/generate-placeholder-icon.mjsは関与しない。BP/entities/range_wall.json・
// range_ceiling.jsonのcomponent_groupsのscale値にもこのテーブルと同じ計算結果((値+0.5)/8.5)が
// 手動で複製されているため、値を変える場合は両方を更新する必要がある(docs/design.md参照)。
const RANGE_TABLE = [4, 6, 9, 12, 16]; // index = tier

export function getRangeForTier(tier: number): number {
  return RANGE_TABLE[tier] ?? RANGE_TABLE[0];
}

// 範囲軸だけが持つ副作用: Tierが変わった直後、その時点のネットワークの接続先のうち
// 新しい範囲の外に出てしまったものを自動的に切断する。「切断は範囲外でも常に許可する
// (遡って強制切断はしない)」という他の箇所の一般方針(network.tsのisWithinNetworkRange
// 参照)に対する意図的な例外(docs/design.md 3章参照)。Tierが上がる場合もこの処理を
// 素通りさせる(範囲外に出るメンバーは存在しないため無害)ことで、増減を区別する
// 分岐を省いている。
function pruneRangeAxisMembers(dimension: Dimension, block: Block, player?: Player): void {
  const network = findNetworkByController(dimension.id, block.location);
  if (!network) return;

  const tier = getAxisTier(dimension, block.location, CONTROLLER_RANGE_AXIS);
  const range = getRangeForTier(tier);
  const { removedStorages, removedTerminals, removedObservers } = pruneOutOfRangeMembers(network.id, range);

  // ストレージ・オブザーバーは手動切断(wrench.ts)と同じく設定エンティティも掃除する。
  // ターミナルは手動切断でも掃除していないため、ここでも揃えて何もしない。
  for (const loc of removedStorages) {
    removeStorageSettingsEntity(dimension, loc);
    const pair = findPhysicalStoragePair(dimension, loc);
    if (pair) removeStorageSettingsEntity(dimension, pair);
  }
  for (const loc of removedObservers) {
    removeObserverSettingsEntity(dimension, loc);
    resetObserverSignal(dimension, loc);
  }

  if (removedStorages.length > 0 || removedTerminals.length > 0 || removedObservers.length > 0) {
    player?.sendMessage(
      `§e範囲が縮小したため、ストレージ${removedStorages.length}台・ターミナル${removedTerminals.length}台・オブザーバー${removedObservers.length}台の接続が解除されました。`
    );
  }
}

export const CONTROLLER_RANGE_AXIS: UpgradeAxis = {
  id: "controller_range",
  label: "範囲",
  blockTypeId: CONTROLLER_BLOCK_ID,
  stateKey: "wh:range_tier",
  kitItemIds: ["wh:range_kit_tier1", "wh:range_kit_tier2", "wh:range_kit_tier3", "wh:range_kit_tier4"],
  onTierChanged: pruneRangeAxisMembers,
};

// コントローラの「リモート操作」アップグレード軸(リモート配達ターミナル(アイテム)を
// コントローラからどれだけ離れて使えるか。remoteDeliveryTerminalItem.ts/Ui.ts参照)。
// 「距離」と「別ディメンションからの使用可否」は独立した軸内パラメータとして持つ(T3は
// 同一ディメンション内は距離無制限、T4はそれに加えて別ディメンションからも使える。
// ユーザー要望による変更)。distance: Infinityは、network.tsのisWithinNetworkRange
// (各軸Math.abs(...) <= rangeの単純比較)にそのまま渡せば「常に範囲内」として機能するため
// 特別扱いしていない。crossDimension: trueのTierでは、そもそも別ディメンションだと座標の
// 比較自体が無意味なため、距離チェック自体を行わない(呼び出し元のremoteDeliveryTerminalItem.ts
// のcheckRemoteDeliveryAccess参照)。
interface RemoteAccessTierConfig {
  distance: number;
  crossDimension: boolean;
}

const REMOTE_ACCESS_TABLE: RemoteAccessTierConfig[] = [
  { distance: 32, crossDimension: false }, // tier0(未装着時の現状維持)
  { distance: 64, crossDimension: false }, // tier1
  { distance: 256, crossDimension: false }, // tier2
  { distance: Infinity, crossDimension: false }, // tier3: 同一ディメンション内どこでも
  { distance: Infinity, crossDimension: true }, // tier4: 異なるディメンションを含めどこでも
];

function remoteAccessConfigForTier(tier: number): RemoteAccessTierConfig {
  return REMOTE_ACCESS_TABLE[tier] ?? REMOTE_ACCESS_TABLE[0];
}

export function getRemoteAccessRangeForTier(tier: number): number {
  return remoteAccessConfigForTier(tier).distance;
}

export function getRemoteAccessCrossDimensionForTier(tier: number): boolean {
  return remoteAccessConfigForTier(tier).crossDimension;
}

// distanceがInfinityの場合、そのまま数値表示せず専用の文言に置き換える(itemDescriptions.ts/
// controllerUi.tsで表示形式を揃えるための共通ヘルパー)。crossDimensionの有無でT3/T4の文言を
// 分ける。
export function formatRemoteAccessDistance(tier: number): string {
  const config = remoteAccessConfigForTier(tier);
  if (Number.isFinite(config.distance)) return `${config.distance}`;
  return config.crossDimension ? "どこでも" : "同一ディメンション内";
}

// リモート操作軸だけが持つ副作用: Tierが1以上になったらコントローラ周辺のticking areaを
// 作成し、0に戻ったら削除する(remoteAccessChunkLoading.ts参照)。
function syncRemoteAccessChunkLoading(dimension: Dimension, block: Block): void {
  const network = findNetworkByController(dimension.id, block.location);
  if (!network) return;
  const tier = getAxisTier(dimension, block.location, CONTROLLER_REMOTE_ACCESS_AXIS);
  syncTickingAreaForNetwork(dimension, network, tier >= 1);
}

export const CONTROLLER_REMOTE_ACCESS_AXIS: UpgradeAxis = {
  id: "controller_remote_access",
  label: "リモート操作",
  blockTypeId: CONTROLLER_BLOCK_ID,
  stateKey: "wh:remote_access_tier",
  kitItemIds: [
    "wh:remote_access_kit_tier1",
    "wh:remote_access_kit_tier2",
    "wh:remote_access_kit_tier3",
    "wh:remote_access_kit_tier4",
  ],
  onTierChanged: syncRemoteAccessChunkLoading,
};

// コントローラが持つ全アップグレード軸。upgradeKit.tsのアイテム対応表・controllerBlock.tsの
// onPlayerBreakのドロップ処理・controllerUi.tsのアップグレードタブ表示はここを見て軸ごとに
// 処理するので、軸を増やす時はこの配列に加えるだけでよい。
export const CONTROLLER_AXES: UpgradeAxis[] = [
  CONTROLLER_SPEED_AXIS,
  CONTROLLER_CYCLE_AXIS,
  CONTROLLER_RANGE_AXIS,
  CONTROLLER_REMOTE_ACCESS_AXIS,
];

// ワールド起動時に1回呼ぶ自己修復(main.ts参照)。ticking areaがワールド再読み込みをまたいで
// 残るか不確実なため、全ネットワークを走査し「リモート操作Tier1以上ならticking areaがある」
// という状態に収束させる。Tier変更時はonTierChanged(syncRemoteAccessChunkLoading)で即座に
// 反映されるため、この関数はここでしか呼ばない(毎tickの定期実行はしない)。
export function reconcileAllRemoteAccessChunkLoading(): void {
  for (const network of getAllNetworks()) {
    const dimension = world.getDimension(network.dimensionId);
    const tier = getAxisTier(dimension, network.controller, CONTROLLER_REMOTE_ACCESS_AXIS);
    syncTickingAreaForNetwork(dimension, network, tier >= 1);
  }
}
