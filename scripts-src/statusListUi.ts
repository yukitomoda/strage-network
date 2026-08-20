import { Dimension, ItemStack, Player, system } from "@minecraft/server";
import {
  CustomForm,
  ObservableBoolean,
  ObservableString,
  ObservableUIRawMessage,
  UIRawMessage,
} from "@minecraft/server-ui";
import { cancelDeposit } from "./depositProcessing";
import { cancelOrder } from "./orderProcessing";
import { cancelOrganize } from "./organizeProcessing";
import { DepositRequest, Order, OrganizeRequest } from "./state";
import { getTerminalName } from "./terminalSettings";

// 「状況」タブ(コントローラUI・ターミナルUIの両方から使う共通実装)で使う一覧の行数。
const ROW_COUNT = 8;
// 「状況」タブを表示中に一覧を自動更新する間隔。form.show()はプレイヤーがフォームを
// 閉じるまで解決しないPromiseを返す仕組み(DDUI)なので、その完了時にclearRunすれば
// タイマーを残さず安全に自動更新できる。
// 短すぎるとラベル更新のたびにTooltipが一瞬消えて再表示されチラつく(実機で確認)ため、
// 5秒(100tick)に設定している。
export const STATUS_REFRESH_INTERVAL_TICKS = 100;

// 引き出し(OrderLine)・預け入れ(DepositLine)は品目ごとの進捗を全く同じ形で持つため、
// ツールチップ生成もこの共通の形に対して1つだけ書けばよい。slotIndexは精密ターミナルからの
// ラインのみ持つ(state.ts参照)。
type ProgressLine = {
  itemTypeId: string;
  itemName?: string;
  requested: number;
  delivered: number;
  exhausted: boolean;
  slotIndex?: number;
};

// 品目ごとの「配送済み/要求数」を色分けして並べたツールチップ(§書式コードが効くのは
// ボタンのtooltipだけ、詳細はdocs/design.md 7章参照)。
function progressTooltip(lines: ProgressLine[], cancelHint: string): UIRawMessage {
  const parts: UIRawMessage[] = [];
  lines.forEach((line, i) => {
    if (i > 0) parts.push({ text: "\n" });
    const color = line.exhausted ? "§c" : line.delivered >= line.requested ? "§a" : "§e";
    parts.push({ text: `${color}${line.delivered}/${line.requested} ` });
    if (line.slotIndex !== undefined) parts.push({ text: `スロット${line.slotIndex}: ` });
    parts.push(
      line.itemName ? { text: line.itemName } : { translate: new ItemStack(line.itemTypeId, 1).localizationKey }
    );
    if (line.exhausted) parts.push({ text: "§c(品切れ)" });
  });
  parts.push({ text: `\n§7${cancelHint}` });
  return { rawtext: parts };
}

