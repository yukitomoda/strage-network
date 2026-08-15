import { Block, Container, Dimension, Player, Vector3 } from "@minecraft/server";
import {
  CustomForm,
  ObservableBoolean,
  ObservableNumber,
  ObservableString,
  ObservableUIRawMessage,
  UIRawMessage,
} from "@minecraft/server-ui";
import { findMembership } from "./network";
import { submitDeposit } from "./depositProcessing";
import { submitOrder } from "./orderProcessing";
import { CatalogEntry, scanCatalog, scanContainerCatalog } from "./storageScan";
import { getAttachedStorageLocation } from "./terminalBlock";
import { getNotifyOnComplete, getTerminalName, setNotifyOnComplete, setTerminalName } from "./terminalSettings";
import { DepositLine } from "./state";

const ROW_COUNT = 8;

// 注文(引き出し)/納入(格納)のどちらのカートラインも同じ形なので共通の型で扱う。
type CartLine = {
  itemTypeId: string;
  itemName?: string;
  requested: number;
  delivered: number;
  exhausted: boolean;
};

// カスタム名(nameTag)があればそのまま表示、無ければ localizationKey をクライアントの
// langファイルで解決してもらう(自前の翻訳テーブルは持たない。docs/design.md 5章参照)。
// autoTerminalUi.ts のウィッシュリスト検索結果表示でも使うため export する。
export function catalogEntryMessage(entry: CatalogEntry): UIRawMessage {
  const namePart: UIRawMessage = entry.key.name ? { text: entry.key.name } : { translate: entry.localizationKey };
  return { rawtext: [namePart, { text: ` (在庫${entry.total})` }] };
}

// 注文タブ/納入タブそれぞれの「検索+数量+結果一覧+カート+確定」を組み立てる共通処理。
// タブの切り替えは全コントロールを visible で出し分けるだけ(DDUIにタブ専用の部品は無いため)。
function setupTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  catalog: CatalogEntry[],
  cartLabelPrefix: string,
  confirmLabel: string,
  onConfirm: (lines: CartLine[]) => void
): void {
  const cart: CartLine[] = [];
  const cartLabel = new ObservableString(`${cartLabelPrefix}: (空)`);
  const searchText = new ObservableString("", { clientWritable: true });
  const quantity = new ObservableNumber(1, { clientWritable: true });

  const rowLabels: ObservableUIRawMessage[] = [];
  const rowVisible: ObservableBoolean[] = [];
  let filtered: CatalogEntry[] = [];

  function refreshFilter(): void {
    const q = searchText.getData().trim().toLowerCase();
    filtered = catalog.filter((entry) => entry.label.toLowerCase().includes(q)).slice(0, ROW_COUNT);
    for (let i = 0; i < ROW_COUNT; i++) {
      const entry = filtered[i];
      rowVisible[i].setData(!!entry);
      rowLabels[i].setData(entry ? catalogEntryMessage(entry) : { text: "" });
    }
  }

  function refreshCartLabel(): void {
    cartLabel.setData(
      cart.length === 0
        ? `${cartLabelPrefix}: (空)`
        : `${cartLabelPrefix}: ` + cart.map((l) => `${l.itemName ?? l.itemTypeId} x${l.requested}`).join(", ")
    );
  }

  // visible は「タブが選択中」と「絞り込みに引っかかっている」の両方を満たす時だけ true にしたいが、
  // ObservableBoolean同士のAND合成手段が無いため、タブ切り替え時にも絞り込みを再適用して対応する。
  tabVisible.subscribe((active) => {
    if (active) refreshFilter();
  });

  form.textField("検索", searchText, { visible: tabVisible });
  form.slider("数量", quantity, 1, 64, { step: 1, visible: tabVisible });
  form.divider({ visible: tabVisible });

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
        const existing = cart.find(
          (l) => l.itemTypeId === entry.key.typeId && (l.itemName ?? "") === (entry.key.name ?? "")
        );
        if (existing) {
          existing.requested += amount;
        } else {
          cart.push({
            itemTypeId: entry.key.typeId,
            itemName: entry.key.name,
            requested: amount,
            delivered: 0,
            exhausted: false,
          });
        }
        refreshCartLabel();
      },
      { visible: rowVisibleFlag }
    );
  }

  form.divider({ visible: tabVisible });
  form.label(cartLabel, { visible: tabVisible });
  form.button(
    confirmLabel,
    () => {
      if (cart.length === 0) return;
      onConfirm(cart.map((l) => ({ ...l })));
      cart.length = 0;
      refreshCartLabel();
      form.close();
    },
    { visible: tabVisible }
  );

  searchText.subscribe(() => {
    if (tabVisible.getData()) refreshFilter();
  });
  if (tabVisible.getData()) refreshFilter();
}

// 納入タブ: 数量指定は不要で、張り付いた先のコンテナに今入っている物を全部まとめて
// 1回のリクエストにするワンボタン方式。DepositRequest/DepositLine自体は個数を持てる
// 形のままなので、将来「一部だけ納入」に変えたくなってもデータ構造の変更は不要。
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
      if (i > 0) parts.push({ text: ", " });
      parts.push(entry.key.name ? { text: entry.key.name } : { translate: entry.localizationKey });
      parts.push({ text: ` x${entry.total}` });
    });
    summaryLabel.setData({ rawtext: parts });
  }

  tabVisible.subscribe((active) => {
    if (active) refreshSummary();
  });
  if (tabVisible.getData()) refreshSummary();

  form.label(summaryLabel, { visible: tabVisible });
  form.button(
    "納入(すべて送る)",
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
      submitDeposit(networkId, terminalLoc, lines);
      form.close();
      player.sendMessage("§b倉庫ネットワークへ送信しました。");
    },
    { visible: tabVisible }
  );
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

  form.label("このターミナルだけのローカル設定です。", { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.textField("名前", name, {
    description: "注文発行時/配送完了時の通知に表示されます。",
    visible: tabVisible,
  });
  form.toggle("注文の配送完了時に通知を表示する", notifyOnComplete, { visible: tabVisible });
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
  const isSettingsTab = new ObservableBoolean(false);

  function selectTab(tab: "order" | "deposit" | "settings"): void {
    isOrderTab.setData(tab === "order");
    isDepositTab.setData(tab === "deposit");
    isSettingsTab.setData(tab === "settings");
  }

  const form = new CustomForm(player, terminalName ? `倉庫端末: ${terminalName}` : "倉庫端末");
  form.button("注文", () => selectTab("order"), { disabled: isOrderTab });
  form.button("納入", () => selectTab("deposit"), { disabled: isDepositTab });
  form.button("設定", () => selectTab("settings"), { disabled: isSettingsTab });
  form.divider();

  setupTab(form, isOrderTab, orderCatalog, "カート", "注文確定", (lines) => {
    const orderId = submitOrder(network.id, block.location, player.name, lines);
    player.sendMessage(`§b${namePrefix}注文 #${orderId} をネットワークへ送信しました。`);
  });

  setupDepositTab(form, player, isDepositTab, attachedContainer, network.id, block.location);

  setupSettingsTab(
    form,
    isSettingsTab,
    dimension,
    block.location,
    getNotifyOnComplete(dimension, block.location),
    terminalName ?? ""
  );

  form.show().catch((e) => console.error(e));
}
