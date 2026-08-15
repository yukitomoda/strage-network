// BP/RP を Minecraft の development_*_packs フォルダに配置するタスク。
// Windows では管理者権限が要らない「ジャンクション」でリンクし、
// 作れない環境(別OS等)ではフォルダを丸ごとコピーする。
import { existsSync, mkdirSync, lstatSync, rmSync, symlinkSync, cpSync, readlinkSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const mode = args.includes("--copy") ? "copy" : "link";
const shouldRemove = args.includes("--remove");

const comMojang = process.env.MC_COM_MOJANG;
if (!comMojang) {
  console.error("環境変数 MC_COM_MOJANG が設定されていません。mise.toml の [env] を確認してください。");
  process.exit(1);
}

const bpName = process.env.MC_BP_NAME || "ExampleAddonBP";
const rpName = process.env.MC_RP_NAME || "ExampleAddonRP";

const packs = [
  { src: resolve("BP"), dest: join(comMojang, "development_behavior_packs", bpName) },
  { src: resolve("RP"), dest: join(comMojang, "development_resource_packs", rpName) },
];

if (shouldRemove) {
  for (const { dest } of packs) {
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
      console.log(`削除: ${dest}`);
    } else {
      console.log(`未配置(スキップ): ${dest}`);
    }
  }
  process.exit(0);
}

for (const { src, dest } of packs) {
  if (!existsSync(src)) {
    console.error(`ソースが見つかりません: ${src} (先に npm run build を実行してください)`);
    process.exit(1);
  }

  mkdirSync(join(dest, ".."), { recursive: true });

  if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
    const st = lstatSync(dest, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      const current = readlinkSync(dest);
      if (resolve(current) === src) {
        console.log(`リンク済み(変更なし): ${dest} -> ${src}`);
        continue;
      }
      rmSync(dest, { recursive: true, force: true });
    } else if (st) {
      const backup = `${dest}.bak-${Date.now()}`;
      console.log(`既存フォルダをバックアップ: ${dest} -> ${backup}`);
      cpSync(dest, backup, { recursive: true });
      rmSync(dest, { recursive: true, force: true });
    }
  }

  if (mode === "link") {
    try {
      symlinkSync(src, dest, "junction");
      console.log(`リンク作成: ${dest} -> ${src}`);
      continue;
    } catch (err) {
      console.warn(`リンク作成に失敗、コピーにフォールバック: ${err.message}`);
    }
  }

  cpSync(src, dest, { recursive: true });
  console.log(`コピー: ${src} -> ${dest}`);
}

console.log("\n配置完了。Minecraft を起動し、ワールド設定の「ベータAPIを含める」を有効にした上で");
console.log(`ビヘイビアパック「${bpName}」とリソースパック「${rpName}」を有効化してください。`);
