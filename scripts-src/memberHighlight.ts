import { Dimension, Entity, Vector3 } from "@minecraft/server";
import { getRangeForTier } from "./controllerAxes";
import { findPhysicalStoragePair } from "./network";
import { NetworkData } from "./state";
import { getDrain } from "./storageSettings";
import { getBlockFacing, isThinTerminalBlock } from "./terminalBlock";

// ネットワーク編集中の「どのブロックが接続されているか」を可視化するハイライト
// (ユーザー要望: 上に別のブロックがあると隠れて判別できないパーティクル方式からの置き換え)。
//
// 実装方針は、Bedrockアドオン向けのブロック強調表示専用ライブラリ「EdgeRender」
// (https://github.com/mcbe-mods/EdgeRender、MITライセンス、作者: lete114)が採用している
// 手法を参考にした: ハイライトしたい1ブロックにつき非表示の専用エンティティを1体スポーンし、
// 「立方体の12本の辺」だけを表すジオメトリを持たせる。各辺は、その辺を挟む2方向の隣接ブロックが
// 両方ともハイライト対象かどうかで表示/非表示を切り替える(隣り合うハイライトブロック同士の
// 内側の辺は自動的に隠れるため、密集して敷き詰めても外周の輪郭線だけが浮かび上がる)。
// EdgeRenderは`entity.playAnimation`のstopExpressionでMolang変数を書き込む手法(古いエンジン
// バージョンとの互換性のためと思われる)を使っているが、このアドオンは`minecraft:entity_properties`
// (`Entity.setProperty`)が使えるエンジンバージョンのみを対象にしているため、より簡潔なその方式を
// 採用した。
const HIGHLIGHT_ENTITY_TYPE = "wh:member_highlight";
const OWNER_NETWORK_PROPERTY = "wh:owner_network";
const OWNER_LOCATION_PROPERTY = "wh:owner_loc";

function centerOf(loc: Vector3): Vector3 {
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

function key(loc: Vector3): string {
  return `${loc.x},${loc.y},${loc.z}`;
}

// rangeIndicator.tsのMAX_SEARCH_DISTANCEと同じ考え方: ネットワークのメンバーは
// (Drain指定等と違い)必ずコントローラから接続可能範囲の最大Tier分の距離以内にいるため、
// これを検索半径の上限として使う。
function maxSearchDistance(): number {
  return getRangeForTier(4) + 2;
}

function findHighlightEntities(dimension: Dimension, network: NetworkData): Entity[] {
  const center = centerOf(network.controller);
  const candidates = dimension.getEntities({
    type: HIGHLIGHT_ENTITY_TYPE,
    location: center,
    maxDistance: maxSearchDistance(),
  });
  return candidates.filter((e) => e.getDynamicProperty(OWNER_NETWORK_PROPERTY) === network.id);
}

function ownerLocOf(entity: Entity): Vector3 | undefined {
  const raw = entity.getDynamicProperty(OWNER_LOCATION_PROPERTY);
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as Vector3;
  } catch {
    return undefined;
  }
}

// EdgeRenderのfv()と同じ判定(移植): d1/d2はその辺を挟む2方向がそれぞれ「空いているか」、
// diagonalFilledは両方向を合成した対角のマスが埋まっているか。埋まっている場合は
// (d1,d2どちらも埋まっている=完全に内側、または片方だけ空いていて対角は埋まっている=
// 段差の内側)辺を隠す。
function edgeVisible(d1Empty: boolean, d2Empty: boolean, diagonalFilled: boolean): boolean {
  return (
    (d1Empty && d2Empty) || (d1Empty && !d2Empty && diagonalFilled) || (!d1Empty && d2Empty && diagonalFilled)
  );
}

