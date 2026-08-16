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

// コントローラブロック: 濃紺の地に、中央の菱形コア
function controllerColorAt(u, v) {
  const dx = Math.abs(u - 0.5);
  const dy = Math.abs(v - 0.5);
  if (dx + dy < 0.15) return [255, 170, 60, 255];
  if (dx + dy < 0.28) return [200, 120, 30, 255];
  return [40, 45, 60, 255];
}

// ターミナルブロック: グレーの地に、中央の緑がかった画面
function terminalColorAt(u, v) {
  const inScreen = u >= 0.2 && u <= 0.8 && v >= 0.25 && v <= 0.75;
  if (inScreen) return [120, 200, 170, 255];
  return [90, 90, 95, 255];
}

// 自動引き出しターミナル: 通常のターミナルと同じ構図だが、画面がオレンジ系で見分けが付く
function autoTerminalColorAt(u, v) {
  const inScreen = u >= 0.2 && u <= 0.8 && v >= 0.25 && v <= 0.75;
  if (inScreen) return [230, 165, 70, 255];
  return [90, 90, 95, 255];
}

// 在庫管理ターミナル: 同じ構図だが、画面が紫系で他の2種と見分けが付く
function inventoryTerminalColorAt(u, v) {
  const inScreen = u >= 0.2 && u <= 0.8 && v >= 0.25 && v <= 0.75;
  if (inScreen) return [150, 110, 210, 255];
  return [90, 90, 95, 255];
}

// レンチアイテム: 透過背景に単純な十字(スパナ風)アイコン
function wrenchColorAt(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const inBar = Math.abs(dx + dy) < 0.09 || Math.abs(dx - dy) < 0.09;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (inBar && dist < 0.42) return [190, 190, 200, 255];
  return [0, 0, 0, 0];
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

writePng("RP/textures/blocks/controller.png", 16, controllerColorAt);
writePng("RP/textures/blocks/terminal.png", 16, terminalColorAt);
writePng("RP/textures/blocks/auto_terminal.png", 16, autoTerminalColorAt);
writePng("RP/textures/blocks/inventory_terminal.png", 16, inventoryTerminalColorAt);
writePng("RP/textures/items/wrench.png", 16, wrenchColorAt);
writePng("RP/pack_icon.png", 128, packIconColorAt);
writePng("BP/pack_icon.png", 128, packIconColorAt);
