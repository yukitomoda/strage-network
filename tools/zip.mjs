// .mcpack/.mcaddon 生成用の、最小限の自前zip書き込みユーティリティ。
// PNG生成(generate-placeholder-icon.mjs)と同じ「外部ライブラリなしで手組みする」方針を踏襲し、
// CRC32のアルゴリズムもそちらと同じもの。圧縮はせずストア方式(無圧縮)にすることで、
// Deflate実装の複雑さを持ち込まずに済ませている(Minecraftのインポートは無圧縮でも問題ない)。
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

function crc32(buf) {
  const table =
    crc32.table ??
    (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// zipのローカル/セントラルディレクトリヘッダが要求するMS-DOS形式の日付/時刻。
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

// srcDirを再帰的に走査し、配下の全ファイルをストア方式のzipとしてoutPathに書き出す。
export function zipDirectory(srcDir, outPath) {
  const entries = [];
  for (const relPath of readdirSync(srcDir, { recursive: true })) {
    const fullPath = join(srcDir, relPath);
    if (!statSync(fullPath).isFile()) continue;
    // zip内のパス区切りは常に "/" (Windows実行時の "\" を変換する)。
    entries.push({ name: relPath.split(sep).join("/"), data: readFileSync(fullPath) });
  }
  zipEntries(entries, outPath);
}

// 既に読み込んだ{name, data}のリストからzipを書き出す(.mcpack同士をまとめて.mcaddonにする時に使う)。
export function zipEntries(entries, outPath) {
  const { time, dosDate } = dosDateTime(new Date());
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression method: store
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    localChunks.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // compression method
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralChunks);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // number of this disk
  end.writeUInt16LE(0, 6); // disk where central directory starts
  end.writeUInt16LE(entries.length, 8); // central directory records on this disk
  end.writeUInt16LE(entries.length, 10); // total central directory records
  end.writeUInt32LE(centralDirBuf.length, 12); // size of central directory
  end.writeUInt32LE(centralDirStart, 16); // offset of start of central directory
  end.writeUInt16LE(0, 20); // comment length

  writeFileSync(outPath, Buffer.concat([...localChunks, centralDirBuf, end]));
}
