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

// アップグレードキットアイテム: 透過背景に単純な菱形(宝石風)アイコン。素材ごとの色味だけで
// 見分ける(wrenchColorAtと同じく、作り込みは後回しのプレースホルダー)。
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

const speedKitCopperColorAt = upgradeKitColorAt([190, 110, 70]);
const speedKitIronColorAt = upgradeKitColorAt([210, 210, 215]);
const speedKitDiamondColorAt = upgradeKitColorAt([110, 220, 230]);
const speedKitNetheriteColorAt = upgradeKitColorAt([70, 55, 60]);

// レンチアイテム: 透過背景に単純な十字(スパナ風)アイコン
function wrenchColorAt(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const inBar = Math.abs(dx + dy) < 0.09 || Math.abs(dx - dy) < 0.09;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (inBar && dist < 0.42) return [190, 190, 200, 255];
  return [0, 0, 0, 0];
}

// ネットワーク接続範囲インジケータ(range_wall/range_ceiling): 全面同じ半透明の水色。
// entity_alphablendマテリアルで使うため、アルファ値は完全不透明にしない。
function rangeIndicatorColorAt() {
  return [80, 160, 255, 90];
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
writePng("RP/textures/blocks/terminal_icon.png", 16, terminalIconColorAt);
writePng("RP/textures/blocks/auto_terminal_icon.png", 16, autoTerminalIconColorAt);
writePng("RP/textures/blocks/inventory_terminal_icon.png", 16, inventoryTerminalIconColorAt);
writePng("RP/textures/items/wrench.png", 16, wrenchColorAt);
writePng("RP/textures/items/speed_kit_copper.png", 16, speedKitCopperColorAt);
writePng("RP/textures/items/speed_kit_iron.png", 16, speedKitIronColorAt);
writePng("RP/textures/items/speed_kit_diamond.png", 16, speedKitDiamondColorAt);
writePng("RP/textures/items/speed_kit_netherite.png", 16, speedKitNetheriteColorAt);
writePng("RP/textures/entity/range_indicator.png", 16, rangeIndicatorColorAt);
writePng("RP/pack_icon.png", 128, packIconColorAt);
writePng("BP/pack_icon.png", 128, packIconColorAt);
