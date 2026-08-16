import { Dimension, Entity, Vector3 } from "@minecraft/server";
import { NETWORK_RANGE_BLOCKS } from "./network";
import { NetworkData } from "./state";

// ネットワーク編集中に、接続可能な立方体の範囲(コントローラ中心、半径NETWORK_RANGE_BLOCKS)を
// 半透明の板(壁4枚+天面/底面)で可視化する。パーティクルの点の集合で近似するより、
// 非表示エンティティ+専用ジオメトリ+半透明マテリアル(entity_alphablend)の組み合わせの方が
// 塗りつぶした面として自然に見え、点数を気にする必要も無い。
const WALL_ENTITY_TYPE = "wh:range_wall";
const CEILING_ENTITY_TYPE = "wh:range_ceiling";
const OWNER_NETWORK_PROPERTY = "wh:owner_network";

// isWithinNetworkRangeは「コントローラからブロック座標でNETWORK_RANGE_BLOCKS以内」を
// 接続可能とする(=controller.x+NETWORK_RANGE_BLOCKSのブロックまで含む)。そのブロック自体を
// 境界の内側として塗りつぶすには、壁をそのブロックの外側の面(コントローラ中心から
// NETWORK_RANGE_BLOCKS+0.5マス)に置く必要がある。当初は+0.5を付けずコントローラ中心から
// ちょうどNETWORK_RANGE_BLOCKSの位置(=ブロックの真ん中)に壁を置いてしまい、境界のブロックが
// 壁で分断されて見える不具合があった(実機で発見・修正)。
const RANGE_EDGE_BLOCKS = NETWORK_RANGE_BLOCKS + 0.5;

function centerOf(loc: Vector3): Vector3 {
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

// 壁4枚はコントローラ中心と同じ座標にスポーンし、ジオメトリ側でRANGE_EDGE_BLOCKS先に
// 描画したものをYaw 0/90/180/270で回転させて4方向をカバーする(ジオメトリの詳細は
// RP/models/entity/range_wall.geo.json参照)。天面/底面はジオメトリがY=0を中心とした薄い板
// なので、代わりにスポーン位置のYそのものを±RANGE_EDGE_BLOCKSずらして表現する。
function findIndicatorEntities(dimension: Dimension, network: NetworkData): Entity[] {
  const center = centerOf(network.controller);
  const candidates = [
    ...dimension.getEntities({ type: WALL_ENTITY_TYPE, location: center, maxDistance: RANGE_EDGE_BLOCKS + 2 }),
    ...dimension.getEntities({ type: CEILING_ENTITY_TYPE, location: center, maxDistance: RANGE_EDGE_BLOCKS + 2 }),
  ];
  return candidates.filter((e) => e.getDynamicProperty(OWNER_NETWORK_PROPERTY) === network.id);
}

function spawnIndicators(dimension: Dimension, network: NetworkData): void {
  const center = centerOf(network.controller);

  for (const yaw of [0, 90, 180, 270]) {
    // spawnEntity後にentity.setRotation()で回転させると、回転が反映されるまでの1〜2フレーム
    // だけYaw0(未回転)の位置で描画され、そこから正しい位置へ「移動する」ように見えてしまう
    // (実機で発見)。SpawnEntityOptions.initialRotationでスポーンと同時に回転を指定することで、
    // 常に最初から正しい向きで描画されるようにした。
    const entity = dimension.spawnEntity(WALL_ENTITY_TYPE, center, { initialRotation: yaw });
    entity.setDynamicProperty(OWNER_NETWORK_PROPERTY, network.id);
  }

  for (const dy of [RANGE_EDGE_BLOCKS, -RANGE_EDGE_BLOCKS]) {
    const entity = dimension.spawnEntity(CEILING_ENTITY_TYPE, { x: center.x, y: center.y + dy, z: center.z });
    entity.setDynamicProperty(OWNER_NETWORK_PROPERTY, network.id);
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
export function syncRangeIndicator(dimension: Dimension, network: NetworkData, shouldShow: boolean): void {
  const existing = findIndicatorEntities(dimension, network);
  if (shouldShow) {
    if (existing.length > 0) return; // 既に表示中
    spawnIndicators(dimension, network);
  } else {
    for (const entity of existing) entity.remove();
  }
}