// 「状況」タブの1セクション分(引き出し一覧・預け入れ一覧・整理一覧のどれにも使う汎用実装。
// コントローラUIでは「ネットワーク全体」を、ターミナルUIでは「この端末に絞ったもの」を
// fetchAllに渡すことで、同じ実装を両方から使い回せる)。
// 進行中のリクエスト一覧をページャー付きの行ボタンで表示し、タップでキャンセルする
// (巻き戻しはせず、残りの未処理ラインだけを取り消す。詳細はorderProcessing.tsの
// processOrderCancels/depositProcessing.tsのprocessDepositCancels参照)。
// 戻り値のtimer idは、呼び出し元がform.show()の完了時にclearRunする。
function setupCancellableList<T>(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  headerText: string | undefined,
  fetchAll: () => T[],
  getRequestId: (item: T) => string,
  label: (item: T) => UIRawMessage,
  tooltip: (item: T) => UIRawMessage,
  onCancel: (item: T) => void
): number {
  // キャンセルは次tickの処理ループで実際に取り除かれるため、それまでの間も見た目には
  // 即座に反映されるよう、このUIセッション内でキャンセル済みのrequestIdを覚えておいて
  // 一覧から除外する。
  const cancelledIds = new Set<string>();

  const rowLabels: ObservableUIRawMessage[] = [];
  const rowTooltips: ObservableUIRawMessage[] = [];
  const rowVisible: ObservableBoolean[] = [];
  let filtered: T[] = [];

  let currentPage = 0;
  const hasPrevPage = new ObservableBoolean(false);
  const hasNextPage = new ObservableBoolean(false);
  const pageLabel = new ObservableString("1 / 1 ページ");
  // ページが1つしか無い(=ほぼ常にそう)場合にまで「1 / 1 ページ」を表示すると煩わしいため、
  // 2ページ以上ある時だけ表示する。
  const showPageLabel = new ObservableBoolean(false);

  function refresh(): void {
    const all = fetchAll().filter((item) => !cancelledIds.has(getRequestId(item)));
    const totalPages = Math.max(1, Math.ceil(all.length / ROW_COUNT));
    currentPage = Math.min(Math.max(currentPage, 0), totalPages - 1);

    filtered = all.slice(currentPage * ROW_COUNT, (currentPage + 1) * ROW_COUNT);
    for (let i = 0; i < ROW_COUNT; i++) {
      const item = filtered[i];
      rowVisible[i].setData(!!item);
      rowLabels[i].setData(item ? label(item) : { text: "" });
      rowTooltips[i].setData(item ? tooltip(item) : { text: "" });
    }

    hasPrevPage.setData(currentPage > 0);
    hasNextPage.setData(currentPage < totalPages - 1);
    pageLabel.setData(`${currentPage + 1} / ${totalPages} ページ`);
    showPageLabel.setData(totalPages > 1);
  }

  tabVisible.subscribe((active) => {
    if (active) {
      refresh();
    } else {
      // タブ非表示中はページャーボタンも隠す(AND合成が無いための対処、他タブと同じ)。
      hasPrevPage.setData(false);
      hasNextPage.setData(false);
      showPageLabel.setData(false);
    }
  });

  // headerTextを渡さない呼び出し元(controllerUi.ts)は、スループット表示と兼用の独自の
  // ヘッダーを自分で描画済みなので、ここでの重複ヘッダーは省略する。
  if (headerText !== undefined) form.label(headerText, { visible: tabVisible });
  form.label(pageLabel, { visible: showPageLabel });

  form.button(
    "▲ 前のページ",
    () => {
      currentPage--;
      refresh();
    },
    { visible: hasPrevPage }
  );

  for (let i = 0; i < ROW_COUNT; i++) {
    const rowLabel = new ObservableUIRawMessage({ text: "" });
    const rowTooltip = new ObservableUIRawMessage({ text: "" });
    const visible = new ObservableBoolean(false);
    rowLabels.push(rowLabel);
    rowTooltips.push(rowTooltip);
    rowVisible.push(visible);
    tabVisible.subscribe((active) => {
      if (!active) visible.setData(false);
    });

    form.button(
      rowLabel,
      () => {
        const item = filtered[i];
        if (!item) return;
        onCancel(item);
        cancelledIds.add(getRequestId(item));
        refresh();
      },
      { visible, tooltip: rowTooltip }
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

  // tabVisible.subscribeは値が変化した時にしか発火せず、既定で表示中(true)のタブの場合
  // これが無いと最初のrefresh()が自動更新の周期まで呼ばれず、開いた直後は一覧が空に
  // 見えてしまう(実機で発見・修正)。他のページャー付き一覧(terminalUi.ts/autoTerminalUi.ts)
  // と同じ、開いた時点での明示的な初期表示。
  if (tabVisible.getData()) refresh();

  // タブを開いている間、一覧を定期的に自動更新する(他プレイヤーの操作や自動端末による
  // 新規リクエスト・進捗の変化を反映するため)。タイマーの停止は呼び出し元で行う。
  return system.runInterval(() => {
    if (tabVisible.getData()) refresh();
  }, STATUS_REFRESH_INTERVAL_TICKS);
}

// includeHeaderをfalseにすると、セクション見出しの行を描画しない(controllerUi.tsのように
// 呼び出し元がスループット表示と兼用の独自ヘッダーを既に描画している場合に使う)。
export function setupOrderStatusSection(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  player: Player,
  networkId: string,
  fetchAll: () => Order[],
  includeHeader = true
): number {
  return setupCancellableList<Order>(
    form,
    tabVisible,
    includeHeader ? "引き出し" : undefined,
    fetchAll,
    (order) => order.requestId,
    (order) => {
      const terminalName = getTerminalName(dimension, order.terminal) ?? "端末";
      const who = order.playerName || "自動";
      return { text: `#${order.id} ${terminalName} (${who})` };
    },
    (order) => progressTooltip(order.lines, "タップでキャンセルします(配送済みの分は返送されません)。"),
    (order) => {
      cancelOrder(networkId, order.requestId);
      player.sendMessage(`§e引き出し #${order.id} をキャンセルしました。`);
    }
  );
}

export function setupDepositStatusSection(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  dimension: Dimension,
  player: Player,
  networkId: string,
  fetchAll: () => DepositRequest[],
  includeHeader = true
): number {
  return setupCancellableList<DepositRequest>(
    form,
    tabVisible,
    includeHeader ? "預け入れ" : undefined,
    fetchAll,
    (request) => request.id,
    (request) => {
      const terminalName = getTerminalName(dimension, request.terminal) ?? "端末";
      const who = request.playerName || "自動";
      return { text: `#${request.displayId} ${terminalName} (${who})` };
    },
    (request) => progressTooltip(request.lines, "タップでキャンセルします(格納済みの分は返送されません)。"),
    (request) => {
      cancelDeposit(networkId, request.id);
      player.sendMessage(`§e預け入れ #${request.displayId} をキャンセルしました。`);
    }
  );
}

// 整理は引き出し/預け入れと違い品目ごとの数量進捗を持たない(OrganizeLineは`done`のみ)ため、
// 品目数ベースの進捗(何品目中何品目が完了したか)で表示する。また搬入出先の端末という
// 概念も無いため、ラベルに端末名は含まれない。ネットワーク全体が対象で特定の端末には
// 紐づかないため、現状コントローラUIからのみ使う(ターミナルUIには無い)。
export function setupOrganizeStatusSection(
  form: CustomForm,
  tabVisible: ObservableBoolean,
  player: Player,
  networkId: string,
  fetchAll: () => OrganizeRequest[],
  includeHeader = true
): number {
  return setupCancellableList<OrganizeRequest>(
    form,
    tabVisible,
    includeHeader ? "整理" : undefined,
    fetchAll,
    (request) => request.id,
    (request) => {
      const done = request.lines.filter((l) => l.done).length;
      const who = request.playerName || "自動";
      return { text: `#${request.displayId} 整理 (${who})` };
    },
    (request) => {
      const done = request.lines.filter((l) => l.done).length;
      return {
        text: `§b進捗: ${done}/${request.lines.length} 品目\n§7タップでキャンセルします(整理済みの分は元に戻りません)。`,
      };
    },
    (request) => {
      cancelOrganize(networkId, request.id);
      player.sendMessage(`§e倉庫の整理 #${request.displayId} をキャンセルしました。`);
    }
  );
}
