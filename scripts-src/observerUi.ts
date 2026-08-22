import { Block, ItemStack, Player } from "@minecraft/server";
import {
  CustomForm,
  ObservableBoolean,
  ObservableNumber,
  ObservableString,
  ObservableUIRawMessage,
  UIRawMessage,
} from "@minecraft/server-ui";
import { findMembership } from "./network";
import { getObserverSettings, setObserverSettings } from "./observerSettings";
import { ObserverSettings } from "./state";
import { CatalogEntry, scanCatalog } from "./storageScan";

const ROW_COUNT = 8;

function itemMessage(itemTypeId: string | undefined, itemName: string | undefined): UIRawMessage {
  if (!itemTypeId) return { text: "(未設定)" };
  return itemName ? { text: itemName } : { translate: new ItemStack(itemTypeId, 1).localizationKey };
}

export function showObserverUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const membership = findMembership(dimension.id, block.location);
  if (!membership) {
    player.sendMessage("§cこのオブザーバーはまだ倉庫ネットワークに接続されていません。");
    return;
  }
  const network = membership.network;
  const networkCatalog = scanCatalog(dimension, network);

  let current: ObserverSettings = getObserverSettings(dimension, block.location) ?? { mode: "stock" };

  // モード: 在庫(1品目+最大値)/比較(2品目)。increaseModeトグル等と同じ実装パターン。
  const isStockMode = new ObservableBoolean(current.mode === "stock", { clientWritable: true });
  const modeLabel = new ObservableString(isStockMode.getData() ? "在庫モード" : "比較モード");
  isStockMode.subscribe((stock) => modeLabel.setData(stock ? "在庫モード" : "比較モード"));

  // 比較モードで検索結果をタップした時、品目1/品目2のどちらに設定するか(0=品目1、1=品目2)。
  // 在庫モードでは常に品目1に設定される。
  const targetSlot = new ObservableNumber(0, { clientWritable: true });
  // 比較モードの時だけ「設定先」ドロップダウン自体を意味のあるものにする(在庫モードでは常に品目1固定)。
  const showTargetDropdown = new ObservableBoolean(!isStockMode.getData());
  isStockMode.subscribe((stock) => showTargetDropdown.setData(!stock));

  const maxAmountText = new ObservableString(String(current.maxAmount ?? 64), { clientWritable: true });

  const item1Label = new ObservableUIRawMessage(itemMessage(current.itemTypeId, current.itemName));
  const item2Label = new ObservableUIRawMessage(itemMessage(current.itemTypeId2, current.itemName2));
  const showItem2 = new ObservableBoolean(!isStockMode.getData());
  isStockMode.subscribe((stock) => showItem2.setData(!stock));

  const searchText = new ObservableString("", { clientWritable: true });
  const searchLabels: ObservableUIRawMessage[] = [];
  const searchVisible: ObservableBoolean[] = [];
  let filtered: CatalogEntry[] = [];

  let currentPage = 0;
  const hasPrevPage = new ObservableBoolean(false);
  const hasNextPage = new ObservableBoolean(false);
  const pageLabel = new ObservableString("1 / 1 ページ");
  const showPageLabel = new ObservableBoolean(false);

  function searchRowMessage(entry: CatalogEntry): UIRawMessage {
    const namePart: UIRawMessage = entry.key.name ? { text: entry.key.name } : { translate: entry.localizationKey };
    return { rawtext: [{ text: `${entry.total} ` }, namePart] };
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

  function persist(): void {
    setObserverSettings(dimension, block.location, current);
  }

  isStockMode.subscribe((stock) => {
    current = { ...current, mode: stock ? "stock" : "compare" };
    persist();
  });
  maxAmountText.subscribe((text) => {
    const value = Math.floor(Number(text));
    if (!Number.isFinite(value) || value < 1) return; // 不正な入力は保存しない(直前の値を維持)
    current = { ...current, maxAmount: value };
    persist();
  });

  const form = new CustomForm(player, "オブザーバー");
  form.toggle(modeLabel, isStockMode, {});
  form.label("在庫モード: 最大値に対する在庫量で信号強度が変化します。", { visible: isStockMode });
  form.label("比較モード: 2つの品目を比較して信号強度が変わります。", { visible: showItem2 });
  form.textField("最大値", maxAmountText, { visible: isStockMode });
  form.divider({});
  form.label("品目1", {});
  form.label(item1Label, {});
  form.label("品目2", { visible: showItem2 });
  form.label(item2Label, { visible: showItem2 });
  form.dropdown("設定先", targetSlot, [
    { label: "品目1", value: 0 },
    { label: "品目2", value: 1 },
  ], { visible: showTargetDropdown });
  form.divider({});
  form.label("検索結果", {});
  form.textField("検索", searchText, {});
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

    form.button(
      label,
      () => {
        const entry = filtered[i];
        if (!entry) return;

        if (isStockMode.getData() || targetSlot.getData() !== 1) {
          current = { ...current, itemTypeId: entry.key.typeId, itemName: entry.key.name };
          item1Label.setData(itemMessage(entry.key.typeId, entry.key.name));
        } else {
          current = { ...current, itemTypeId2: entry.key.typeId, itemName2: entry.key.name };
          item2Label.setData(itemMessage(entry.key.typeId, entry.key.name));
        }
        persist();
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

  searchText.subscribe(() => {
    currentPage = 0;
    refreshSearch();
  });
  refreshSearch();

  form.show().catch((e) => console.error(e));
}
