import { Block, Player, system } from "@minecraft/server";
import { CustomForm, ObservableBoolean, ObservableNumber } from "@minecraft/server-ui";
import { getNotifyOnOrganizeComplete, setNotifyOnOrganizeComplete } from "./controllerSettings";
import { listActiveDeposits } from "./depositProcessing";
import { findNetworkByController } from "./network";
import { listActiveOrders } from "./orderProcessing";
import { listActiveOrganize, submitOrganize } from "./organizeProcessing";
import { scanCatalog } from "./storageScan";
import { setupDepositStatusSection, setupOrderStatusSection, setupOrganizeStatusSection } from "./statusListUi";

// 素手(レンチ以外)でコントローラを右クリックした時のUI。「状況」「整理」「設定」の
// 3タブ構成(terminalUi.ts/autoTerminalUi.tsと同じく、タブの選択はdropdownで行う)。
export function showControllerUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const network = findNetworkByController(dimension.id, block.location);
  if (!network) {
    player.sendMessage("§cこのコントローラのネットワーク情報が見つかりません。");
    return;
  }

  // ドロップダウンの表示順・開いた直後のデフォルトタブのどちらも「状況」(value=0)。
  const isOrganizeTab = new ObservableBoolean(false);
  const isStatusTab = new ObservableBoolean(true);
  const isSettingsTab = new ObservableBoolean(false);

  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isStatusTab.setData(index === 0);
    isOrganizeTab.setData(index === 1);
    isSettingsTab.setData(index === 2);
  });

  const form = new CustomForm(player, "倉庫コントローラ");
  form.dropdown("", tabSelection, [
    { label: "状況", value: 0 },
    { label: "整理", value: 1 },
    { label: "設定", value: 2 },
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
      const organizeId = submitOrganize(
        network.id,
        player.name,
        catalog.map((entry) => ({ itemTypeId: entry.key.typeId, itemName: entry.key.name }))
      );
      player.sendMessage(
        organizeId ? `§b倉庫の整理 #${organizeId} をキューに追加しました。` : "§eすでに整理中です。"
      );
    },
    { visible: isOrganizeTab }
  );

  // コントローラの「状況」タブはネットワーク全体が対象(ターミナルUIの「状況」タブは
  // その端末に絞り込む。statusListUi.ts参照)。
  const orderStatusRefreshTimer = setupOrderStatusSection(form, isStatusTab, dimension, player, network.id, () =>
    listActiveOrders(network.id)
  );
  form.divider({ visible: isStatusTab });
  const depositStatusRefreshTimer = setupDepositStatusSection(form, isStatusTab, dimension, player, network.id, () =>
    listActiveDeposits(network.id)
  );
  form.divider({ visible: isStatusTab });
  const organizeStatusRefreshTimer = setupOrganizeStatusSection(form, isStatusTab, player, network.id, () =>
    listActiveOrganize(network.id)
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

  form
    .show()
    .catch((e) => console.error(e))
    .finally(() => {
      system.clearRun(orderStatusRefreshTimer);
      system.clearRun(depositStatusRefreshTimer);
      system.clearRun(organizeStatusRefreshTimer);
    });
}
