// ビルド時に実行される簡易PNG生成スクリプト。
// 本物のアートが用意できるまでの仮テクスチャを、外部ライブラリなしで
// zlib のみを使って手組みする。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// 疑似乱数(座標決定的)。ベタ塗りを避けるためのごく軽いディザ用。
function hashNoise(u, v) {
  const x = Math.sin(u * 12.9898 + v * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

// パネルの縁を明(左上)/暗(右下)にずらして立体的なベベルに見せる、簡易的な手法。
function edgeBevel(u, v, band) {
  if (u < band || v < band) return 1;
  if (u > 1 - band || v > 1 - band) return -1;
  return 0;
}

// コントローラブロック: 金属ケース(ベベル+リベット)+中央の発光コア
function controllerColorAt(u, v) {
  const bevel = edgeBevel(u, v, 0.09);
  let [r, g, b] = [38, 42, 54];
  if (bevel === 1) [r, g, b] = [r + 22, g + 22, b + 22];
  else if (bevel === -1) [r, g, b] = [r - 18, g - 18, b - 18];

  // 四隅のリベット(留め具)
  const nearCornerU = Math.abs(u - 0.14) < 0.035 || Math.abs(u - 0.86) < 0.035;
  const nearCornerV = Math.abs(v - 0.14) < 0.035 || Math.abs(v - 0.86) < 0.035;
  if (nearCornerU && nearCornerV) [r, g, b] = [20, 22, 28];

  // 中央の発光コア(菱形、中心ほど明るい放射状グラデーション)
  const diamond = Math.abs(u - 0.5) + Math.abs(v - 0.5);
  if (diamond < 0.32) {
    const t = 1 - Math.min(1, diamond / 0.32);
    r = 120 + 135 * t;
    g = 70 + 100 * t;
    b = 20 + 20 * (1 - t);
    if (diamond < 0.06) [r, g, b] = [255, 235, 190];
  }

  const n = (hashNoise(u, v) - 0.5) * 10;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

// 搬入出パッド: フルブロック単一テクスチャ(controllerColorAtと同じ構図)。中央に「搬入(内側の
// シアンのリング)」「搬出(外側のピンクのリング)」を表す二重の同心リングを乗せ、他の端末系
// (画面+走査線)とは違う、床置きの「乗るパッド」であることが一目で分かる見た目にした。
// アイテム側の見た目もこのブロックテクスチャがそのまま使われる(controllerと同じくフルブロックの
// ため、専用アイコン・アイテム定義は不要。BP/blocks/io_pad.json参照)。
function ioPadColorAt(u, v) {
  const bevel = edgeBevel(u, v, 0.09);
  let [r, g, b] = [42, 40, 46];
  if (bevel === 1) [r, g, b] = [r + 22, g + 22, b + 22];
  else if (bevel === -1) [r, g, b] = [r - 18, g - 18, b - 18];

  const nearCornerU = Math.abs(u - 0.14) < 0.035 || Math.abs(u - 0.86) < 0.035;
  const nearCornerV = Math.abs(v - 0.14) < 0.035 || Math.abs(v - 0.86) < 0.035;
  if (nearCornerU && nearCornerV) [r, g, b] = [22, 20, 24];

  // 当初は彩度・明度が高いピンク/シアンにしていたが、他のターミナル系(暗い金属フレームに
  // 中程度の彩度の色を乗せる程度)と比べて浮いて見える(実機で指摘)ため、彩度・明度を
  // 落とした落ち着いた色調(くすんだローズ/スレートティール)に変更した。
  const dist = Math.hypot(u - 0.5, v - 0.5);
  if (dist < 0.4 && dist > 0.3) [r, g, b] = [150, 108, 118]; // 外側リング(搬出)
  if (dist < 0.22 && dist > 0.12) [r, g, b] = [96, 132, 138]; // 内側リング(搬入)
  if (dist < 0.08) [r, g, b] = [188, 186, 188];

  const n = (hashNoise(u, v) - 0.5) * 6;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

// 吸い込みパッド: 上面だけに渦模様を出し、側面/底面は無地の枠にする(ユーザー要望。
// ネットワークオブザーバーと違って向きの概念が無く、常に真上が回収面のため、Box UVのような
// 回転対応の仕組みは不要で、minecraft:geometry.full_blockのmaterial_instancesに"up"だけ別の
// テクスチャを割り当てるだけで済む。BP/blocks/suction_pad.json参照)。
// 上面: 中心へ向かうにつれて明るくなる同心リング(4本)で「周囲から中心へ吸い込む」渦を表現。
// 搬入出パッド(ローズ/ティールの二重リング)とは色調(琥珀色)で見分けが付くようにしている。
function suctionPadTopColorAt(u, v) {
  const bevel = edgeBevel(u, v, 0.09);
  let [r, g, b] = [40, 38, 34];
  if (bevel === 1) [r, g, b] = [r + 22, g + 22, b + 22];
  else if (bevel === -1) [r, g, b] = [r - 18, g - 18, b - 18];

  const nearCornerU = Math.abs(u - 0.14) < 0.035 || Math.abs(u - 0.86) < 0.035;
  const nearCornerV = Math.abs(v - 0.14) < 0.035 || Math.abs(v - 0.86) < 0.035;
  if (nearCornerU && nearCornerV) [r, g, b] = [20, 18, 16];

  const dist = Math.hypot(u - 0.5, v - 0.5);
  const ringIndex = Math.floor(dist / 0.09);
  if (dist < 0.4 && ringIndex % 2 === 0) {
    const t = 1 - Math.min(1, dist / 0.4);
    r = 90 + 140 * t;
    g = 65 + 110 * t;
    b = 20 + 20 * t;
  }
  if (dist < 0.06) [r, g, b] = [255, 235, 190];

  const n = (hashNoise(u, v) - 0.5) * 6;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

// 吸い込みパッドの側面/底面: 上面と同じ枠(ベベル+四隅のリベット)だけで、渦模様は乗せない
// (回収面は常に上面だけなので、それ以外の面に模様を出すと紛らわしいというユーザー指摘)。
function suctionPadSideColorAt(u, v) {
  const bevel = edgeBevel(u, v, 0.09);
  let [r, g, b] = [40, 38, 34];
  if (bevel === 1) [r, g, b] = [r + 22, g + 22, b + 22];
  else if (bevel === -1) [r, g, b] = [r - 18, g - 18, b - 18];

  const nearCornerU = Math.abs(u - 0.14) < 0.035 || Math.abs(u - 0.86) < 0.035;
  const nearCornerV = Math.abs(v - 0.14) < 0.035 || Math.abs(v - 0.86) < 0.035;
  if (nearCornerU && nearCornerV) [r, g, b] = [20, 18, 16];

  const n = (hashNoise(u, v) - 0.5) * 6;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

// インベントリ等で使う正面からの単純な2Dアイコン(controllerColorAtの構図を16x16へ縮めたもの)。
function networkObserverIconColorAt(u, v) {
  const bevel = edgeBevel(u, v, 0.1);
  let [r, g, b] = [30, 40, 52];
  if (bevel === 1) [r, g, b] = [r + 22, g + 22, b + 22];
  else if (bevel === -1) [r, g, b] = [r - 18, g - 18, b - 18];

  const dist = Math.hypot(u - 0.5, v - 0.5);
  if (dist < 0.32) {
    const t = 1 - Math.min(1, dist / 0.32);
    r = 40 + 30 * t;
    g = 120 + 80 * t;
    b = 200 + 55 * t;
    if (dist < 0.08) [r, g, b] = [230, 245, 255];
  }

  const n = (hashNoise(u, v) - 0.5) * 8;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

// RP/models/blocks/terminal.geo.json の cube(size: [14, 14, 1], uv: [0, 0])に対応する
// Box UVレイアウト。Minecraft/Blockbenchの標準的な展開順(west/north/east/south/up/down)で、
// テクスチャ内のどの矩形を各面が使うかを計算する。dx=幅, dy=高さ, dz=奥行き(すべてテクスチャ
// ピクセル単位、モデルのcube sizeと同じ値)。
function boxUvLayout(dx, dy, dz) {
  return {
    west: { x: 0, y: dz, w: dz, h: dy },
    north: { x: dz, y: dz, w: dx, h: dy },
    east: { x: dz + dx, y: dz, w: dz, h: dy },
    south: { x: dz + dx + dz, y: dz, w: dx, h: dy },
    up: { x: dz, y: 0, w: dx, h: dz },
    down: { x: dz + dx, y: 0, w: dx, h: dz },
  };
}

// canvasSize x canvasSize のキャンバス上で、Box UVの各面領域ごとに別々の描画関数を呼び出す。
// 領域外(パディング)はedgeColorで塗る。faceColorAt(face, lu, lv)のlu/lvはその面内で
// 0〜1に正規化した相対座標。
function makeBoxUvColorAt(canvasSize, dx, dy, dz, faceColorAt, edgeColor) {
  const layout = boxUvLayout(dx, dy, dz);
  return (u, v) => {
    const px = u * canvasSize;
    const py = v * canvasSize;
    for (const face of Object.keys(layout)) {
      const rect = layout[face];
      if (px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h) {
        const lu = (px - rect.x) / rect.w;
        const lv = (py - rect.y) / rect.h;
        return faceColorAt(face, lu, lv);
      }
    }
    return edgeColor;
  };
}

// ネットワークオブザーバー(フルブロック、geometry.network_observerのBox UV)。信号を出す面
// (ローカルsouth固定、BP/blocks/network_observer.jsonのredstone_producer.strongly_powered_face
// と同じ面)だけ中央に同心円(目のような形)を乗せ、他の5面は無地の金属ケースにする。
// minecraft:material_instancesはpermutations経由の切り替えに対応していない(実機で確認済み。
// docs/design.md参照)ため、ジオメトリごとBox UVで回転するterminal.geo.jsonと同じ方式にした。
const NETWORK_OBSERVER_CANVAS_SIZE = 64;
const NETWORK_OBSERVER_BOX = [16, 16, 16]; // RP/models/blocks/network_observer.geo.jsonのcube sizeと一致させる

function networkObserverFaceColorAt(face, lu, lv) {
  const bevel = edgeBevel(lu, lv, 0.09);
  let [r, g, b] = [30, 40, 52];
  if (bevel === 1) [r, g, b] = [r + 22, g + 22, b + 22];
  else if (bevel === -1) [r, g, b] = [r - 18, g - 18, b - 18];

  const nearCornerU = Math.abs(lu - 0.14) < 0.035 || Math.abs(lu - 0.86) < 0.035;
  const nearCornerV = Math.abs(lv - 0.14) < 0.035 || Math.abs(lv - 0.86) < 0.035;
  if (nearCornerU && nearCornerV) [r, g, b] = [18, 22, 26];

  if (face === "south") {
    const dist = Math.hypot(lu - 0.5, lv - 0.5);
    if (dist < 0.32) {
      const t = 1 - Math.min(1, dist / 0.32);
      r = 40 + 30 * t;
      g = 120 + 80 * t;
      b = 200 + 55 * t;
      if (dist < 0.08) [r, g, b] = [230, 245, 255];
    }
  }

  const n = (hashNoise(lu, lv) - 0.5) * 10;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

const networkObserverColorAt = makeBoxUvColorAt(
  NETWORK_OBSERVER_CANVAS_SIZE,
  ...NETWORK_OBSERVER_BOX,
  networkObserverFaceColorAt,
  [30, 40, 52, 255]
);

// ターミナル系ブロック共通: 金属フレーム(ベベル)+走査線入りの発光スクリーン+電源ランプ。
// screenTop/screenBottomの2色でスクリーン内の縦グラデーションを作り、種別ごとに配色を変える。
// 正面(north)・背面(south)にはスクリーン柄を、それ以外の薄い側面(west/east/up/down)は
// 単純な金属フレーム色で塗る(Box UV上で正しい面だけに柄が乗るようにするため)。
const TERMINAL_PANEL_CANVAS_SIZE = 32;
const TERMINAL_PANEL_BOX = [14, 14, 1]; // RP/models/blocks/terminal.geo.jsonのcube sizeと一致させる

function terminalFamilyColorAt(screenTop, screenBottom) {
  const frameBase = [70, 72, 78];

  function screenFace(lu, lv) {
    const bevel = edgeBevel(lu, lv, 0.08);
    let [r, g, b] = frameBase;
    if (bevel === 1) [r, g, b] = [r + 20, g + 20, b + 20];
    else if (bevel === -1) [r, g, b] = [r - 16, g - 16, b - 16];

    const inScreen = lu >= 0.16 && lu <= 0.84 && lv >= 0.2 && lv <= 0.8;
    if (inScreen) {
      const t = 1 - (lv - 0.2) / 0.6;
      r = screenBottom[0] + (screenTop[0] - screenBottom[0]) * t;
      g = screenBottom[1] + (screenTop[1] - screenBottom[1]) * t;
      b = screenBottom[2] + (screenTop[2] - screenBottom[2]) * t;

      // 走査線(CRT風): 1行おきにわずかに暗くする
      if (Math.floor(lv * 16) % 2 === 0) [r, g, b] = [r - 12, g - 12, b - 12];
    }

    // 電源ランプ
    if (Math.hypot(lu - 0.82, lv - 0.86) < 0.06) [r, g, b] = [255, 90, 90];

    const n = (hashNoise(lu, lv) - 0.5) * 6;
    return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
  }

  function edgeFace(lu, lv) {
    const bevel = edgeBevel(lu, lv, 0.2);
    let [r, g, b] = frameBase;
    if (bevel === 1) [r, g, b] = [r + 14, g + 14, b + 14];
    else if (bevel === -1) [r, g, b] = [r - 12, g - 12, b - 12];
    const n = (hashNoise(lu, lv) - 0.5) * 6;
    return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
  }

  // 背面(south)はスクリーン柄にせず、他の薄い側面と同じ単純な金属色にする(裏側なので無地でよい)。
  return makeBoxUvColorAt(
    TERMINAL_PANEL_CANVAS_SIZE,
    ...TERMINAL_PANEL_BOX,
    (face, lu, lv) => (face === "north" ? screenFace(lu, lv) : edgeFace(lu, lv)),
    [...frameBase, 255],
  );
}

// ターミナルブロック: スクリーンは緑〜青緑系
const terminalColorAt = terminalFamilyColorAt([170, 235, 210], [40, 95, 80]);

// 自動引き出しターミナル: 通常のターミナルと同じ構図だが、スクリーンがオレンジ系で見分けが付く
const autoTerminalColorAt = terminalFamilyColorAt([255, 195, 120], [130, 80, 20]);

// 在庫管理ターミナル: 同じ構図だが、スクリーンが紫系で他の2種と見分けが付く
const inventoryTerminalColorAt = terminalFamilyColorAt([200, 165, 245], [80, 55, 120]);

// 精密ターミナル: 同じ構図だが、スクリーンが赤系で他の3種と見分けが付く(「精密/照準」のイメージ)
const precisionTerminalColorAt = terminalFamilyColorAt([250, 140, 140], [110, 30, 30]);

// 配達ターミナル: 同じ構図だが、スクリーンが緑系で他の4種と見分けが付く(「受け取り完了」のイメージ)
const deliveryTerminalColorAt = terminalFamilyColorAt([140, 230, 150], [30, 110, 45]);

// 液体ポンプ: フルブロック(ユーザー要望。搬入出パッド/吸い込みパッドと同じくフルブロック)。
// 向き(minecraft:facing_direction、設置時にプレイヤーが向いていた方向)に応じて、対象の液体が
// ある面(BP側permutationsでその面だけmaterial_instancesを差し替える)にバルブ/パイプの開口部
// (同心円)を持つ専用テクスチャを、それ以外の面には無地の金属パネルを表示する。搬入出パッドの
// 上面/側面の使い分け(suction_pad_top/suction_pad_side)と同じ2枚テクスチャ構成。
function liquidPumpFaceColorAt(u, v) {
  const bevel = edgeBevel(u, v, 0.09);
  let [r, g, b] = [72, 84, 96];
  if (bevel === 1) [r, g, b] = [r + 22, g + 22, b + 22];
  else if (bevel === -1) [r, g, b] = [r - 18, g - 18, b - 18];

  const nearCornerU = Math.abs(u - 0.14) < 0.035 || Math.abs(u - 0.86) < 0.035;
  const nearCornerV = Math.abs(v - 0.14) < 0.035 || Math.abs(v - 0.86) < 0.035;
  if (nearCornerU && nearCornerV) [r, g, b] = [22, 26, 32];

  const dist = Math.hypot(u - 0.5, v - 0.5);
  if (dist < 0.34 && dist > 0.26) [r, g, b] = [150, 170, 185]; // バルブの縁
  if (dist < 0.22) [r, g, b] = [30, 40, 55]; // パイプの開口部(暗い穴)
  if (dist < 0.1) [r, g, b] = [70, 130, 190]; // 中を流れる液体(水色)

  const n = (hashNoise(u, v) - 0.5) * 6;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

function liquidPumpSideColorAt(u, v) {
  const bevel = edgeBevel(u, v, 0.09);
  let [r, g, b] = [72, 84, 96];
  if (bevel === 1) [r, g, b] = [r + 22, g + 22, b + 22];
  else if (bevel === -1) [r, g, b] = [r - 18, g - 18, b - 18];

  const nearCornerU = Math.abs(u - 0.14) < 0.035 || Math.abs(u - 0.86) < 0.035;
  const nearCornerV = Math.abs(v - 0.14) < 0.035 || Math.abs(v - 0.86) < 0.035;
  if (nearCornerU && nearCornerV) [r, g, b] = [22, 26, 32];

  const n = (hashNoise(u, v) - 0.5) * 6;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

// インベントリ等で使う、正面から見た単純な2Dアイコン(ブロックの3Dモデル用テクスチャとは
// 別ファイル)。手に持った時やクリエイティブインベントリの見た目はこちらが使われるように
// 各ブロックのBP側で`minecraft:icon`として登録する。3Dモデル側のBox UVテクスチャ
// (controller.png/terminal.png等)は変更しない。
function flatTerminalIconColorAt(screenTop, screenBottom) {
  return (u, v) => {
    const bevel = edgeBevel(u, v, 0.08);
    let [r, g, b] = [70, 72, 78];
    if (bevel === 1) [r, g, b] = [r + 20, g + 20, b + 20];
    else if (bevel === -1) [r, g, b] = [r - 16, g - 16, b - 16];

    const inScreen = u >= 0.16 && u <= 0.84 && v >= 0.16 && v <= 0.84;
    if (inScreen) {
      const t = 1 - (v - 0.16) / 0.68;
      r = screenBottom[0] + (screenTop[0] - screenBottom[0]) * t;
      g = screenBottom[1] + (screenTop[1] - screenBottom[1]) * t;
      b = screenBottom[2] + (screenTop[2] - screenBottom[2]) * t;
    }

    if (Math.hypot(u - 0.82, v - 0.86) < 0.06) [r, g, b] = [255, 90, 90];

    const n = (hashNoise(u, v) - 0.5) * 6;
    return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
  };
}

const terminalIconColorAt = flatTerminalIconColorAt([170, 235, 210], [40, 95, 80]);
const autoTerminalIconColorAt = flatTerminalIconColorAt([255, 195, 120], [130, 80, 20]);
const inventoryTerminalIconColorAt = flatTerminalIconColorAt([200, 165, 245], [80, 55, 120]);
const precisionTerminalIconColorAt = flatTerminalIconColorAt([250, 140, 140], [110, 30, 30]);
const deliveryTerminalIconColorAt = flatTerminalIconColorAt([140, 230, 150], [30, 110, 45]);

// リモート配達ターミナル(アイテム): 他のターミナル系(壁面パネル調、画面いっぱいに不透明な
// 枠)とは違い、「手持ちのタブレット端末」を連想させる見た目にする(ユーザー要望:
// 「もっとポータブル感のある見た目」)。倉庫レンチ(wrenchColorAt)と同じく背景を透過にする。
// 過去2回の試行(縦長すぎる本体+同心の弧3本の無線マーク→潰れて水色の塊に見える、
// アンテナに変更→本体の枠に食い込んで上端が開いた「コップ」のように見える)がいずれも
// 16x16の低解像度で意図通りに見えなかった(ユーザー指摘)ため、装飾は諦めてタブレットらしい
// 比率(幅:高さ ≒ 3:4)の閉じた枠+画面+下部ボタンという、確実に読み取れる単純な形にした。
function remoteDeliveryTerminalIconColorAt(u, v) {
  const inBody = u >= 0.26 && u <= 0.74 && v >= 0.16 && v <= 0.84;
  if (!inBody) return [0, 0, 0, 0];

  const bodyBevel = edgeBevel((u - 0.26) / 0.48, (v - 0.16) / 0.68, 0.08);
  let [r, g, b] = [45, 48, 58];
  if (bodyBevel === 1) [r, g, b] = [r + 20, g + 20, b + 20];
  else if (bodyBevel === -1) [r, g, b] = [r - 15, g - 15, b - 15];

  // 画面(本体の中央寄り、下部にホームボタン分の余白を残す)
  const inScreen = u >= 0.31 && u <= 0.69 && v >= 0.22 && v <= 0.7;
  if (inScreen) {
    const t = 1 - (v - 0.22) / 0.48;
    r = 30 + 110 * t;
    g = 70 + 130 * t;
    b = 130 + 125 * t;
    if (Math.floor(v * 16) % 2 === 0) [r, g, b] = [r - 10, g - 10, b - 10]; // 走査線(CRT風)
  }

  // 下部のホームボタン
  if (Math.hypot(u - 0.5, v - 0.78) < 0.035) [r, g, b] = [210, 215, 225];

  const n = (hashNoise(u, v) - 0.5) * 6;
  return [clampByte(r + n), clampByte(g + n), clampByte(b + n), 255];
}

// アップグレードキットアイテム: 透過背景に単純な菱形(宝石風)アイコン。Tierごとの色味だけで
// 見分ける(素材(銅/鉄/ダイヤ/ネザライト)には対応させず、Tier番号のみの汎用ネーミングにした。
// 色自体は元々の素材イメージを踏襲しつつ、あくまでTierの進行を表す配色として流用している)。
// wrenchColorAtと同じく、作り込みは後回しのプレースホルダー。
function upgradeKitColorAt(tint) {
  return (u, v) => {
    const dx = Math.abs(u - 0.5);
    const dy = Math.abs(v - 0.5);
    if (dx + dy < 0.38) {
      const n = (hashNoise(u, v) - 0.5) * 12;
      return [clampByte(tint[0] + n), clampByte(tint[1] + n), clampByte(tint[2] + n), 255];
    }
    return [0, 0, 0, 0];
  };
}

const UPGRADE_TIER_TINTS = [
  [190, 110, 70], // Tier1
  [210, 210, 215], // Tier2
  [110, 220, 230], // Tier3
  [70, 55, 60], // Tier4
];

const speedKitColorAtByTier = UPGRADE_TIER_TINTS.map((tint) => upgradeKitColorAt(tint));

// 「周期」軸のキット: 速度キットと同じTierごとの色味だが、形をリング(時計の輪っか風)にして
// 軸違いを一目で区別できるようにする。
function upgradeKitRingColorAt(tint) {
  return (u, v) => {
    const dist = Math.hypot(u - 0.5, v - 0.5);
    if (dist < 0.4 && dist > 0.16) {
      const n = (hashNoise(u, v) - 0.5) * 12;
      return [clampByte(tint[0] + n), clampByte(tint[1] + n), clampByte(tint[2] + n), 255];
    }
    return [0, 0, 0, 0];
  };
}

const cycleKitColorAtByTier = UPGRADE_TIER_TINTS.map((tint) => upgradeKitRingColorAt(tint));

// 「範囲」軸のキット: 速度(菱形)/周期(リング)と見分けが付くよう、四角い枠(額縁)の形にする。
// 「囲む範囲」を連想させる形として選んだ。
function upgradeKitSquareColorAt(tint) {
  return (u, v) => {
    const dx = Math.abs(u - 0.5);
    const dy = Math.abs(v - 0.5);
    const d = Math.max(dx, dy);
    if (d < 0.4 && d > 0.16) {
      const n = (hashNoise(u, v) - 0.5) * 12;
      return [clampByte(tint[0] + n), clampByte(tint[1] + n), clampByte(tint[2] + n), 255];
    }
    return [0, 0, 0, 0];
  };
}

const rangeKitColorAtByTier = UPGRADE_TIER_TINTS.map((tint) => upgradeKitSquareColorAt(tint));

// 「リモート操作」軸のキット: 速度(菱形)/周期(リング)/範囲(四角い枠)と見分けが付くよう、
// 照準(レティクル)のような十字+外周の4つの短いマークの形にする。「遠くを狙う/操作する」を
// 連想させる形として選んだ。
function upgradeKitCrossColorAt(tint) {
  return (u, v) => {
    const dx = Math.abs(u - 0.5);
    const dy = Math.abs(v - 0.5);
    const dist = Math.hypot(dx, dy);

    // 中心の十字(縦棒・横棒)
    const inCross = (dx < 0.06 && dy < 0.32) || (dy < 0.06 && dx < 0.32);
    // 外周4方向の短いマーク(照準の目盛り)
    const onAxis = dx < 0.06 || dy < 0.06;
    const inTick = onAxis && dist > 0.36 && dist < 0.46;

    if (inCross || inTick) {
      const n = (hashNoise(u, v) - 0.5) * 12;
      return [clampByte(tint[0] + n), clampByte(tint[1] + n), clampByte(tint[2] + n), 255];
    }
    return [0, 0, 0, 0];
  };
}

const remoteAccessKitColorAtByTier = UPGRADE_TIER_TINTS.map((tint) => upgradeKitCrossColorAt(tint));

// レンチアイテム: 透過背景に、斜めの柄+片側に開口部のある輪(スパナの口)+反対側に丸い柄尻、
// という実際のスパナのシルエットに近いアイコン。
function wrenchColorAt(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  // 柄が左下から右上に伸びるよう45度回転させた座標系(rx=柄方向、ry=柄の幅方向)。
  const rx = (dx + dy) * Math.SQRT1_2;
  const ry = (dy - dx) * Math.SQRT1_2;

  const bright = [200, 200, 210, 255];
  const shade = [130, 130, 145, 255];

  // 柄(シャフト)
  const inShaft = Math.abs(ry) < 0.06 && rx > -0.28 && rx < 0.16;

  // スパナの口(右上端): 輪の外側(柄と逆方向、rx正方向)だけ開口させたリング。
  const headCx = 0.28;
  const hx = rx - headCx;
  const headDist = Math.hypot(hx, ry);
  const headAngle = Math.atan2(ry, hx); // -PI..PI, 0=外向き
  const inGap = Math.abs(headAngle) < 0.55 && headDist > 0.09;
  const inHead = headDist > 0.08 && headDist < 0.2 && !inGap;

  // 柄尻(左下端): 単純な丸いキャップ
  const capCx = -0.28;
  const cx = rx - capCx;
  const inCap = Math.hypot(cx, ry) < 0.1;

  if (inHead) return headDist > 0.15 ? shade : bright;
  if (inCap || inShaft) return bright;
  return [0, 0, 0, 0];
}

// ネットワーク接続範囲インジケータ(range_wall/range_ceiling): 全面同じ半透明の水色。
// entity_alphablendマテリアルで使うため、アルファ値は完全不透明にしない。
function rangeIndicatorColorAt() {
  return [80, 160, 255, 90];
}

// メンバーハイライト(member_highlight、ユーザー要望): 接続済みブロックを縁取るワイヤーフレームの
// 色。通常(緑)/格納禁止指定(赤)の2色を、rangeIndicatorと同じ単色べた塗りで用意する
// (ジオメトリ側が細い辺のパーツだけなので模様は不要)。
function memberHighlightColorAt() {
  return [90, 220, 130, 255];
}

function memberHighlightDrainColorAt() {
  return [230, 80, 80, 255];
}

function packIconColorAt(u, v) {
  const dx = Math.abs(u - 0.5);
  const dy = Math.abs(v - 0.5);
  if (dx + dy < 0.2) return [255, 170, 60, 255];
  if (dx + dy < 0.4) return [90, 90, 95, 255];
  return [40, 45, 60, 255];
}

function writePng(outPath, size, colorAt) {
  const rowBytes = size * 4;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // フィルタなし
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = colorAt((x + 0.5) / size, (y + 0.5) / size);
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  console.log(`written: ${outPath}`);
}

writePng("RP/textures/blocks/controller.png", 32, controllerColorAt);
writePng("RP/textures/blocks/terminal.png", 32, terminalColorAt);
writePng("RP/textures/blocks/auto_terminal.png", 32, autoTerminalColorAt);
writePng("RP/textures/blocks/inventory_terminal.png", 32, inventoryTerminalColorAt);
writePng("RP/textures/blocks/precision_terminal.png", 32, precisionTerminalColorAt);
writePng("RP/textures/blocks/delivery_terminal.png", 32, deliveryTerminalColorAt);
writePng("RP/textures/blocks/liquid_pump_face.png", 32, liquidPumpFaceColorAt);
writePng("RP/textures/blocks/liquid_pump_side.png", 32, liquidPumpSideColorAt);
writePng("RP/textures/blocks/network_observer.png", NETWORK_OBSERVER_CANVAS_SIZE, networkObserverColorAt);
writePng("RP/textures/blocks/io_pad.png", 32, ioPadColorAt);
writePng("RP/textures/blocks/suction_pad_top.png", 32, suctionPadTopColorAt);
writePng("RP/textures/blocks/suction_pad_side.png", 32, suctionPadSideColorAt);
writePng("RP/textures/blocks/terminal_icon.png", 16, terminalIconColorAt);
writePng("RP/textures/blocks/auto_terminal_icon.png", 16, autoTerminalIconColorAt);
writePng("RP/textures/blocks/inventory_terminal_icon.png", 16, inventoryTerminalIconColorAt);
writePng("RP/textures/blocks/precision_terminal_icon.png", 16, precisionTerminalIconColorAt);
writePng("RP/textures/blocks/delivery_terminal_icon.png", 16, deliveryTerminalIconColorAt);
writePng("RP/textures/items/remote_delivery_terminal_icon.png", 16, remoteDeliveryTerminalIconColorAt);
writePng("RP/textures/blocks/network_observer_icon.png", 16, networkObserverIconColorAt);
writePng("RP/textures/items/wrench.png", 16, wrenchColorAt);
speedKitColorAtByTier.forEach((colorAt, i) => {
  writePng(`RP/textures/items/speed_kit_tier${i + 1}.png`, 16, colorAt);
});
cycleKitColorAtByTier.forEach((colorAt, i) => {
  writePng(`RP/textures/items/cycle_kit_tier${i + 1}.png`, 16, colorAt);
});
rangeKitColorAtByTier.forEach((colorAt, i) => {
  writePng(`RP/textures/items/range_kit_tier${i + 1}.png`, 16, colorAt);
});
remoteAccessKitColorAtByTier.forEach((colorAt, i) => {
  writePng(`RP/textures/items/remote_access_kit_tier${i + 1}.png`, 16, colorAt);
});
writePng("RP/textures/entity/range_indicator.png", 16, rangeIndicatorColorAt);
writePng("RP/textures/entity/member_highlight.png", 4, memberHighlightColorAt);
writePng("RP/textures/entity/member_highlight_drain.png", 4, memberHighlightDrainColorAt);
writePng("RP/pack_icon.png", 128, packIconColorAt);
writePng("BP/pack_icon.png", 128, packIconColorAt);
