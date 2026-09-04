import { ItemStack, Player, system, world } from "@minecraft/server";
import { CustomForm, ObservableBoolean, ObservableNumber, ObservableString } from "@minecraft/server-ui";
import { getControllerName } from "./controllerSettings";
import { hasActiveDeliveryOrderFor, listActiveOrders, submitOrder } from "./orderProcessing";
import {
  checkRemoteDeliveryAccess,
  getHeldRemoteDeliveryTerminal,
  getRemoteNotifyOnComplete,
  getRemoteTerminalName,
  setRemoteNotifyOnComplete,
  setRemoteTerminalName,
  unlinkHeldItem,
} from "./remoteDeliveryTerminalItem";
import { NetworkData } from "./state";
import { setupOrderStatusSection } from "./statusListUi";
import { CatalogEntry, scanCatalog } from "./storageScan";
import { CartLine, setupTab } from "./terminalUi";

// 引き出しタブ: 通常のターミナル(terminalUi.tsのshowOrderUi)と全く同じsetupTabをそのまま
// 再利用する(ブロック非依存のシグネチャのため流用できた)。配達ターミナルと違い、確定の直前に
// 「アイテムをまだ持っているか」「まだ範囲内か」を再確認する(UIを開いてから確定するまでの
// 間に手放す/離れる可能性があるため)。
function setupWithdrawTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  player: Player,
  network: NetworkData,
  catalog: CatalogEntry[],
  locale: string
): void {
  setupTab(form, tabVisible, catalog, "確定", locale, (lines: CartLine[]) => {
    if (hasActiveDeliveryOrderFor(player.name)) {
      player.sendMessage("§cあなたへの配達が既に進行中です。完了までお待ちください。");
      return false;
    }
    const item = getHeldRemoteDeliveryTerminal(player);
    if (!item) {
      player.sendMessage("§cリモート配達ターミナルを手放しています。");
      return false;
    }
    const accessError = checkRemoteDeliveryAccess(player, network);
    if (accessError) {
      player.sendMessage(accessError);
      return false;
    }

    const remote = { notifyOnComplete: getRemoteNotifyOnComplete(item), terminalName: getRemoteTerminalName(item) };
    const orderId = submitOrder(network.id, network.controller, player.name, lines, remote);
    const namePrefix = remote.terminalName ? `「${remote.terminalName}」の` : "";
    player.sendMessage(`§b${namePrefix}引き出し #${orderId} をネットワークへ送信しました。`);
    return true;
  });
}

// 設定タブ: 名前・完了時通知(terminalUi.tsのsetupSettingsTabと同じ構成)に加えて、
// リンク解除ボタンを持つ(位置を持たないアイテムなので、レンチでの切断に相当する操作)。
function setupSettingsTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  player: Player,
  initialName: string,
  initialNotifyOnComplete: boolean
): void {
  const name = new ObservableString(initialName, { clientWritable: true });
  name.subscribe((value) => setRemoteTerminalName(player, value));

  const notifyOnComplete = new ObservableBoolean(initialNotifyOnComplete, { clientWritable: true });
  notifyOnComplete.subscribe((value) => setRemoteNotifyOnComplete(player, value));

  form.label("このリモート配達ターミナルの設定です。", { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.textField("名前", name, {
    description: "通知時に表示されます。",
    visible: tabVisible,
  });
  form.toggle("引き出し完了時に通知を表示する", notifyOnComplete, { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.button(
    "リンクを解除する",
    () => {
      unlinkHeldItem(player);
      player.sendMessage("§eリモート配達ターミナルのリンクを解除しました。");
      form.close();
    },
    { visible: tabVisible }
  );
}

// 「引き出し」「状況」「設定」の3タブ構成(terminalUi.tsのshowOrderUiと違い、張り付いた先の
// コンテナが無いため「預け入れ」タブは無い)。
export function showRemoteDeliveryUi(player: Player, item: ItemStack, network: NetworkData): void {
  const dimension = world.getDimension(network.dimensionId);
  const catalog = scanCatalog(dimension, network);
  const terminalName = getRemoteTerminalName(item);

  const isOrderTab = new ObservableBoolean(true);
  const isStatusTab = new ObservableBoolean(false);
  const isSettingsTab = new ObservableBoolean(false);

  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isOrderTab.setData(index === 0);
    isStatusTab.setData(index === 1);
    isSettingsTab.setData(index === 2);
  });

  const form = new CustomForm(player, terminalName ? `リモート配達: ${terminalName}` : "リモート配達ターミナル");
  form.dropdown("", tabSelection, [
    { label: "引き出し", value: 0 },
    { label: "状況", value: 1 },
    { label: "設定", value: 2 },
  ]);
  form.divider();

  setupWithdrawTab(form, isOrderTab, player, network, catalog, player.clientSystemInfo.locale);

  // リンク先が見た目で分からず判別しづらいという指摘を受け、状況タブの先頭にリンク先の
  // コントローラ名を表示する。当初は生のnetwork.id(生成されたランダムな文字列)を表示して
  // いたが、日本語と英数字が混ざって読みにくい(実機で文字化けのように見えると指摘された)上に
  // プレイヤーに優しくないため、コントローラにも名前を付けられるようにして(controllerSettings.ts
  // のgetControllerName、ターミナルと同じ考え方)、そちらを表示するように変更した。
  form.label(`リンク先のコントローラ: ${getControllerName(dimension, network.controller)}`, { visible: isStatusTab });
  form.divider({ visible: isStatusTab });
  // このアイテム(このプレイヤーのリモート注文)分だけに絞り込む(通常のターミナルの
  // 「状況」タブがそのブロックのlocEqualsで絞り込むのと同じ考え方)。
  const orderStatusRefreshTimer = setupOrderStatusSection(form, isStatusTab, dimension, player, network.id, () =>
    listActiveOrders(network.id).filter((order) => order.remote !== undefined && order.playerName === player.name)
  );

  setupSettingsTab(form, isSettingsTab, player, terminalName ?? "", getRemoteNotifyOnComplete(item));

  form
    .show()
    .catch((e) => console.error(e))
    .finally(() => {
      system.clearRun(orderStatusRefreshTimer);
    });
}
