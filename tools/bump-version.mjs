// CDワークフロー専用。BP/RP両方のmanifest.jsonにあるバージョン番号
// (header.version・modules[].version・お互いを指すdependencies[].version)のpatchだけ+1する。
// JSON.parse->JSON.stringifyで書き戻すと、手動整形されている1行の配列表記([0, 3, 0])が
// 複数行に展開されて無関係な差分が大量に出てしまうため、対象の"version": [a, b, c]パターンだけを
// 正規表現でその場書き換えする("min_engine_version"は"version":という文字列を含まないため誤爆しない)。
import { readFileSync, writeFileSync } from "node:fs";

const VERSION_PATTERN = /"version": \[(\d+), (\d+), (\d+)\]/g;

function currentVersion(path) {
  const text = readFileSync(path, "utf8");
  VERSION_PATTERN.lastIndex = 0;
  const match = VERSION_PATTERN.exec(text);
  if (!match) throw new Error(`${path}: "version": [a, b, c] が見つかりません`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function writeVersion(path, [major, minor, patch]) {
  const text = readFileSync(path, "utf8");
  const replaced = text.replace(VERSION_PATTERN, `"version": [${major}, ${minor}, ${patch}]`);
  writeFileSync(path, replaced);
}

// アドオンの説明文にもバージョンを含めたい(ユーザー要望)。説明文末尾の" vX.Y.Z"だけを
// 対象にした正規表現のその場書き換えにすることで、初回(まだ付いていない)・2回目以降
// (前のバージョンが付いている)のどちらでも同じ処理で済む。manifest.json側は
// "description": "..."の形、lang側はpack.description=...の形と構文が違うため別々の
// 関数にしている。
const MANIFEST_DESCRIPTION_PATTERN = /("description": ")([^"]*?)(?: v\d+\.\d+\.\d+)?(")/;
const LANG_DESCRIPTION_PATTERN = /^(pack\.description=.*?)(?: v\d+\.\d+\.\d+)?$/m;

function writeManifestDescription(path, versionString) {
  const text = readFileSync(path, "utf8");
  const replaced = text.replace(MANIFEST_DESCRIPTION_PATTERN, `$1$2 v${versionString}$3`);
  writeFileSync(path, replaced);
}

function writeLangDescription(path, versionString) {
  const text = readFileSync(path, "utf8");
  const replaced = text.replace(LANG_DESCRIPTION_PATTERN, `$1 v${versionString}`);
  writeFileSync(path, replaced);
}

const [major, minor, patch] = currentVersion("BP/manifest.json");
const newVersion = [major, minor, patch + 1];

writeVersion("BP/manifest.json", newVersion);
writeVersion("RP/manifest.json", newVersion);

const versionString = newVersion.join(".");

writeManifestDescription("BP/manifest.json", versionString);
writeManifestDescription("RP/manifest.json", versionString);
writeLangDescription("RP/texts/ja_JP.lang", versionString);
writeLangDescription("RP/texts/en_US.lang", versionString);

console.log(`version bumped to ${versionString}`);

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `version=${versionString}\n`, { flag: "a" });
}
