import { Block, Player } from "@minecraft/server";
import { CustomForm } from "@minecraft/server-ui";
import { findNetworkByController } from "./network";
import { submitOrganize } from "./organizeProcessing";
import { scanCatalog } from "./storageScan";

// 素手(レンチ以外)でコントローラを右クリックした時のUI。今のところ「倉庫の整理」のみ。
export function showControllerUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const network = findNetworkByController(dimension.id, block.location);
  if (!network) {
    player.sendMessage("§cこのコントローラのネットワーク情報が見つかりません。");
    return;
  }

  const form = new CustomForm(player, "倉庫コントローラ");
  form.label("接続されているストレージを走査し、スタック可能なアイテムをまとめて整理します。");
  form.button("倉庫の整理", () => {
    const catalog = scanCatalog(dimension, network);
    if (catalog.length === 0) {
      player.sendMessage("§e整理対象のアイテムがありません。");
      return;
    }
    const started = submitOrganize(
      network.id,
      catalog.map((entry) => ({ itemTypeId: entry.key.typeId, itemName: entry.key.name }))
    );
    player.sendMessage(started ? "§b倉庫の整理をキューに追加しました。" : "§eすでに整理中です。");
  });

  form.show().catch((e) => console.error(e));
}