// 立方体の12本の辺それぞれの表示可否。ジオメトリ側のボーン名(RP/models/entity/member_highlight.geo.json)
// と1対1で対応する。
function computeEdgeProperties(loc: Vector3, isMember: (l: Vector3) => boolean): Record<string, boolean> {
  const has = (dx: number, dy: number, dz: number) => isMember({ x: loc.x + dx, y: loc.y + dy, z: loc.z + dz });
  const n = !has(0, 0, -1);
  const s = !has(0, 0, 1);
  const e = !has(1, 0, 0);
  const w = !has(-1, 0, 0);
  const u = !has(0, 1, 0);
  const d = !has(0, -1, 0);

  // ユーザー報告により判明: フルブロック用のジオメトリ(RP/models/entity/member_highlight.geo.json)
  // では、なぜか"_n"系ボーンが実際には南側に、"_s"系ボーンが実際には北側に描画される
  // (31章の薄い板系ハイライトで見つかったのと同種の、南北軸だけの食い違い。東西軸は
  // 影響が無い)。孤立したブロックでは南北どちらの辺も表示されるため症状が出ず、二連チェスト
  // のように片側(南または北)だけ隣接している場合に限って、外側にあるべき辺が消え、
  // 内側(継ぎ目)に本来隠れるはずの辺が表示される、という形で発覚した。理論的な原因の
  // 深追いはせず(31章と同じ方針)、_nキーに実際の南判定を、_sキーに実際の北判定を
  // 割り当てることで実機の見え方に合わせている。
  return {
    "wh:visible_vert_en": edgeVisible(s, e, has(1, 0, 1)),
    "wh:visible_vert_wn": edgeVisible(s, w, has(-1, 0, 1)),
    "wh:visible_vert_es": edgeVisible(n, e, has(1, 0, -1)),
    "wh:visible_vert_ws": edgeVisible(n, w, has(-1, 0, -1)),
    "wh:visible_bottom_n": edgeVisible(s, d, has(0, -1, 1)),
    "wh:visible_top_n": edgeVisible(s, u, has(0, 1, 1)),
    "wh:visible_bottom_s": edgeVisible(n, d, has(0, -1, -1)),
    "wh:visible_top_s": edgeVisible(n, u, has(0, 1, -1)),
    "wh:visible_bottom_e": edgeVisible(e, d, has(1, -1, 0)),
    "wh:visible_bottom_w": edgeVisible(w, d, has(-1, -1, 0)),
    "wh:visible_top_e": edgeVisible(e, u, has(1, 1, 0)),
    "wh:visible_top_w": edgeVisible(w, u, has(-1, 1, 0)),
    // 面マーク(ユーザー要望「強調表示されているブロックが分かりやすいように」)。辺と違い
    // 対角判定は不要で、その方向が単純に空いている(=隣に強調対象が無い、その面が露出している)
    // かどうかだけで表示可否が決まる。南北の入れ替えは辺と同じ理由。
    "wh:visible_mark_n": s,
    "wh:visible_mark_s": n,
    "wh:visible_mark_e": e,
    "wh:visible_mark_w": w,
    "wh:visible_mark_u": u,
    "wh:visible_mark_d": d,
  };
}

type ThinFacing = "north" | "south" | "east" | "west" | "up" | "down";

// 実機確認で、張り付き面(terminalBlock.tsのgetBlockFacing)の値をそのまま使うと東西方向の
// 強調表示の向きが逆になることが分かった(エンティティ側のジオメトリ、RP/models/entity/
// member_highlight.geo.jsonのthin_*ボーンとブロックのローカル座標系との向きの食い違いによる
// ものと思われる)ため、東西だけ反対向きに変換していた。しかし後日、**南北方向はそのまま
// 使うのが正しく、東西と同じように反転すると逆になる**という報告を受けた(東西と南北とで
// 実機の見え方が対称ではない。理論的な原因は未特定)。そのため、南北はそのまま・東西だけ
// 反転する非対称なマッピングにしている(上下は今のところ問題の報告が無いため反転のまま)。
const HIGHLIGHT_FACING_MAP: Record<string, ThinFacing> = {
  north: "north",
  south: "south",
  east: "west",
  west: "east",
  up: "down",
  down: "up",
};

function highlightFacing(facing: string | undefined): ThinFacing {
  return HIGHLIGHT_FACING_MAP[facing ?? "north"] ?? "north";
}

type HighlightPoint = { loc: Vector3; drain: boolean };

// 二連チェストは中身を共有するもう半分(登録されていない側)がnetwork.storagesに現れないため、
// そのままでは輪郭線がちょうど2つのチェストの継ぎ目を横切ってしまい、片方だけ強調されている
// ように見えてしまう(ユーザー指摘)。findPhysicalStoragePair(ネットワーク登録の有無に関係なく
// 純粋に物理的な隣接を見る、wrench.ts等でも使われている関数)で見つかる方も同じdrain値で
// ハイライト対象に加えることで、隣接判定(edgeVisible)が2マス分をひとつながりとみなし、
// 継ぎ目の辺が自動的に隠れるようにする。
function withPhysicalPair(dimension: Dimension, point: HighlightPoint): HighlightPoint[] {
  const pair = findPhysicalStoragePair(dimension, point.loc);
  return pair ? [point, { loc: pair, drain: point.drain }] : [point];
}

