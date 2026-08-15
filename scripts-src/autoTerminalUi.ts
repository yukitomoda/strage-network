import { Block, Dimension, Player, Vector3 } from "@minecraft/server";
import {
  CustomForm,
  ObservableBoolean,
  ObservableNumber,
  ObservableString,
  ObservableUIRawMessage,
} from "@minecraft/server-ui";
import { findMembership } from "./network";
import { WishlistLine } from "./state";
import { CatalogEntry, scanCatalog } from "./storageScan";
import { catalogEntryMessage } from "./terminalUi";
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
  const targetAmount = new ObservableNumber(64, { clientWritable: true });

  const searchLabels: ObservableUIRawMessage[] = [];
  const searchVisible: ObservableBoolean[] = [];
  let filtered: CatalogEntry[] = [];

  const currentLabels: ObservableUIRawMessage[] = [];
  const currentVisible: ObservableBoolean[] = [];

  function refreshSearch(): void {
    const q = searchText.getData().trim().toLowerCase();
    filtered = networkCatalog.filter((entry) => entry.label.toLowerCase().includes(q)).slice(0, ROW_COUNT);
    for (let i = 0; i < ROW_COUNT; i++) {
      const entry = filtered[i];
      searchVisible[i].setData(!!entry);
      searchLabels[i].setData(entry ? catalogEntryMessage(entry) : { text: "" });
    }
  }

  function refreshCurrent(): void {
    for (let i = 0; i < ROW_COUNT; i++) {
      const line = wishlist[i];
      currentVisible[i].setData(!!line);
      currentLabels[i].setData(line ? { text: `${line.itemName ?? line.itemTypeId} 目標:${line.targetAmount}` } : { text: "" });
    }
  }

  tabVisible.subscribe((active) => {
    if (active) {
      refreshSearch();
      refreshCurrent();
    }
  });

  form.label("設定した数量を下回ると、自動で不足分を注文します。", { visible: tabVisible });
  form.textField("検索", searchText, { visible: tabVisible });
  form.slider("維持したい数量", targetAmount, 1, 1728, { step: 1, visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.label("検索結果(タップで目標数量に加算)", { visible: tabVisible });

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
        const existing = wishlist.find(
          (l) => l.itemTypeId === entry.key.typeId && (l.itemName ?? "") === (entry.key.name ?? "")
        );
        if (existing) {
          existing.targetAmount += amount;
        } else {
          wishlist.push({ itemTypeId: entry.key.typeId, itemName: entry.key.name, targetAmount: amount });
        }
        setWishlist(dimension, terminalLoc, wishlist);
        refreshCurrent();
      },
      { visible }
    );
  }

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

  form.label("このターミナルだけのローカル設定です。", { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.textField("名前", name, {
    description: "注文発行時/配送完了時の通知に表示されます。",
    visible: tabVisible,
  });
  form.toggle("注文の配送完了時に通知を表示する", notifyOnComplete, { visible: tabVisible });
  form.toggle("自動預け入れ", autoDeposit, {
    description: "リストに無い、またはリストの目標を上回るアイテムを自動でネットワークへ預け入れます。",
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

  function selectTab(tab: "list" | "settings"): void {
    isListTab.setData(tab === "list");
    isSettingsTab.setData(tab === "settings");
  }

  const form = new CustomForm(player, terminalName ? `自動端末: ${terminalName}` : "自動端末");
  form.button("リスト", () => selectTab("list"), { disabled: isListTab });
  form.button("設定", () => selectTab("settings"), { disabled: isSettingsTab });
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
