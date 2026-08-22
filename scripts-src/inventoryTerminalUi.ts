import { Block, Dimension, ItemStack, Player, system, Vector3 } from "@minecraft/server";
import {
  CustomForm,
  ObservableBoolean,
  ObservableNumber,
  ObservableString,
  ObservableUIRawMessage,
  UIRawMessage,
} from "@minecraft/server-ui";
import { listActiveDeposits } from "./depositProcessing";
import { findMembership } from "./network";
import { listActiveOrders } from "./orderProcessing";
import { locEquals, StockTargetLine } from "./state";
import { setupDepositStatusSection, setupOrderStatusSection } from "./statusListUi";
import { CatalogEntry, scanCatalog } from "./storageScan";
import {
  getInventoryAutoDeposit,
  getStockTargets,
  getTerminalName,
  setInventoryAutoDeposit,
  setStockTargets,
  setTerminalName,
} from "./terminalSettings";

const ROW_COUNT = 8;

// 検索/目標設定タブ: ネットワークの在庫から検索して目標を追加/更新する上段と、
// 現在のリストを一覧して削除できる下段の2段構成(autoTerminalUi.tsのsetupWishlistTabと
// 全く同じ構造)。目標の意味だけが違う: 自動端末は「このターミナルのアタッチ先に置いて
// おきたい量」だが、こちらは「ネットワーク全体で維持したい在庫数」(inventoryCheck.ts参照)。
function setupStockTargetTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  terminalLoc: Vector3,
  networkCatalog: CatalogEntry[],
  initialTargets: StockTargetLine[]
): void {
  let targets = [...initialTargets];

  const searchText = new ObservableString("", { clientWritable: true });
  const targetAmount = new ObservableNumber(1, { clientWritable: true });
  const increaseMode = new ObservableBoolean(true, { clientWritable: true }); // ON: 増やす / OFF: 減らす
  const increaseModeLabel = new ObservableString(increaseMode.getData() ? "増やす" : "減らす");
  increaseMode.subscribe((isIncrease) => increaseModeLabel.setData(isIncrease ? "増やす" : "減らす"));
  // ONの間、検索結果のタップは増減ではなく目標在庫数を0に設定する(在庫が無くなるまで
  // 引き出し続ける「空にする」指定)。増やす/減らすの操作と同時に意味を持たせると混乱するため、
  // ONの間は「増やす」トグルを無効化する。
  const emptyMode = new ObservableBoolean(false, { clientWritable: true });

  const searchLabels: ObservableUIRawMessage[] = [];
  const searchVisible: ObservableBoolean[] = [];
  let filtered: CatalogEntry[] = [];

  // ページャー: 絞り込み結果がROW_COUNTを超える場合に前/次ページへ移動できるようにする
  // (terminalUi.ts/autoTerminalUi.tsと同じ仕組み)。
  let currentPage = 0;
  const hasPrevPage = new ObservableBoolean(false);
  const hasNextPage = new ObservableBoolean(false);
  const pageLabel = new ObservableString("1 / 1 ページ");
  const showPageLabel = new ObservableBoolean(false);

  const currentLabels: ObservableUIRawMessage[] = [];
  const currentVisible: ObservableBoolean[] = [];

  // 現在の目標在庫数を「{目標数}/{ネットワーク在庫数} {品名}」の形で行ラベルに表示する。
  function targetAmountFor(entry: CatalogEntry): number {
    const line = targets.find(
      (l) => l.itemTypeId === entry.key.typeId && (l.itemName ?? "") === (entry.key.name ?? "")
    );
    return line?.targetAmount ?? 0;
  }

  function searchRowMessage(entry: CatalogEntry): UIRawMessage {
    const namePart: UIRawMessage = entry.key.name ? { text: entry.key.name } : { translate: entry.localizationKey };
    return { rawtext: [{ text: `${targetAmountFor(entry)}/${entry.total} ` }, namePart] };
  }

  function refreshSearch(): void {
    const q = searchText.getData().trim().toLowerCase();
    const allMatches = networkCatalog.filter((entry) => entry.label.toLowerCase().includes(q));
    const totalPages = Math.max(1, Math.ceil(allMatches.length / ROW_COUNT));
    currentPage = Math.min(Math.max(currentPage, 0), totalPages - 1);

    filtered = allMatches.slice(currentPage * ROW_COUNT, (currentPage + 1) * ROW_COUNT);
    for (let i = 0; i < ROW_COUNT; i++) {
      const entry = filtered[i];
      searchVisible[i].setData(!!entry);
      searchLabels[i].setData(entry ? searchRowMessage(entry) : { text: "" });
    }

    hasPrevPage.setData(currentPage > 0);
    hasNextPage.setData(currentPage < totalPages - 1);
    pageLabel.setData(`${currentPage + 1} / ${totalPages} ページ`);
    showPageLabel.setData(totalPages > 1);
  }

  // 目標だけ設定されていて現在庫が0の品目はnetworkCatalogのスキャン結果に出てこないことが
  // あるため、カタログ経由ではなく、typeIdから直接ItemStackを作ってlocalizationKeyを取得する
  // (autoTerminalUi.tsのwishlistLineMessageと同じ理由・同じ手法)。
  function targetLineMessage(line: StockTargetLine): UIRawMessage {
    const namePart: UIRawMessage = line.itemName
      ? { text: line.itemName }
      : { translate: new ItemStack(line.itemTypeId, 1).localizationKey };
    return { rawtext: [namePart, { text: ` 目標:${line.targetAmount}` }] };
  }

  function refreshCurrent(): void {
    for (let i = 0; i < ROW_COUNT; i++) {
      const line = targets[i];
      currentVisible[i].setData(!!line);
      currentLabels[i].setData(line ? targetLineMessage(line) : { text: "" });
    }
  }

  tabVisible.subscribe((active) => {
    if (active) {
      refreshSearch();
      refreshCurrent();
    }
  });

  form.label(
    "指定した在庫数を維持するように自動で引き出し・預け入れを行います。",
    { visible: tabVisible }
  );
  form.textField("検索", searchText, { visible: tabVisible });
  form.toggle("空に設定", emptyMode, {
    visible: tabVisible,
  });
  form.slider("維持したい在庫数", targetAmount, 1, 64, { step: 1, visible: tabVisible, disabled: emptyMode });
  form.toggle(increaseModeLabel, increaseMode, { visible: tabVisible, disabled: emptyMode });
  form.divider({ visible: tabVisible });
  form.label("検索結果", { visible: tabVisible });

  // タブ非表示中はページャーボタンも隠す(AND合成が無いための対処、他タブと同じ)。
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
      refreshSearch();
    },
    { visible: hasPrevPage }
  );

  for (let i = 0; i < ROW_COUNT; i++) {
    const label = new ObservableUIRawMessage({ text: "" });
    const visible = new ObservableBoolean(false);
    searchLabels.push(label);
    searchVisible.push(visible);
    tabVisible.subscribe((active) => {
      if (!active) visible.setData(false);
    });

    form.button(
      label,
      () => {
        const entry = filtered[i];
        if (!entry) return;
        const existingIndex = targets.findIndex(
          (l) => l.itemTypeId === entry.key.typeId && (l.itemName ?? "") === (entry.key.name ?? "")
        );

        if (emptyMode.getData()) {
          if (existingIndex !== -1) {
            targets[existingIndex].targetAmount = 0;
          } else {
            targets.push({ itemTypeId: entry.key.typeId, itemName: entry.key.name, targetAmount: 0 });
          }
          setStockTargets(dimension, terminalLoc, targets);
          label.setData(searchRowMessage(entry));
          refreshCurrent();
          return;
        }

        const amount = Math.max(1, Math.floor(targetAmount.getData()));

        if (!increaseMode.getData()) {
          if (existingIndex === -1) return; // リストに無い品目は減らせない
          targets[existingIndex].targetAmount -= amount;
          if (targets[existingIndex].targetAmount <= 0) targets.splice(existingIndex, 1); // 0以下ならリストから外す
        } else if (existingIndex !== -1) {
          targets[existingIndex].targetAmount += amount; // 在庫数の上限は無い
        } else {
          targets.push({ itemTypeId: entry.key.typeId, itemName: entry.key.name, targetAmount: amount });
        }
        setStockTargets(dimension, terminalLoc, targets);
        label.setData(searchRowMessage(entry)); // このスロットの表示だけ目標数を反映して更新する
        refreshCurrent();
      },
      { visible }
    );
  }

  form.button(
    "▼ 次のページ",
    () => {
      currentPage++;
      refreshSearch();
    },
    { visible: hasNextPage }
  );

  form.divider({ visible: tabVisible });
  form.label("現在のリスト(タップで削除)", { visible: tabVisible });

  for (let i = 0; i < ROW_COUNT; i++) {
    const label = new ObservableUIRawMessage({ text: "" });
    const visible = new ObservableBoolean(false);
    currentLabels.push(label);
    currentVisible.push(visible);
    tabVisible.subscribe((active) => {
      if (!active) visible.setData(false);
    });

    form.button(
      label,
      () => {
        const line = targets[i];
        if (!line) return;
        targets = targets.filter((l) => l !== line);
        setStockTargets(dimension, terminalLoc, targets);
        refreshCurrent();
      },
      { visible }
    );
  }

  searchText.subscribe(() => {
    currentPage = 0; // 新しい検索条件では1ページ目から見せる
    if (tabVisible.getData()) refreshSearch();
  });
  if (tabVisible.getData()) {
    refreshSearch();
    refreshCurrent();
  }
}