// 構築モード: コントローラ・ストレージ・ターミナル・オブザーバーの全メンバーを緑で強調する
// (従来のパーティクルと同じ対象)。Drainモード: コントローラと全ストレージのみを対象にし、
// Drain指定済みのストレージだけ赤にする(wrench.tsのhighlightEditingNetworkと同じ考え方)。
function collectPoints(network: NetworkData, dimension: Dimension, mode: "build" | "drain"): HighlightPoint[] {
  if (mode === "drain") {
    return [
      { loc: network.controller, drain: false },
      ...network.storages.flatMap((loc) => withPhysicalPair(dimension, { loc, drain: getDrain(dimension, loc) })),
    ];
  }
  return [
    ...[network.controller, ...network.terminals, ...network.observers].map((loc) => ({ loc, drain: false })),
    ...network.storages.flatMap((loc) => withPhysicalPair(dimension, { loc, drain: false })),
  ];
}

// 「表示されているべきか」を都度再計算して実際の状態と一致させる(rangeIndicator.tsの
// syncRangeIndicatorと同じ、参照カウント等は持たない都度収束の考え方)。
export function syncMemberHighlight(dimension: Dimension, network: NetworkData, mode: "off" | "build" | "drain"): void {
  const existing = findHighlightEntities(dimension, network);

  if (mode === "off") {
    for (const entity of existing) entity.remove();
    return;
  }

  const points = collectPoints(network, dimension, mode);
  const memberKeys = new Set(points.map((p) => key(p.loc)));

  // 薄い板系(ターミナル)はブロックの一部の面しか占有しないため、フルブロックの辺の
  // 隣接判定では「埋まっている」とみなしてはいけない(ユーザー指摘: フルブロックの隣が
  // ターミナルだと、そちら側の辺が継ぎ目と誤認識されて消えてしまっていた)。薄い板系の
  // 位置をあらかじめ調べておき、フルブロックの辺の可視判定にはそれを除いた集合を渡す
  // (薄い板系自身の表示はcomputeEdgeProperties自体を使わないため、この除外の影響を受けない)。
  const isThinAt = new Map<string, boolean>();
  for (const point of points) {
    const k = key(point.loc);
    if (isThinAt.has(k)) continue;
    const block = dimension.getBlock(point.loc);
    isThinAt.set(k, !!block && isThinTerminalBlock(block.typeId));
  }
  const isMemberForEdges = (l: Vector3) => {
    const k = key(l);
    return memberKeys.has(k) && !isThinAt.get(k);
  };

  const existingByKey = new Map<string, Entity>();
  for (const entity of existing) {
    const loc = ownerLocOf(entity);
    if (loc) existingByKey.set(key(loc), entity);
    else entity.remove(); // 所在地不明(壊れた個体)。作り直す。
  }

  // 対象から外れたメンバー分は削除する。
  for (const [k, entity] of existingByKey) {
    if (!memberKeys.has(k)) {
      entity.remove();
      existingByKey.delete(k);
    }
  }

  for (const point of points) {
    const k = key(point.loc);
    let entity = existingByKey.get(k);
    if (!entity) {
      entity = dimension.spawnEntity(HIGHLIGHT_ENTITY_TYPE, centerOf(point.loc));
      entity.setDynamicProperty(OWNER_NETWORK_PROPERTY, network.id);
      entity.setDynamicProperty(OWNER_LOCATION_PROPERTY, JSON.stringify(point.loc));
    }
    entity.setProperty("wh:drain", point.drain);
    const isThin = isThinAt.get(k) ?? false;
    entity.setProperty("wh:is_thin", isThin);
    if (isThin) {
      const block = dimension.getBlock(point.loc);
      entity.setProperty("wh:facing", highlightFacing(getBlockFacing(block!)));
    } else {
      const edgeProps = computeEdgeProperties(point.loc, isMemberForEdges);
      for (const [propertyId, visible] of Object.entries(edgeProps)) {
        entity.setProperty(propertyId, visible);
      }
    }
  }
}
