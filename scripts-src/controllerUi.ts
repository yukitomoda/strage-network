import { Block, Player } from "@minecraft/server";
import { CustomForm, ObservableBoolean, ObservableNumber } from "@minecraft/server-ui";
import { getNotifyOnOrganizeComplete, setNotifyOnOrganizeComplete } from "./controllerSettings";
import { findNetworkByController } from "./network";
import { submitOrganize } from "./organizeProcessing";
import { scanCatalog } from "./storageScan";

// 素手(レンチ以外)でコントローラを右クリックした時のUI。「整理」「設定」の2タブ構成
// (terminalUi.ts/autoTerminalUi.tsと同じく、タブの選択はdropdownで行う)。
export function showControllerUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const network = findNetworkByController(dimension.id, block.location);
  if (!network) {
    player.sendMessage("§cこのコントローラのネットワーク情報が見つかりません。");
    return;
  }

  const isOrganizeTab = new ObservableBoolean(true);
  const isSettingsTab = new ObservableBoolean(false);

  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isOrganizeTab.setData(index === 0);
    isSettingsTab.setData(index === 1);
  });

  const form = new CustomForm(player, "倉庫コントローラ");
  form.dropdown("", tabSelection, [
    { label: "整理", value: 0 },
    { label: "設定", value: 1 },
  ]);
  form.divider();

  form.label("接続されているストレージを走査し、スタック可能なアイテムをまとめて整理します。", {
    visible: isOrganizeTab,
  });
  form.button(
    "倉庫の整理",
    () => {
      const catalog = scanCatalog(dimension, network);
      if (catalog.length === 0) {
        player.sendMessage("§e整理対象のアイテムがありません。");
        return;
      }
      const started = submitOrganize(
        network.id,
        player.name,
        catalog.map((entry) => ({ itemTypeId: entry.key.typeId, itemName: entry.key.name }))
      );
      player.sendMessage(started ? "§b倉庫の整理をキューに追加しました。" : "§eすでに整理中です。");
    },
    { visible: isOrganizeTab }
  );

  const notifyOnComplete = new ObservableBoolean(getNotifyOnOrganizeComplete(dimension, block.location), {
    clientWritable: true,
  });
  notifyOnComplete.subscribe((value) => {
    setNotifyOnOrganizeComplete(dimension, block.location, value);
  });

  form.label("このコントローラの設定です。", { visible: isSettingsTab });
  form.divider({ visible: isSettingsTab });
  form.toggle("整理完了時に通知する", notifyOnComplete, { visible: isSettingsTab });

  form.show().catch((e) => console.error(e));
}
