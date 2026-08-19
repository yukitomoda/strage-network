// prod(リリース)用の.mcaddonパッケージを生成するビルドスクリプト。
// dev(BP/RP)の内容を丸ごとコピーし、manifest.jsonだけprod用のUUID/名前に差し替えた上で、
// .mcpack x2 -> .mcaddon の順にzip化する。実行前に `npm run build` 済みであることが前提
// (BP/scripts/main.js等の最新化)。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BP_MCPACK_NAME,
  MCADDON_NAME,
  OUTPUT_DIR,
  PROD_BP_NAME,
  PROD_RP_NAME,
  PROD_UUIDS,
  RP_MCPACK_NAME,
} from "./releaseConfig.mjs";
import { zipDirectory, zipEntries } from "./zip.mjs";

const distBp = join(OUTPUT_DIR, "BP");
const distRp = join(OUTPUT_DIR, "RP");

// 古いdist/が残っていると、devから削除済みのファイルがzipに混入する事故になるため、
// 毎回まっさらな状態から作り直す。
if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

cpSync("BP", distBp, { recursive: true });
cpSync("RP", distRp, { recursive: true });
console.log(`コピー: BP -> ${distBp}`);
console.log(`コピー: RP -> ${distRp}`);

// dev側のmanifest.json(手動管理のversion等)をベースに、識別情報(uuid/name)だけprod用へ
// 差し替える。module種別で照合しているので、将来modules配列の並び順が変わっても壊れない。
function rewriteManifest(manifestPath, { headerUuid, name, moduleUuids, dependencyUuid }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.header.uuid = headerUuid;
  manifest.header.name = name;
  for (const mod of manifest.modules) {
    if (mod.type in moduleUuids) mod.uuid = moduleUuids[mod.type];
  }
  // dependencies[0] は相互参照しているもう一方のパック(BP<->RP)のuuid固定という前提
  // (BP/manifest.json・RP/manifest.jsonの現行の並び順に合わせている)。
  manifest.dependencies[0].uuid = dependencyUuid;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

rewriteManifest(join(distBp, "manifest.json"), {
  headerUuid: PROD_UUIDS.bpHeader,
  name: PROD_BP_NAME,
  moduleUuids: { data: PROD_UUIDS.bpDataModule, script: PROD_UUIDS.bpScriptModule },
  dependencyUuid: PROD_UUIDS.rpHeader,
});
rewriteManifest(join(distRp, "manifest.json"), {
  headerUuid: PROD_UUIDS.rpHeader,
  name: PROD_RP_NAME,
  moduleUuids: { resources: PROD_UUIDS.rpResourcesModule },
  dependencyUuid: PROD_UUIDS.bpHeader,
});
console.log("manifest.jsonをprod用に書き換えました");

const bpMcpackPath = join(OUTPUT_DIR, BP_MCPACK_NAME);
const rpMcpackPath = join(OUTPUT_DIR, RP_MCPACK_NAME);
zipDirectory(distBp, bpMcpackPath);
zipDirectory(distRp, rpMcpackPath);
console.log(`written: ${bpMcpackPath}`);
console.log(`written: ${rpMcpackPath}`);

const mcaddonPath = join(OUTPUT_DIR, MCADDON_NAME);
zipEntries(
  [
    { name: BP_MCPACK_NAME, data: readFileSync(bpMcpackPath) },
    { name: RP_MCPACK_NAME, data: readFileSync(rpMcpackPath) },
  ],
  mcaddonPath
);
console.log(`written: ${mcaddonPath}`);
