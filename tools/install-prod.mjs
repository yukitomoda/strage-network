// dist/StorageNetwork.mcaddon をOS既定の関連付け(Minecraft)で開く。実際に配布する.mcaddonと
// 全く同じインポート経路を自分自身でも通ることで、生成物が正しくインポートできることを検証する。
// dev用のtools/install.mjs(シンボリックリンク配置)とは仕組みが根本的に異なるため、
// 別スクリプトに分離している。
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { join } from "node:path";
import { MCADDON_NAME, OUTPUT_DIR } from "./releaseConfig.mjs";

const mcaddonPath = join(OUTPUT_DIR, MCADDON_NAME);
if (!existsSync(mcaddonPath)) {
  console.error(`${mcaddonPath} が見つかりません(先に mise run release を実行してください)`);
  process.exit(1);
}

if (process.platform !== "win32") {
  console.error("install-prod.mjs は現状Windows専用です(startコマンドを使用)。");
  process.exit(1);
}

// Windowsの `start` はcmd.exeの組み込みコマンド。パスをダブルクオートで囲む場合は
// 先頭にウィンドウタイトル引数が必要になるため、空文字("")を渡している。
exec(`start "" "${mcaddonPath}"`, (err) => {
  if (err) {
    console.error("起動に失敗しました:", err.message);
    process.exit(1);
  }
  console.log(`${mcaddonPath} を開きました。Minecraftのインポート画面を確認してください。`);
});
