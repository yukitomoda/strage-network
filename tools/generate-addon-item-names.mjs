// このアドオン自身のアイテム/ブロック名(RP/texts/*.lang)から、検索用の
// localizationKey -> 表示名テーブルを生成する。Minecraft本体を必要としないため
// `npm run build`のたびに毎回実行し、常に最新の状態を保証する(tools/generate-vanilla-item-names.mjs
// とは更新頻度が異なるため分離している。docs/design.md参照)。
import { readFileSync, writeFileSync } from "node:fs";

const LOCALES = ["en_US", "ja_JP"];
// このアドオンのlangファイルは、ブロック(block_placerアイテム含む)は"tile.wh:xxx.name"、
// 純粋なアイテムは"tile.wh:xxx.name"を持たず"item.wh:xxx"(接尾辞なし)という2つの命名規則が
// 混在している(BP/items/*.jsonのminecraft:display_name.valueの実際の値と一致させている)。
// 素朴に"item.wh:xxx.desc.1"のような説明文キーまで拾ってしまわないよう、識別子の後に
// さらにドット区切りが続かない形だけを対象にする。
const NAME_LINE = /^(tile\.wh:[a-z0-9_]+\.name|item\.wh:[a-z0-9_]+)=(.*)$/;

function extract(path) {
  const text = readFileSync(path, "utf8");
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(NAME_LINE);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

const result = {};
for (const locale of LOCALES) {
  result[locale] = extract(`RP/texts/${locale}.lang`);
}

writeFileSync("scripts-src/addonItemNames.json", JSON.stringify(result));
console.log(
  `written: scripts-src/addonItemNames.json (${LOCALES.map((l) => `${l}: ${Object.keys(result[l]).length}`).join(", ")})`
);