// 設定タブ: 名前と自動預け入れトグル。通知先という概念が無く(自動発注/自動預け入れと同じ)、
// 在庫目標に基づく双方向の自動搬送自体は常時有効でトグルする項目が無いため、自動端末の
// 設定タブより項目は少ない。
function setupSettingsTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  terminalLoc: Vector3,
  initialName: string,
  initialAutoDeposit: boolean
): void {
  const name = new ObservableString(initialName, { clientWritable: true });
  name.subscribe((value) => {
    setTerminalName(dimension, terminalLoc, value);
  });

  const autoDeposit = new ObservableBoolean(initialAutoDeposit, { clientWritable: true });
  autoDeposit.subscribe((value) => {
    setInventoryAutoDeposit(dimension, terminalLoc, value);
  });

  form.label("このターミナルの設定です。", { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.textField("名前", name, {
    description: "在庫管理ターミナルの識別用です。",
    visible: tabVisible,
  });
  form.toggle("自動預け入れ", autoDeposit, {
    description: "リストに無いアイテムをアタッチ先から自動で預け入れます。",
    visible: tabVisible,
  });
}

export function showInventoryTerminalUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const membership = findMembership(dimension.id, block.location);
  if (!membership) {
    player.sendMessage("§cこのターミナルはまだ倉庫ネットワークに接続されていません。");
    return;
  }
  const network = membership.network;
  const networkCatalog = scanCatalog(dimension, network);

  const terminalName = getTerminalName(dimension, block.location);

  const isTargetTab = new ObservableBoolean(true);
  const isStatusTab = new ObservableBoolean(false);
  const isSettingsTab = new ObservableBoolean(false);

  // タブ切り替えはボタンではなくドロップダウンで行う(terminalUi.ts/autoTerminalUi.tsと同じ方式)。
  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isTargetTab.setData(index === 0);
    isStatusTab.setData(index === 1);
    isSettingsTab.setData(index === 2);
  });

  const form = new CustomForm(player, terminalName ? `在庫管理: ${terminalName}` : "在庫管理");
  form.dropdown("", tabSelection, [
    { label: "在庫管理", value: 0 },
    { label: "状況", value: 1 },
    { label: "設定", value: 2 },
  ]);
  form.divider();

  setupStockTargetTab(
    form,
    isTargetTab,
    dimension,
    block.location,
    networkCatalog,
    getStockTargets(dimension, block.location)
  );

  // 「状況」タブはterminalUi.ts/autoTerminalUi.tsと全く同じ実装(statusListUi.ts)を、
  // この端末に絞り込んで使う。
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
    terminalName ?? "",
    getInventoryAutoDeposit(dimension, block.location)
  );

  form
    .show()
    .catch((e) => console.error(e))
    .finally(() => {
      system.clearRun(orderStatusRefreshTimer);
      system.clearRun(depositStatusRefreshTimer);
    });
}
