import { Block, Container, Dimension, Player, system, Vector3 } from "@minecraft/server";
import {
  CustomForm,
  ObservableBoolean,
  ObservableNumber,
  ObservableString,
  ObservableUIRawMessage,
  UIRawMessage,
} from "@minecraft/server-ui";
import { findMembership } from "./network";
import { listActiveDeposits, submitDeposit } from "./depositProcessing";
import { matchesSearchQuery } from "./itemIdentity";
import { hasActiveDeliveryOrderFor, listActiveOrders, submitOrder } from "./orderProcessing";
import { setupDepositStatusSection, setupOrderStatusSection } from "./statusListUi";
import { CatalogEntry, scanCatalog, scanContainerCatalog } from "./storageScan";
import { DELIVERY_TERMINAL_BLOCK_ID, getAttachedStorageLocation } from "./terminalBlock";
import { getNotifyOnComplete, getTerminalName, setNotifyOnComplete, setTerminalName } from "./terminalSettings";
import { DepositLine, locEquals } from "./state";

const ROW_COUNT = 8;

// 引き出し/預け入れのどちらのカートラインも同じ形なので共通の型で扱う。
type CartLine = {
  itemTypeId: string;
  itemName?: string;
  requested: number;
  delivered: number;
  exhausted: boolean;
};

// 引き出しタブ/預け入れタブそれぞれの「検索+数量+結果一覧+確定」を組み立てる共通処理。
// タブの切り替えは全コントロールを visible で出し分けるだけ(DDUIにタブ専用の部品は無いため)。
function setupTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  catalog: CatalogEntry[],
  confirmLabel: string,
  locale: string,
  // 戻り値はtrueなら送信成功(カートを空にしてフォームを閉じる)、falseなら拒否
  // (カート・フォームともそのまま保持し、プレイヤーが少し待って再度確定できるようにする)。
  onConfirm: (lines: CartLine[]) => boolean
): void {
  const cart: CartLine[] = [];
  const searchText = new ObservableString("", { clientWritable: true });
  const quantity = new ObservableNumber(1, { clientWritable: true });
  const increaseMode = new ObservableBoolean(true, { clientWritable: true }); // OFF: 増やす / ON: 減らす

  const rowLabels: ObservableUIRawMessage[] = [];
  const rowVisible: ObservableBoolean[] = [];
  let filtered: CatalogEntry[] = [];

  // ページャー: 絞り込み結果がROW_COUNTを超える場合に前/次ページへ移動できるようにする。
  let currentPage = 0;
  const hasPrevPage = new ObservableBoolean(false);
  const hasNextPage = new ObservableBoolean(false);
  const pageLabel = new ObservableString("1 / 1 ページ");
  // ページが1つしか無い(=ほぼ常にそう)場合にまで「1 / 1 ページ」を表示すると煩わしいため、
  // 2ページ以上ある時だけ表示する。
  const showPageLabel = new ObservableBoolean(false);

  // カートに入っている数量を「{カート数}/{在庫数} {品名}」の形で行ラベルに表示する
  // (下部の合計カート表示は不要になったため廃止した)。
  function cartQuantityFor(entry: CatalogEntry): number {
    const line = cart.find((l) => l.itemTypeId === entry.key.typeId && (l.itemName ?? "") === (entry.key.name ?? ""));
    return line?.requested ?? 0;
  }

  function rowMessage(entry: CatalogEntry): UIRawMessage {
    const namePart: UIRawMessage = entry.key.name ? { text: entry.key.name } : { translate: entry.localizationKey };
    return { rawtext: [{ text: `${cartQuantityFor(entry)}/${entry.total} ` }, namePart] };
  }

  function refreshFilter(): void {
    const q = searchText.getData();
    const allMatches = catalog.filter((entry) => matchesSearchQuery(entry, q, locale));
    const totalPages = Math.max(1, Math.ceil(allMatches.length / ROW_COUNT));
    currentPage = Math.min(Math.max(currentPage, 0), totalPages - 1);

    filtered = allMatches.slice(currentPage * ROW_COUNT, (currentPage + 1) * ROW_COUNT);
    for (let i = 0; i < ROW_COUNT; i++) {
      const entry = filtered[i];
      rowVisible[i].setData(!!entry);
      rowLabels[i].setData(entry ? rowMessage(entry) : { text: "" });
    }

    hasPrevPage.setData(currentPage > 0);
    hasNextPage.setData(currentPage < totalPages - 1);
    pageLabel.setData(`${currentPage + 1} / ${totalPages} ページ`);
    showPageLabel.setData(totalPages > 1);
  }

  // visible は「タブが選択中」と「絞り込みに引っかかっている」の両方を満たす時だけ true にしたいが、
  // ObservableBoolean同士のAND合成手段が無いため、タブ切り替え時にも絞り込みを再適用して対応する。
  tabVisible.subscribe((active) => {
    if (active) refreshFilter();
  });

  const increaseModeLabel = new ObservableString(increaseMode.getData() ? "増やす" : "減らす");
  increaseMode.subscribe((isIncrease) => increaseModeLabel.setData(isIncrease ? "増やす" : "減らす"));

  form.slider("数量", quantity, 1, 64, { step: 1, visible: tabVisible });
  form.toggle(increaseModeLabel, increaseMode, {
    visible: tabVisible,
  });
  form.textField("検索", searchText, { visible: tabVisible });

  // タブ非表示中はページャーボタンも隠す(rowVisibleFlagと同じ、AND合成が無いための対処)。
  tabVisible.subscribe((active) => {
    if (!active) {
      hasPrevPage.setData(false);
      hasNextPage.setData(false);
      showPageLabel.setData(false);
    }
  });

  form.label(pageLabel, { visible: showPageLabel });

  form.button(
    "▲ 前のページ",
    () => {
      currentPage--;
      refreshFilter();
    },
    { visible: hasPrevPage }
  );

  for (let i = 0; i < ROW_COUNT; i++) {
    const label = new ObservableUIRawMessage({ text: "" });
    const rowVisibleFlag = new ObservableBoolean(false);
    rowLabels.push(label);
    rowVisible.push(rowVisibleFlag);

    // このボタン自体の表示条件は「タブ選択中 かつ 絞り込みに該当」の両方だが、
    // ObservableBooleanのAND合成が無いため、タブ非表示中は絞り込み側を false に固定しておく。
    tabVisible.subscribe((active) => {
      if (!active) rowVisibleFlag.setData(false);
    });

    form.button(
      label,
      () => {
        const entry = filtered[i];
        if (!entry) return;
        const amount = Math.max(1, Math.floor(quantity.getData()));
        const existingIndex = cart.findIndex(
          (l) => l.itemTypeId === entry.key.typeId && (l.itemName ?? "") === (entry.key.name ?? "")
        );

        if (!increaseMode.getData()) {
          if (existingIndex === -1) return; // カートに無い品目は減らせない
          const existing = cart[existingIndex];
          existing.requested -= amount;
          if (existing.requested <= 0) cart.splice(existingIndex, 1); // 0以下になったらカートから外す
        } else if (existingIndex !== -1) {
          cart[existingIndex].requested = Math.min(cart[existingIndex].requested + amount, entry.total); // 在庫数を超えないようにする
        } else {
          cart.push({
            itemTypeId: entry.key.typeId,
            itemName: entry.key.name,
            requested: Math.min(amount, entry.total),
            delivered: 0,
            exhausted: false,
          });
        }
        label.setData(rowMessage(entry)); // このスロットの表示だけカート数を反映して更新する
      },
      { visible: rowVisibleFlag }
    );
  }

  form.button(
    "▼ 次のページ",
    () => {
      currentPage++;
      refreshFilter();
    },
    { visible: hasNextPage }
  );

  form.divider({ visible: tabVisible });
  form.button(
    confirmLabel,
    () => {
      if (cart.length === 0) return;
      const success = onConfirm(cart.map((l) => ({ ...l })));
      if (success) {
        cart.length = 0;
        form.close();
      }
    },
    { visible: tabVisible }
  );

  searchText.subscribe(() => {
    currentPage = 0; // 新しい検索条件では1ページ目から見せる
    if (tabVisible.getData()) refreshFilter();
  });
  if (tabVisible.getData()) refreshFilter();
}

