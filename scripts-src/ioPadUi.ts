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
import { displayKeyEquals, matchesSearchQuery } from "./itemIdentity";
import { findMembership } from "./network";
import { listActiveOrders } from "./orderProcessing";
import { locEquals, PadMode, PadTargetLine } from "./state";
import { setupQuantitySlider } from "./quantitySlider";
import { setupDepositStatusSection, setupOrderStatusSection } from "./statusListUi";
import { CatalogEntry, scanCatalog, scanContainerCatalog } from "./storageScan";
import { getPadMode, getPadTargets, getTerminalName, setPadMode, setPadTargets, setTerminalName } from "./terminalSettings";

const ROW_COUNT = 8;

// パッドの目標は「プレイヤーの所持数」が対象のため、検索候補もネットワーク在庫だけでなく
// プレイヤーが今持っている品目を含める(手持ちにしか無い品目にも目標を設定できるように
// する)。両方にある品目は1つの行にまとめて表示する(合算した数量を表示)ため、
// displayKeyEquals(itemIdentity.ts)で同一キーを判定してマージする。
function mergeCatalogs(networkCatalog: CatalogEntry[], playerCatalog: CatalogEntry[]): CatalogEntry[] {
  const merged = networkCatalog.map((entry) => ({ ...entry }));
  for (const entry of playerCatalog) {
    const existing = merged.find((e) => displayKeyEquals(e.key, entry.key));
    if (existing) {
      existing.total += entry.total;
    } else {
      merged.push({ ...entry });
    }
  }
  return merged;
}

const MODE_LABELS: Record<PadMode, string> = {
  both: "搬入出",
  deposit_only: "搬入のみ",
  withdraw_only: "搬出のみ",
};

const MODE_DESCRIPTIONS: Record<PadMode, string> = {
  both: "目標を超えた分は預け入れ、目標に足りない分は引き出します。",
  deposit_only: "目標を超えた分だけ預け入れます(不足していても引き出しません)。",
  withdraw_only: "目標に足りない分だけ引き出します(超えていても預け入れません)。",
};

// 目標設定タブ: autoTerminalUi.tsのsetupWishlistTab/inventoryTerminalUi.tsのsetupStockTargetTabと
// 同じ骨格(検索+スライダー+増減トグル+ページャー+現在のリスト)。目標の意味は「プレイヤーが
// このパッドの上に乗った時に維持したい所持数」で、他の2つ(アタッチ先/ネットワーク在庫)とは
// 対象が異なるため、PadTargetLineという別の型・別の動的プロパティキーを使う(state.ts参照)。
// searchCatalogはネットワーク在庫とプレイヤーの手持ちをmergeCatalogsで統合したもの(呼び出し元
// showIoPadUi参照)。
function setupPadTargetTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  padLoc: Vector3,
  searchCatalog: CatalogEntry[],
  initialTargets: PadTargetLine[],
  locale: string
): void {
  let targets = [...initialTargets];

  const searchText = new ObservableString("", { clientWritable: true });
  const increaseMode = new ObservableBoolean(true, { clientWritable: true }); // ON: 増やす / OFF: 減らす
  const increaseModeLabel = new ObservableString(increaseMode.getData() ? "増やす" : "減らす");
  increaseMode.subscribe((isIncrease) => increaseModeLabel.setData(isIncrease ? "増やす" : "減らす"));
  // ONの間、検索結果のタップは増減ではなく目標所持数を0に設定する(在庫管理ターミナルの
  // setupStockTargetTabと同じ「空に設定」パターン。プレイヤーがこのパッドに乗っている間、
  // その品目を持ち歩かず常に預け入れる指定になる)。増やす/減らすの操作と同時に意味を
  // 持たせると混乱するため、ONの間は「増やす/減らす」トグルを無効化する。
  const emptyMode = new ObservableBoolean(false, { clientWritable: true });

  const searchLabels: ObservableUIRawMessage[] = [];
  const searchVisible: ObservableBoolean[] = [];
  let filtered: CatalogEntry[] = [];

  let currentPage = 0;
  const hasPrevPage = new ObservableBoolean(false);
  const hasNextPage = new ObservableBoolean(false);
  const pageLabel = new ObservableString("1 / 1 ページ");
  const showPageLabel = new ObservableBoolean(false);

  const currentLabels: ObservableUIRawMessage[] = [];
  const currentVisible: ObservableBoolean[] = [];

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
    const allMatches = searchCatalog.filter((entry) => matchesSearchQuery(entry, searchText.getData(), locale));
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

  // 目標だけ設定されていてネットワーク在庫・プレイヤーの手持ちの両方が0の品目はsearchCatalogの
  // スキャン結果に出てこないことがあるため、カタログ経由ではなく、typeIdから直接ItemStackを
  // 作ってlocalizationKeyを取得する(autoTerminalUi.tsのwishlistLineMessageと同じ理由・同じ手法)。
  function targetLineMessage(line: PadTargetLine): UIRawMessage {
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
    } else {
      hasPrevPage.setData(false);
      hasNextPage.setData(false);
      showPageLabel.setData(false);
    }
  });

  form.label("パッドの上に乗った時に維持したい所持数を設定します。", { visible: tabVisible });
  const targetAmount = setupQuantitySlider(form, "維持したい所持数", tabVisible, { disabled: emptyMode });
  form.toggle("空に設定", emptyMode, {
    visible: tabVisible,
  });
  form.toggle(increaseModeLabel, increaseMode, { visible: tabVisible, disabled: emptyMode });
  form.textField("検索", searchText, { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.label("検索結果", { visible: tabVisible });
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
          setPadTargets(dimension, padLoc, targets);
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
          targets[existingIndex].targetAmount += amount;
        } else {
          targets.push({ itemTypeId: entry.key.typeId, itemName: entry.key.name, targetAmount: amount });
        }
        setPadTargets(dimension, padLoc, targets);
        label.setData(searchRowMessage(entry));
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
        setPadTargets(dimension, padLoc, targets);
        refreshCurrent();
      },
      { visible }
    );
  }

  searchText.subscribe(() => {
    currentPage = 0;
    if (tabVisible.getData()) refreshSearch();
  });
  if (tabVisible.getData()) {
    refreshSearch();
    refreshCurrent();
  }
}

