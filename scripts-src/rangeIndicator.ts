import { Dimension, Entity, Vector3 } from "@minecraft/server";
import { CONTROLLER_RANGE_AXIS, getRangeForTier } from "./controllerAxes";
import { NetworkData } from "./state";
import { getAxisTier } from "./upgrade";

// ネットワーク編集中に、接続可能な立方体の範囲(コントローラ中心、半径は範囲アップグレード軸の
// 現在Tierに応じて可変)を半透明の板(壁4枚+天面/底面)で可視化する。パーティクルの点の集合で
// 近似するより、非表示エンティティ+専用ジオメトリ+半透明マテリアル(entity_alphablend)の
// 組み合わせの方が塗りつぶした面として自然に見え、点数を気にする必要も無い。
const WALL_ENTITY_TYPE = "wh:range_wall";
const CEILING_ENTITY_TYPE = "wh:range_ceiling";
const OWNER_NETWORK_PROPERTY = "wh:owner_network";
// スポーン時に使ったTierを記録しておき、コントローラの現在Tierとずれていたら
// (=編集中にキットを付け替えた等)再スポーンで表示を追従させる(syncRangeIndicator参照)。
const OWNER_TIER_PROPERTY = "wh:owner_tier";

// isWithinNetworkRangeは「コントローラからブロック座標で範囲以内」を接続可能とする
// (=controller.x+範囲のブロックまで含む)。そのブロック自体を境界の内側として塗りつぶすには、
// 壁をそのブロックの外側の面(コントローラ中心から範囲+0.5マス)に置く必要がある。当初は+0.5を
// 付けずコントローラ中心からちょうど範囲の位置(=ブロックの真ん中)に壁を置いてしまい、境界の
// ブロックが壁で分断されて見える不具合があった(実機で発見・修正)。
function rangeEdgeBlocks(tier: number): number {
  return getRangeForTier(tier) + 0.5;
}

function centerOf(loc: Vector3): Vector3 {
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

// Tierに関わらず既存のインジケータを検索できるよう、最大Tierの境界距離を基準に
// 十分広く検索する(検索自体はTierを問わず「このネットワークが所有する全インジケータ」を
// 見つけるためのものなので、実際の表示サイズより広めであれば問題ない)。
const MAX_SEARCH_DISTANCE = rangeEdgeBlocks(4) + 2;

// 壁4枚はコントローラ中心と同じ座標にスポーンし、ジオメトリ側でrangeEdgeBlocks(tier)先に
// 描画したものをYaw 0/90/180/270で回転させて4方向をカバーする(ジオメトリの詳細は
// RP/models/entity/range_wall.geo.json参照。実際の表示サイズはBP/entities/range_wall.jsonの
// Tierごとのcomponent_groups(minecraft:scale)で調整する)。天面/底面はジオメトリがY=0を
// 中心とした薄い板なので、代わりにスポーン位置のYそのものを±rangeEdgeBlocks(tier)ずらして
// 表現する。
function findIndicatorEntities(dimension: Dimension, network: NetworkData): Entity[] {
  const center = centerOf(network.controller);
  const candidates = [
    ...dimension.getEntities({ type: WALL_ENTITY_TYPE, location: center, maxDistance: MAX_SEARCH_DISTANCE }),
    ...dimension.getEntities({ type: CEILING_ENTITY_TYPE, location: center, maxDistance: MAX_SEARCH_DISTANCE }),
  ];
  return candidates.filter((e) => e.getDynamicProperty(OWNER_NETWORK_PROPERTY) === network.id);
}

function spawnIndicators(dimension: Dimension, network: NetworkData, tier: number): void {
  const center = centerOf(network.controller);
  const edge = rangeEdgeBlocks(tier);

  for (const yaw of [0, 90, 180, 270]) {
    // spawnEntity後にentity.setRotation()で回転させると、回転が反映されるまでの1〜2フレーム
    // だけYaw0(未回転)の位置で描画され、そこから正しい位置へ「移動する」ように見えてしまう
    // (実機で発見)。SpawnEntityOptions.initialRotationでスポーンと同時に回転を指定することで、
    // 常に最初から正しい向きで描画されるようにした。
    const entity = dimension.spawnEntity(WALL_ENTITY_TYPE, center, { initialRotation: yaw });
    entity.setDynamicProperty(OWNER_NETWORK_PROPERTY, network.id);
    entity.setDynamicProperty(OWNER_TIER_PROPERTY, tier);
    // Tierごとの表示サイズはBP側のcomponent_groups(minecraft:scale)で切り替える。回転と同様、
    // スポーン直後のtriggerEventでは反映まで1〜2フレームだけ既定スケール(等倍)で描画される
    // 可能性があるが、半透明の一時的なインジケータであり実害は軽微なため許容する。
    entity.triggerEvent(`wh:set_range_tier${tier}`);
  }

  for (const dy of [edge, -edge]) {
    const entity = dimension.spawnEntity(CEILING_ENTITY_TYPE, { x: center.x, y: center.y + dy, z: center.z });
    entity.setDynamicProperty(OWNER_NETWORK_PROPERTY, network.id);
    entity.setDynamicProperty(OWNER_TIER_PROPERTY, tier);
    entity.triggerEvent(`wh:set_range_tier${tier}`);
  }
}

// 「表示されているべきか」を都度再計算して実際の状態と一致させる(参照カウント等は持たない)。
// 複数人が同じネットワークを同時編集していても、誰か1人でも編集中ならshouldShow=trueに
// なるよう呼び出し元がisAnyoneEditingNetworkで判定してから渡す。
//
// (実機で発見された不具合の修正済み) 編集開始/終了イベントの発火時にだけ同期していたが、
// 編集セッション中にログアウト(特にシングルプレイでのワールド終了)すると、beforeEvents.
// playerLeave内での後片付けが間に合わない/実行されないケースがあり、壁が残ってしまう
// ことがあった。この関数自体は「今の状態を見て合わせる」だけなので、呼び出し元
// (wrench.tsのreconcileAllRangeIndicators)が定期的に全ネットワーク分呼び直すことで、
// 個々のイベント処理が失敗しても数百ms〜数秒以内に自己修復するようにしている。
//
// 範囲アップグレード軸のTierが変わった場合も、この同じ定期実行に乗せて追従させる:
// 表示中のインジケータのTier(wh:owner_tier)がコントローラの現在Tierと一致しなければ、
// 一旦削除して現在Tierで再スポーンする(編集セッション中の要求「範囲表示が更新されること」を、
// 新たな即時同期を追加せず既存の都度収束の仕組みだけで満たす)。
export function syncRangeIndicator(dimension: Dimension, network: NetworkData, shouldShow: boolean): void {
  const existing = findIndicatorEntities(dimension, network);
  const currentTier = getAxisTier(dimension, network.controller, CONTROLLER_RANGE_AXIS);

  if (shouldShow) {
    const stale = existing.some((e) => e.getDynamicProperty(OWNER_TIER_PROPERTY) !== currentTier);
    if (existing.length > 0 && !stale) return; // 既に表示中かつTierも一致
    for (const entity of existing) entity.remove();
    spawnIndicators(dimension, network, currentTier);
  } else {
    for (const entity of existing) entity.remove();
  }
}