// 預け入れタブ: 数量指定は不要で、張り付いた先のコンテナに今入っている物を全部まとめて
// 1回のリクエストにするワンボタン方式。DepositRequest/DepositLine自体は個数を持てる
// 形のままなので、将来「一部だけ預け入れ」に変えたくなってもデータ構造の変更は不要。
function setupDepositTab(
  form: CustomForm,
  player: Player,
  tabVisible: ObservableBoolean,
  container: Container | undefined,
  networkId: string,
  terminalLoc: Vector3
): void {
  const summaryLabel = new ObservableUIRawMessage({ text: "" });

  function refreshSummary(): void {
    if (!container) {
      summaryLabel.setData({ text: "張り付いた先にコンテナがありません。" });
      return;
    }
    const catalog = scanContainerCatalog(container);
    if (catalog.length === 0) {
      summaryLabel.setData({ text: "チェストは空です。" });
      return;
    }
    const parts: UIRawMessage[] = [];
    catalog.forEach((entry, i) => {
      if (i > 0) parts.push({ text: "\n" });
      parts.push(entry.key.name ? { text: entry.key.name } : { translate: entry.localizationKey });
      parts.push({ text: ` x${entry.total}` });
    });
    summaryLabel.setData({ rawtext: parts });
  }
  form.button(
    "すべて預け入れ",
    () => {
      if (!container) return;
      const catalog = scanContainerCatalog(container);
      if (catalog.length === 0) return;

      const lines: DepositLine[] = catalog.map((entry) => ({
        itemTypeId: entry.key.typeId,
        itemName: entry.key.name,
        requested: entry.total,
        delivered: 0,
        exhausted: false,
      }));
      const depositId = submitDeposit(networkId, terminalLoc, player.name, lines);
      form.close();
      player.sendMessage(`§b預け入れ #${depositId} をネットワークへ送信しました。`);
    },
    { visible: tabVisible }
  );

  tabVisible.subscribe((active) => {
    if (active) refreshSummary();
  });
  if (tabVisible.getData()) refreshSummary();

  form.label(summaryLabel, { visible: tabVisible });
}