// 設定タブ: 名前 + 搬入出モード(3択、dropdown)。他のターミナルの設定タブと違い、通知トグルは
// 無い(自動端末等と同じく人間の操作を介さない自動処理のため、通知先という概念が無い)。
function setupSettingsTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  padLoc: Vector3,
  initialName: string,
  initialMode: PadMode
): void {
  const name = new ObservableString(initialName, { clientWritable: true });
  name.subscribe((value) => {
    setTerminalName(dimension, padLoc, value);
  });

  const modeOrder: PadMode[] = ["both", "deposit_only", "withdraw_only"];
  const modeSelection = new ObservableNumber(modeOrder.indexOf(initialMode), { clientWritable: true });
  modeSelection.subscribe((index) => {
    setPadMode(dimension, padLoc, modeOrder[index] ?? "both");
  });

  form.label("このパッドの設定です。", { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.textField("名前", name, {
    description: "搬入出パッドの識別用です。",
    visible: tabVisible,
  });
  form.dropdown(
    "モード",
    modeSelection,
    modeOrder.map((mode, value) => ({ label: MODE_LABELS[mode], value, description: MODE_DESCRIPTIONS[mode] })),
    { visible: tabVisible }
  );
}

export function showIoPadUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const membership = findMembership(dimension.id, block.location);
  if (!membership) {
    player.sendMessage("§cこのパッドはまだ倉庫ネットワークに接続されていません。");
    return;
  }
  const network = membership.network;
  const networkCatalog = scanCatalog(dimension, network);
  // このパッドの目標はプレイヤーの所持数が対象のため、検索候補にプレイヤーの現在の手持ちも
  // 含める(ネットワークにまだ無い品目にも目標を設定できるようにする)。
  const playerInventory = player.getComponent("inventory")?.container;
  const playerCatalog = playerInventory ? scanContainerCatalog(playerInventory) : [];
  const searchCatalog = mergeCatalogs(networkCatalog, playerCatalog);

  const padName = getTerminalName(dimension, block.location);

  const isTargetTab = new ObservableBoolean(true);
  const isStatusTab = new ObservableBoolean(false);
  const isSettingsTab = new ObservableBoolean(false);

  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isTargetTab.setData(index === 0);
    isStatusTab.setData(index === 1);
    isSettingsTab.setData(index === 2);
  });

  const form = new CustomForm(player, padName ? `搬入出パッド: ${padName}` : "搬入出パッド");
  form.dropdown("", tabSelection, [
    { label: "目標設定", value: 0 },
    { label: "状況", value: 1 },
    { label: "設定", value: 2 },
  ]);
  form.divider();

  setupPadTargetTab(
    form,
    isTargetTab,
    dimension,
    block.location,
    searchCatalog,
    getPadTargets(dimension, block.location),
    player.clientSystemInfo.locale
  );

  // 「状況」タブはterminalUi.ts等と全く同じ実装(statusListUi.ts)を、この端末に絞り込んで使う。
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
    padName ?? "",
    getPadMode(dimension, block.location)
  );

  form
    .show()
    .catch((e) => console.error(e))
    .finally(() => {
      system.clearRun(orderStatusRefreshTimer);
      system.clearRun(depositStatusRefreshTimer);
    });
}
