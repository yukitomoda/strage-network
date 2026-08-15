import { Block, Dimension, ItemStack, Player, Vector3 } from "@minecraft/server";
import {
  CustomForm,
  ObservableBoolean,
  ObservableNumber,
  ObservableString,
  ObservableUIRawMessage,
  UIRawMessage,
} from "@minecraft/server-ui";
import { findMembership } from "./network";
import { WishlistLine } from "./state";
import { CatalogEntry, scanCatalog } from "./storageScan";
import {
  getAutoDeposit,
  getNotifyOnComplete,
  getTerminalName,
  getWishlist,
  setAutoDeposit,
  setNotifyOnComplete,
  setTerminalName,
  setWishlist,
} from "./terminalSettings";

const ROW_COUNT = 8;

// リストタブ: ネットワークの在庫から検索してリストへ追加/更新する上段と、
// 現在のリストを一覧して削除できる下段の2段構成。
function setupWishlistTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  terminalLoc: Vector3,
  networkCatalog: CatalogEntry[],
  initialWishlist: WishlistLine[]
): void {
  let wishlist = [...initialWishlist];

  const searchText = new ObservableString("", { clientWritable: true });
  const targetAmount = new ObservableNumber(1, { clientWritable: true });
  const increaseMode = new ObservableBoolean(true, { clientWritable: true }); // ON: 増やす / OFF: 減らす
  const increaseModeLabel = new ObservableString(increaseMode.getData() ? "増やす" : "減らす");
  increaseMode.subscribe((isIncrease) => increaseModeLabel.setData(isIncrease ? "増やす" : "減らす"));

  const searchLabels: ObservableUIRawMessage[] = [];
  const searchVisible: ObservableBoolean[] = [];
  let filtered: CatalogEntry[] = [];

  // ページャー: 絞り込み結果がROW_COUNTを超える場合に前/次ページへ移動できるようにする
  // (terminalUi.tsのsetupTabと同じ仕組み)。
  let currentPage = 0;
  const hasPrevPage = new ObservableBoolean(false);
  const hasNextPage = new ObservableBoolean(false);
  const pageLabel = new ObservableString("1 / 1 ページ");

  const currentLabels: ObservableUIRawMessage[] = [];
  const currentVisible: ObservableBoolean[] = [];

  // 現在の目標数量を「{目標数}/{在庫数} {品名}」の形で行ラベルに表示する。目標数は
  // (通常ターミナルの引き出しカートと違い)在庫数を超えて設定できるので、この数字は
  // 上限ではなく単なる参考表示。
  function targetAmountFor(entry: CatalogEntry): number {
    const line = wishlist.find(
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
  }

  // 上段の検索結果と表示形式を揃える(カスタム名が無ければlocalizationKeyで解決する)。
  // 目標だけ設定されていて現在庫が0の品目はnetworkCatalogに出てこないことがあるため、
  // カタログ経由ではなく、typeIdから直接ItemStackを作ってlocalizationKeyを取得する
  // (実在の在庫が無くても取得できる)。
  function wishlistLineMessage(line: WishlistLine): UIRawMessage {
    const namePart: UIRawMessage = line.itemName
      ? { text: line.itemName }
      : { translate: new ItemStack(line.itemTypeId, 1).localizationKey };
    return { rawtext: [namePart, { text: ` 目標:${line.targetAmount}` }] };
  }

  function refreshCurrent(): void {
    for (let i = 0; i < ROW_COUNT; i++) {
      const line = wishlist[i];
      currentVisible[i].setData(!!line);
      currentLabels[i].setData(line ? wishlistLineMessage(line) : { text: "" });
    }
  }

  tabVisible.subscribe((active) => {
    if (active) {
      refreshSearch();
      refreshCurrent();
    }
  });

  form.label("設定した数量を維持するように自動で引き出しします。", { visible: tabVisible });
  form.textField("検索", searchText, { visible: tabVisible });
  form.slider("維持したい数量", targetAmount, 1, 64, { step: 1, visible: tabVisible });
  form.toggle(increaseModeLabel, increaseMode, { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.label("検索結果", { visible: tabVisible });

  // タブ非表示中はページャーボタンも隠す(searchVisibleFlagと同じ、AND合成が無いための対処)。
  tabVisible.subscribe((active) => {
    if (!active) {
      hasPrevPage.setData(false);
      hasNextPage.setData(false);
    }
  });

  form.label(pageLabel, { visible: tabVisible });

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
        const amount = Math.max(1, Math.floor(targetAmount.getData()));
        const existingIndex = wishlist.findIndex(
          (l) => l.itemTypeId === entry.key.typeId && (l.itemName ?? "") === (entry.key.name ?? "")
        );

        if (!increaseMode.getData()) {
          if (existingIndex === -1) return; // リストに無い品目は減らせない
          wishlist[existingIndex].targetAmount -= amount;
          if (wishlist[existingIndex].targetAmount <= 0) wishlist.splice(existingIndex, 1); // 0以下ならリストから外す
        } else if (existingIndex !== -1) {
          wishlist[existingIndex].targetAmount += amount; // 在庫数の上限は無い
        } else {
          wishlist.push({ itemTypeId: entry.key.typeId, itemName: entry.key.name, targetAmount: amount });
        }
        setWishlist(dimension, terminalLoc, wishlist);
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
        const line = wishlist[i];
        if (!line) return;
        wishlist = wishlist.filter((l) => l !== line);
        setWishlist(dimension, terminalLoc, wishlist);
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

// 名前/通知は通常ターミナルの設定タブと同じ内容(デフォルト値だけが異なる)。
// 自動預け入れトグルは自動端末だけの項目。
function setupSettingsTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  terminalLoc: Vector3,
  initialNotifyOnComplete: boolean,
  initialName: string,
  initialAutoDeposit: boolean
): void {
  const notifyOnComplete = new ObservableBoolean(initialNotifyOnComplete, { clientWritable: true });
  notifyOnComplete.subscribe((value) => {
    setNotifyOnComplete(dimension, terminalLoc, value);
  });

  const name = new ObservableString(initialName, { clientWritable: true });
  name.subscribe((value) => {
    setTerminalName(dimension, terminalLoc, value);
  });

  const autoDeposit = new ObservableBoolean(initialAutoDeposit, { clientWritable: true });
  autoDeposit.subscribe((value) => {
    setAutoDeposit(dimension, terminalLoc, value);
  });

  form.label("このターミナルの設定です。", { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.textField("名前", name, {
    description: "通知時に表示されます。",
    visible: tabVisible,
  });
  form.toggle("引き出し完了時に通知を表示する", notifyOnComplete, { visible: tabVisible });
  form.toggle("自動預け入れ", autoDeposit, {
    description: "余剰アイテムを自動で預け入れます。",
    visible: tabVisible,
  });
}

export function showAutoTerminalUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const membership = findMembership(dimension.id, block.location);
  if (!membership) {
    player.sendMessage("§cこのターミナルはまだ倉庫ネットワークに接続されていません。");
    return;
  }
  const network = membership.network;
  const networkCatalog = scanCatalog(dimension, network);

  const terminalName = getTerminalName(dimension, block.location);

  const isListTab = new ObservableBoolean(true);
  const isSettingsTab = new ObservableBoolean(false);

  // タブ切り替えはボタンではなくドロップダウンで行う(terminalUi.tsのshowOrderUiと同じ方式)。
  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isListTab.setData(index === 0);
    isSettingsTab.setData(index === 1);
  });

  const form = new CustomForm(player, terminalName ? `自動端末: ${terminalName}` : "自動端末");
  form.dropdown("", tabSelection, [
    { label: "自動引き出し", value: 0 },
    { label: "設定", value: 1 },
  ]);
  form.divider();

  setupWishlistTab(
    form,
    isListTab,
    dimension,
    block.location,
    networkCatalog,
    getWishlist(dimension, block.location)
  );

  setupSettingsTab(
    form,
    isSettingsTab,
    dimension,
    block.location,
    getNotifyOnComplete(dimension, block.location),
    terminalName ?? "",
    getAutoDeposit(dimension, block.location)
  );

  form.show().catch((e) => console.error(e));
}
