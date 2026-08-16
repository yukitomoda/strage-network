import { Block, Dimension, ItemStack, Player, system } from "@minecraft/server";
import {
  CustomForm,
  ObservableBoolean,
  ObservableNumber,
  ObservableString,
  ObservableUIRawMessage,
  UIRawMessage,
} from "@minecraft/server-ui";
import { getNotifyOnOrganizeComplete, setNotifyOnOrganizeComplete } from "./controllerSettings";
import { findNetworkByController } from "./network";
import { cancelOrder, listActiveOrders } from "./orderProcessing";
import { submitOrganize } from "./organizeProcessing";
import { Order } from "./state";
import { scanCatalog } from "./storageScan";
import { getTerminalName } from "./terminalSettings";

const ROW_COUNT = 8;
// 「状況」タブを表示中に一覧を自動更新する間隔。form.show()はプレイヤーがフォームを
// 閉じるまで解決しないPromiseを返す仕組み(DDUI)なので、その完了時にclearRunすれば
// タイマーを残さず安全に自動更新できる。
// 短すぎるとラベル更新のたびにTooltipが一瞬消えて再表示されチラつく(実機で確認)ため、
// 5秒(100tick)に設定している。
const STATUS_REFRESH_INTERVAL_TICKS = 100;

function orderLabel(order: Order, dimension: Dimension): UIRawMessage {
  const terminalName = getTerminalName(dimension, order.terminal) ?? "端末";
  const who = order.playerName || "自動";
  return { text: `#${order.id} ${terminalName} (${who})` };
}

// 品目ごとの「配送済み/要求数」を色分けして並べたツールチップ(§書式コードが効くのは
// ボタンのtooltipだけ、詳細はdocs/design.md 7章参照)。
function orderTooltip(order: Order): UIRawMessage {
  const parts: UIRawMessage[] = [];
  order.lines.forEach((line, i) => {
    if (i > 0) parts.push({ text: "\n" });
    const color = line.exhausted ? "§c" : line.delivered >= line.requested ? "§a" : "§e";
    parts.push({ text: `${color}${line.delivered}/${line.requested} ` });
    parts.push(
      line.itemName ? { text: line.itemName } : { translate: new ItemStack(line.itemTypeId, 1).localizationKey }
    );
    if (line.exhausted) parts.push({ text: "§c(品切れ)" });
  });
  parts.push({ text: "\n§7タップでキャンセルします(配送済みの分は返送されません)。" });
  return { rawtext: parts };
}

// 「状況」タブ: 進行中の引き出し一覧。タップでキャンセルする(巻き戻しはせず、
// 残りの未処理ラインだけを取り消す。詳細はorderProcessing.tsのprocessOrderCancels参照)。
// 戻り値のtimer idは、呼び出し元(showControllerUi)がform.show()の完了時にclearRunする。
function setupStatusTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  player: Player,
  networkId: string
): number {
  // キャンセルは次tickのprocessNetworkOrdersで実際に取り除かれるため、それまでの間も
  // 見た目には即座に反映されるよう、このUIセッション内でキャンセル済みのrequestIdを
  // 覚えておいてlistActiveOrdersの結果から除外する。
  const cancelledIds = new Set<string>();

  const rowLabels: ObservableUIRawMessage[] = [];
  const rowTooltips: ObservableUIRawMessage[] = [];
  const rowVisible: ObservableBoolean[] = [];
  let filtered: Order[] = [];

  let currentPage = 0;
  const hasPrevPage = new ObservableBoolean(false);
  const hasNextPage = new ObservableBoolean(false);
  const pageLabel = new ObservableString("1 / 1 ページ");

  function refresh(): void {
    const all = listActiveOrders(networkId).filter((order) => !cancelledIds.has(order.requestId));
    const totalPages = Math.max(1, Math.ceil(all.length / ROW_COUNT));
    currentPage = Math.min(Math.max(currentPage, 0), totalPages - 1);

    filtered = all.slice(currentPage * ROW_COUNT, (currentPage + 1) * ROW_COUNT);
    for (let i = 0; i < ROW_COUNT; i++) {
      const order = filtered[i];
      rowVisible[i].setData(!!order);
      rowLabels[i].setData(order ? orderLabel(order, dimension) : { text: "" });
      rowTooltips[i].setData(order ? orderTooltip(order) : { text: "" });
    }

    hasPrevPage.setData(currentPage > 0);
    hasNextPage.setData(currentPage < totalPages - 1);
    pageLabel.setData(`${currentPage + 1} / ${totalPages} ページ`);
  }

  tabVisible.subscribe((active) => {
    if (active) {
      refresh();
    } else {
      // タブ非表示中はページャーボタンも隠す(AND合成が無いための対処、他タブと同じ)。
      hasPrevPage.setData(false);
      hasNextPage.setData(false);
    }
  });

  form.label("進行中の引き出しの一覧です。タップでキャンセルします。", { visible: tabVisible });
  form.label(pageLabel, { visible: tabVisible });

  form.button(
    "▲ 前のページ",
    () => {
      currentPage--;
      refresh();
    },
    { visible: hasPrevPage }
  );

  for (let i = 0; i < ROW_COUNT; i++) {
    const label = new ObservableUIRawMessage({ text: "" });
    const tooltip = new ObservableUIRawMessage({ text: "" });
    const visible = new ObservableBoolean(false);
    rowLabels.push(label);
    rowTooltips.push(tooltip);
    rowVisible.push(visible);
    tabVisible.subscribe((active) => {
      if (!active) visible.setData(false);
    });

    form.button(
      label,
      () => {
        const order = filtered[i];
        if (!order) return;
        cancelOrder(networkId, order.requestId);
        cancelledIds.add(order.requestId);
        player.sendMessage(`§e引き出し #${order.id} をキャンセルしました。`);
        refresh();
      },
      { visible, tooltip }
    );
  }

  form.button(
    "▼ 次のページ",
    () => {
      currentPage++;
      refresh();
    },
    { visible: hasNextPage }
  );

  // タブを開いている間、一覧を定期的に自動更新する(他プレイヤーの操作や自動端末による
  // 新規引き出し・進捗の変化を反映するため)。タイマーの停止はshowControllerUi側で行う。
  return system.runInterval(() => {
    if (tabVisible.getData()) refresh();
  }, STATUS_REFRESH_INTERVAL_TICKS);
}

// 素手(レンチ以外)でコントローラを右クリックした時のUI。「整理」「状況」「設定」の
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
      const started = submitOrganize(
        network.id,
        player.name,
        catalog.map((entry) => ({ itemTypeId: entry.key.typeId, itemName: entry.key.name }))
      );
      player.sendMessage(started ? "§b倉庫の整理をキューに追加しました。" : "§eすでに整理中です。");
    },
    { visible: isOrganizeTab }
  );

  const statusRefreshTimer = setupStatusTab(form, isStatusTab, dimension, player, network.id);

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
    .finally(() => system.clearRun(statusRefreshTimer));
}
