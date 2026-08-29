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
import { matchesSearchQuery } from "./itemIdentity";
import { findMembership } from "./network";
import { listActiveOrders } from "./orderProcessing";
import { formatSlotRange, parseSlotIndices } from "./slotRange";
import { locEquals, PrecisionSlotLine } from "./state";
import { setupQuantitySlider } from "./quantitySlider";
import { setupDepositStatusSection, setupOrderStatusSection } from "./statusListUi";
import { CatalogEntry, scanCatalog } from "./storageScan";
import { getAttachedStorageLocation } from "./terminalBlock";
import {
  getPrecisionCollectUnspecified,
  getPrecisionSlots,
  getTerminalName,
  setPrecisionCollectUnspecified,
  setPrecisionSlots,
  setTerminalName,
} from "./terminalSettings";

const ROW_COUNT = 8;
// 1スロット1エントリの制約があるため上限を設ける(クラフター9スロットに余裕を持たせた数。
// docs/design.md参照)。
const MAX_SLOT_LINES = 16;

// スロット設定タブ: スロット番号+回収トグルを指定し、ネットワークの在庫から検索して目標を
// 設定する上段、現在のリストを一覧して削除できる下段の2段構成
// (autoTerminalUi.tsのsetupWishlistTabと同じ骨格)。
function setupSlotRuleTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  terminalLoc: Vector3,
  networkCatalog: CatalogEntry[],
  initialSlots: PrecisionSlotLine[],
  attachedContainerSize: number | undefined,
  locale: string
): void {
  let slots = [...initialSlots];

  const slotNumberText = new ObservableString("0", { clientWritable: true });
  // 「回収」: 目標外の品目・目標を超えた余剰分をネットワークへ回収するか。デフォルトON
  // (ユーザーからの要望。目標なしのスロットと組み合わせると、そのスロットは事実上
  // 常に回収される=旧来の「出力スロット」相当になる)。
  const collect = new ObservableBoolean(true, { clientWritable: true });

  const searchText = new ObservableString("", { clientWritable: true });
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
  const currentTooltips: ObservableUIRawMessage[] = [];
  const currentVisible: ObservableBoolean[] = [];

  // スロット重複警告(ユーザー要望、防止はしない。docs/design.md 24章参照)。
  const overlapWarningVisible = new ObservableBoolean(false);
  const overlapWarningLabel = new ObservableUIRawMessage({ text: "" });
  const overlapWarningTooltip = new ObservableUIRawMessage({ text: "" });

  // 設定したスロットが、アタッチ先コンテナに実在しない場合の警告理由。UIを開いた時点の
  // コンテナサイズ(attachedContainerSize)でチェックする(コンテナの種類によってスロット数が
  // 異なるため。例: かまど=3、クラフター=9、チェスト=27)。搬入出そのものは失敗するだけで
  // 実害(アイテム消失)は無いが、原因に気付きにくいという実機での指摘を受けて追加した。
  function slotValidityReason(slotIndex: number): string | undefined {
    if (attachedContainerSize === undefined) return "搬入先のコンテナが見つかりません。";
    if (slotIndex >= attachedContainerSize) {
      return `対象のコンテナにこのスロットは存在しません(スロット数: ${attachedContainerSize})。`;
    }
    return undefined;
  }

  // 1エントリが複数スロットを指定できる(ユーザー要望)ため、グループ内のどれか1つでも
  // 無効なら警告する。最初に見つかった理由を代表として表示する。
  function slotGroupValidityReason(slotIndices: number[]): string | undefined {
    for (const slotIndex of slotIndices) {
      const reason = slotValidityReason(slotIndex);
      if (reason) return reason;
    }
    return undefined;
  }

  // 2つのスロット群が(順序・重複を無視して)完全に同じ集合かどうか。upsertSlotが
  // 「既存エントリの更新」か「新規追加」かを判定するのに使う(以前はslotIndexの単純な一致で
  // 判定していたのを一般化した)。
  function sameSlots(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort((x, y) => x - y);
    const sortedB = [...b].sort((x, y) => x - y);
    return sortedA.every((v, i) => v === sortedB[i]);
  }

  // 異なるエントリ同士が物理的に同じスロットを含んでいないか(24章で「防止・警告は実装しない」
  // としていたが、警告だけは出してほしいというユーザー要望)。防止はしない(奪い合いの挙動自体は
  // 変えない)。スロット番号 -> それを含むエントリの配列、を返す(重複が無ければ空)。
  function findOverlaps(): Map<number, PrecisionSlotLine[]> {
    const bySlot = new Map<number, PrecisionSlotLine[]>();
    for (const rule of slots) {
      for (const slotIndex of rule.slotIndices) {
        const list = bySlot.get(slotIndex);
        if (list) list.push(rule);
        else bySlot.set(slotIndex, [rule]);
      }
    }
    const overlaps = new Map<number, PrecisionSlotLine[]>();
    for (const [slotIndex, rules] of bySlot) {
      if (rules.length > 1) overlaps.set(slotIndex, rules);
    }
    return overlaps;
  }

  // 警告ラベルは概要(重複しているスロット番号)のみ、詳細(どのエントリ同士が重複しているか)は
  // Tooltip側に出す(ユーザー要望)。ボタンのラベルには§書式コードが効かないため概要側は無色。
  function refreshOverlapWarning(): void {
    const overlaps = findOverlaps();
    if (overlaps.size === 0) {
      overlapWarningVisible.setData(false);
      return;
    }
    const overlappingSlots = [...overlaps.keys()].sort((a, b) => a - b);
    overlapWarningLabel.setData({ text: `⚠ スロットが重複しています: ${formatSlotRange(overlappingSlots)}` });
    const detailLines = overlappingSlots.map((slotIndex) => {
      const ranges = overlaps.get(slotIndex)!.map((rule) => formatSlotRange(rule.slotIndices));
      return `スロット${slotIndex}: ${ranges.join(" と ")}`;
    });
    overlapWarningTooltip.setData({
      text: `§c同じスロットが複数のエントリに含まれています。搬入出が競合する可能性があります。\n${detailLines.join("\n")}`,
    });
    overlapWarningVisible.setData(true);
  }

  function upsertSlot(line: PrecisionSlotLine): void {
    const existingIndex = slots.findIndex((s) => sameSlots(s.slotIndices, line.slotIndices));
    if (existingIndex === -1 && slots.length >= MAX_SLOT_LINES) return; // 上限超過は無視
    if (existingIndex !== -1) slots[existingIndex] = line;
    else slots.push(line);
    setPrecisionSlots(dimension, terminalLoc, slots);
    refreshCurrent();
    refreshOverlapWarning();
  }

  // 「1」「1,2,3」「1-3」「1,3-5,7」のような書式をパースする(slotRange.ts参照)。不正な入力は
  // undefinedになり、呼び出し元は何もしない(既存のreadSlotIndexと同じ「無効なら無視」方針)。
  function readSlotIndices(): number[] | undefined {
    return parseSlotIndices(slotNumberText.getData());
  }

  function searchRowMessage(entry: CatalogEntry): UIRawMessage {
    const namePart: UIRawMessage = entry.key.name ? { text: entry.key.name } : { translate: entry.localizationKey };
    return { rawtext: [{ text: `${entry.total} ` }, namePart] };
  }

  function refreshSearch(): void {
    const q = searchText.getData();
    const allMatches = networkCatalog.filter((entry) => matchesSearchQuery(entry, q, locale));
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

  function slotLineMessage(line: PrecisionSlotLine): UIRawMessage {
    const collectSuffix = line.collect ? " (回収)" : "";
    const slotLabel = formatSlotRange(line.slotIndices);
    // スロットが実在しない場合は警告マークを付ける。ボタンのラベルには§書式コードが効かない
    // (実機で確認済み。tooltipには効く)ため、ここでは色は付けられず記号のみになる。
    const warningPrefix: UIRawMessage[] = slotGroupValidityReason(line.slotIndices) ? [{ text: "⚠ " }] : [];
    if (line.targetAmount <= 0 || !line.itemTypeId) {
      return { rawtext: [...warningPrefix, { text: `${slotLabel}: -> 空${collectSuffix}` }] };
    }
    const namePart: UIRawMessage = line.itemName
      ? { text: line.itemName }
      : { translate: new ItemStack(line.itemTypeId, 1).localizationKey };
    return {
      rawtext: [...warningPrefix, { text: `${slotLabel}: ` }, namePart, { text: ` -> ${line.targetAmount}${collectSuffix}` }],
    };
  }

  function slotLineTooltip(line: PrecisionSlotLine): UIRawMessage {
    const reason = slotGroupValidityReason(line.slotIndices);
    return { text: reason ? `§c${reason}` : "§7タップで削除します。" };
  }

  function refreshCurrent(): void {
    for (let i = 0; i < ROW_COUNT; i++) {
      const line = slots[i];
      currentVisible[i].setData(!!line);
      currentLabels[i].setData(line ? slotLineMessage(line) : { text: "" });
      currentTooltips[i].setData(line ? slotLineTooltip(line) : { text: "" });
    }
  }

  tabVisible.subscribe((active) => {
    if (active) {
      refreshSearch();
      refreshCurrent();
      refreshOverlapWarning();
    } else {
      hasPrevPage.setData(false);
      hasNextPage.setData(false);
      showPageLabel.setData(false);
      overlapWarningVisible.setData(false);
    }
  });

  form.label("スロット番号を指定して、維持したいアイテムと数量を設定します。", { visible: tabVisible });
  form.button(overlapWarningLabel, () => {}, { visible: overlapWarningVisible, tooltip: overlapWarningTooltip });
  form.textField("スロット番号", slotNumberText, {
    description: "例: 1 / 1,2,3 / 1-3 / 1,3-5,7(複数指定時は各スロットへ均等に分配します)",
    visible: tabVisible,
  });
  form.toggle("回収", collect, {
    visible: tabVisible,
  });
  const { amount: targetAmount } = setupQuantitySlider(form, "維持したい数量", tabVisible);
  form.textField("検索", searchText, { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.label("検索結果(タップで指定スロットに設定)", { visible: tabVisible });
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
        const slotIndices = readSlotIndices();
        if (slotIndices === undefined) return;

        const amount = Math.max(1, Math.floor(targetAmount.getData()));
        upsertSlot({
          slotIndices,
          itemTypeId: entry.key.typeId,
          itemName: entry.key.name,
          targetAmount: amount,
          collect: collect.getData(),
        });
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
    const tooltip = new ObservableUIRawMessage({ text: "" });
    const visible = new ObservableBoolean(false);
    currentLabels.push(label);
    currentTooltips.push(tooltip);
    currentVisible.push(visible);
    tabVisible.subscribe((active) => {
      if (!active) visible.setData(false);
    });

    form.button(
      label,
      () => {
        const line = slots[i];
        if (!line) return;
        slots = slots.filter((l) => l !== line);
        setPrecisionSlots(dimension, terminalLoc, slots);
        refreshCurrent();
        refreshOverlapWarning();
      },
      { visible, tooltip }
    );
  }

  form.divider({ visible: tabVisible });
  form.button(
    "目標を空に設定する",
    () => {
      const slotIndices = readSlotIndices();
      if (slotIndices === undefined) return;
      // 目標を0(itemTypeId無し)にする。「回収」がONならこれらのスロットは事実上、
      // 中身が何であれ常に全量回収される(=旧来の「出力スロット」相当)。
      upsertSlot({ slotIndices, targetAmount: 0, collect: collect.getData() });
    },
    { visible: tabVisible }
  );

  searchText.subscribe(() => {
    currentPage = 0;
    if (tabVisible.getData()) refreshSearch();
  });
  if (tabVisible.getData()) {
    refreshSearch();
    refreshCurrent();
    refreshOverlapWarning();
  }
}

// autoTerminalUi.tsのsetupSettingsTabと同じ考え方(名前のみ。精密ターミナルの回収可否は
// スロットごとの設定なので、自動端末のようなグローバルなトグルは無い)。
function setupSettingsTab(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  terminalLoc: Vector3,
  initialName: string,
  initialCollectUnspecified: boolean
): void {
  const name = new ObservableString(initialName, { clientWritable: true });
  name.subscribe((value) => {
    setTerminalName(dimension, terminalLoc, value);
  });

  const collectUnspecified = new ObservableBoolean(initialCollectUnspecified, { clientWritable: true });
  collectUnspecified.subscribe((value) => {
    setPrecisionCollectUnspecified(dimension, terminalLoc, value);
  });

  form.label("このターミナルの設定です。", { visible: tabVisible });
  form.divider({ visible: tabVisible });
  form.textField("名前", name, {
    description: "精密ターミナルの識別用です。",
    visible: tabVisible,
  });
  form.toggle("未指定スロットの回収", collectUnspecified, {
    description: "目標未指定のスロットからアイテムを回収します。",
    visible: tabVisible,
  });
}

export function showPrecisionTerminalUi(player: Player, block: Block): void {
  const dimension = block.dimension;
  const membership = findMembership(dimension.id, block.location);
  if (!membership) {
    player.sendMessage("§cこのターミナルはまだ倉庫ネットワークに接続されていません。");
    return;
  }
  const network = membership.network;
  const networkCatalog = scanCatalog(dimension, network);

  // 「現在のリスト」で、実在しないスロットを警告表示するために使う(setupSlotRuleTab参照)。
  const attachedLoc = getAttachedStorageLocation(block);
  const attachedContainerSize = dimension.getBlock(attachedLoc)?.getComponent("inventory")?.container?.size;

  const terminalName = getTerminalName(dimension, block.location);

  const isListTab = new ObservableBoolean(true);
  const isStatusTab = new ObservableBoolean(false);
  const isSettingsTab = new ObservableBoolean(false);

  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isListTab.setData(index === 0);
    isStatusTab.setData(index === 1);
    isSettingsTab.setData(index === 2);
  });

  const form = new CustomForm(player, terminalName ? `精密: ${terminalName}` : "精密");
  form.dropdown("", tabSelection, [
    { label: "スロット設定", value: 0 },
    { label: "状況", value: 1 },
    { label: "設定", value: 2 },
  ]);
  form.divider();

  setupSlotRuleTab(
    form,
    isListTab,
    dimension,
    block.location,
    networkCatalog,
    getPrecisionSlots(dimension, block.location),
    attachedContainerSize,
    player.clientSystemInfo.locale
  );

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
    getPrecisionCollectUnspecified(dimension, block.location)
  );

  form
    .show()
    .catch((e) => console.error(e))
    .finally(() => {
      system.clearRun(orderStatusRefreshTimer);
      system.clearRun(depositStatusRefreshTimer);
    });
}
