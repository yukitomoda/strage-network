// バニラのアイテム/ブロック名(Minecraft本体のリソースパックのlangファイル)から、検索用の
// localizationKey -> 表示名テーブルを生成する。CIにはMinecraft本体が無いためこのスクリプトは
// `npm run build`には組み込まず、開発者がローカルで手動実行して結果(scripts-src/vanillaItemNames.json)
// をコミットする運用にする(docs/design.md参照)。Minecraftのアップデートで新アイテムが増えた時などに
// 再実行する。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCALES = ["en_US", "ja_JP"];
const NAME_LINE = /^((?:item|tile|block)\.[^=]+\.name)=(.*)$/;

// 環境変数で上書き可能(既定値はこの開発機にインストール済みのMinecraft本体のパス)。
const MC_INSTALL_PATH =
  process.env.MC_INSTALL_PATH ??
  "C:/Program Files/WindowsApps/Microsoft.MinecraftUWP_1.26.4403.0_x64__8wekyb3d8bbwe";
const VANILLA_TEXTS_DIR = join(MC_INSTALL_PATH, "data/resource_packs/vanilla/texts");

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
  result[locale] = extract(join(VANILLA_TEXTS_DIR, `${locale}.lang`));
}

writeFileSync("scripts-src/vanillaItemNames.json", JSON.stringify(result));
console.log(
  `written: scripts-src/vanillaItemNames.json (${LOCALES.map((l) => `${l}: ${Object.keys(result[l]).length}`).join(", ")})`
);