// 設定タブ: ターミナルごとのローカル設定(現状は完了通知の有無のみ)。ブロック自体は
// 状態を持てないため、非表示エンティティ側に持たせている(terminalSettings.ts参照)。
function setupSettingsTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  terminalLoc: Vector3,
  initialNotifyOnComplete: boolean,
  initialName: string
): void {
  const notifyOnComplete = new ObservableBoolean(initialNotifyOnComplete, { clientWritable: true });
  notifyOnComplete.subscribe((value) => {
    setNotifyOnComplete(dimension, terminalLoc, value);
  });

  const name = new ObservableString(initialName, { clientWritable: true });
  name.subscribe((value) => {
    setTerminalName(dimension, terminalLoc, value);
  });

  form.label("このターミナルの設定です。", { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.textField("名前", name, {
    description: "通知時に表示されます。",
    visible: tabVisible,
  });
  form.toggle("引き出し完了時に通知を表示する", notifyOnComplete, { visible: tabVisible });
}

export function showOrderUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const membership = findMembership(dimension.id, block.location);
  if (!membership) {
    player.sendMessage("§cこのターミナルはまだ倉庫ネットワークに接続されていません。");
    return;
  }
  const network = membership.network;
  const orderCatalog = scanCatalog(dimension, network);

  const attachedLoc = getAttachedStorageLocation(block);
  const attachedContainer = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container;

  const terminalName = getTerminalName(dimension, block.location);
  const namePrefix = terminalName ? `「${terminalName}」の` : "";

  const isOrderTab = new ObservableBoolean(true);
  const isDepositTab = new ObservableBoolean(false);
  const isStatusTab = new ObservableBoolean(false);
  const isSettingsTab = new ObservableBoolean(false);

  // タブ切り替えはボタンではなくドロップダウンで行う。選択値
  // (0=引き出し/1=預け入れ/2=状況/3=設定)の変化を購読して、各タブのvisible/disabled用
  // Observableに反映する。
  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isOrderTab.setData(index === 0);
    isDepositTab.setData(index === 1);
    isStatusTab.setData(index === 2);
    isSettingsTab.setData(index === 3);
  });

  const form = new CustomForm(player, terminalName ? `倉庫: ${terminalName}` : "倉庫");
  form.dropdown("", tabSelection, [
    { label: "引き出し", value: 0 },
    { label: "預け入れ", value: 1 },
    { label: "状況", value: 2 },
    { label: "設定", value: 3 },
  ]);

  setupTab(form, isOrderTab, orderCatalog, "確定", player.clientSystemInfo.locale, (lines) => {
    if (block.typeId === DELIVERY_TERMINAL_BLOCK_ID && hasActiveDeliveryOrderFor(player.name)) {
      player.sendMessage("§cあなたへの配達が既に進行中です。完了までお待ちください。");
      return false;
    }
    const orderId = submitOrder(network.id, block.location, player.name, lines);
    player.sendMessage(`§b${namePrefix}引き出し #${orderId} をネットワークへ送信しました。`);
    return true;
  });

  setupDepositTab(form, player, isDepositTab, attachedContainer, network.id, block.location);

  // 「状況」タブはコントローラUIと同じ実装(statusListUi.ts)を使うが、ネットワーク全体では
  // なく、この端末が送信元/宛先のものだけに絞り込む(fetchAllでlocEquals(terminal)フィルタ)。
  form.divider({ visible: isStatusTab });
  const orderStatusRefreshTimer = setupOrderStatusSection(form, isStatusTab, dimension, player, network.id, () =>
    listActiveOrders(network.id).filter((order) => locEquals(order.terminal, block.location))
  );
  form.divider({ visible: isStatusTab });
  const depositStatusRefreshTimer = setupDepositStatusSection(form, isStatusTab, dimension, player, network.id, () =>
    listActiveDeposits(network.id).filter((request) => locEquals(request.terminal, block.location))
  );

  setupSettingsTab(
    form,
    isSettingsTab,
    dimension,
    block.location,
    getNotifyOnComplete(dimension, block.location),
    terminalName ?? ""
  );

  form
    .show()
    .catch((e) => console.error(e))
    .finally(() => {
      system.clearRun(orderStatusRefreshTimer);
      system.clearRun(depositStatusRefreshTimer);
    });
}
