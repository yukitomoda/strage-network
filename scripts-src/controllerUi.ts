import { Block, Player, system } from "@minecraft/server";
import { CustomForm, ObservableBoolean, ObservableNumber, ObservableString } from "@minecraft/server-ui";
import { CONTROLLER_AXES, CONTROLLER_SPEED_AXIS } from "./controllerAxes";
import { getNotifyOnOrganizeComplete, setNotifyOnOrganizeComplete } from "./controllerSettings";
import { getDepositThroughput, listActiveDeposits } from "./depositProcessing";
import { findNetworkByController } from "./network";
import { NETWORK_PROCESSING_INTERVAL_TICKS } from "./networkProcessing";
import { getOrderThroughput, listActiveOrders } from "./orderProcessing";
import { getOrganizeThroughput, listActiveOrganize, submitOrganize } from "./organizeProcessing";
import { scanCatalog } from "./storageScan";
import { setupDepositStatusSection, setupOrderStatusSection, setupOrganizeStatusSection } from "./statusListUi";
import { getAxisMaxTier, getAxisTier, giveOrDropKits, setAxisTier, UpgradeAxis } from "./upgrade";

// コントローラのタスク処理ループは、Minecraftのサーバーtick20回につき1回だけ実行される
// (NETWORK_PROCESSING_INTERVAL_TICKS)。各処理の「スループット」(コントローラの速度アップグレード
// 軸のTierに応じて変わる)はこのループ1回あたりの予算であり、サーバーtick単位のレートではない。
// 「/tick」のような換算後の値だけを見せると、
// あたかもサーバーtickごとのレートであるかのように誤解を招く(実機での指摘を受けた修正)ため、
// 分母のサーバーtick数(=1サイクルが何tickか)もそのまま併記する形にしている。
function throughputLabel(throughputPerCycle: number): string {
  return `${throughputPerCycle}/${NETWORK_PROCESSING_INTERVAL_TICKS}tick`;
}

function formatAxisTierLabel(axis: UpgradeAxis, tier: number): string {
  return `${axis.label} Tier ${tier} / ${getAxisMaxTier(axis)}`;
}

// 素手(レンチ以外)でコントローラを右クリックした時のUI。「状況」「整理」「アップグレード」
// 「設定」の4タブ構成(terminalUi.ts/autoTerminalUi.tsと同じく、タブの選択はdropdownで行う)。
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
  const isUpgradeTab = new ObservableBoolean(false);
  const isSettingsTab = new ObservableBoolean(false);

  const tabSelection = new ObservableNumber(0, { clientWritable: true });
  tabSelection.subscribe((index) => {
    isStatusTab.setData(index === 0);
    isOrganizeTab.setData(index === 1);
    isUpgradeTab.setData(index === 2);
    isSettingsTab.setData(index === 3);
  });

  const speedTier = getAxisTier(dimension, block.location, CONTROLLER_SPEED_AXIS);

  const form = new CustomForm(player, "倉庫コントローラ");
  form.dropdown("", tabSelection, [
    { label: "状況", value: 0 },
    { label: "整理", value: 1 },
    { label: "アップグレード", value: 2 },
    { label: "設定", value: 3 },
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
      const organizeId = submitOrganize(
        network.id,
        player.name,
        catalog.map((entry) => ({ itemTypeId: entry.key.typeId, itemName: entry.key.name }))
      );
      player.sendMessage(
        organizeId ? `§b倉庫の整理 #${organizeId} をキューに追加しました。` : "§eすでに整理中です。"
      );
    },
    { visible: isOrganizeTab }
  );

  // コントローラの「状況」タブはネットワーク全体が対象(ターミナルUIの「状況」タブは
  // その端末に絞り込む。statusListUi.ts参照)。各タスク一覧の上に、現在のスループットを
  // 「値/サイクルのtick数」の形式で表示する(MVPでは固定値、将来はグレードに応じて
  // 可変にする想定。docs/design.md 4章「スループット制」参照)。整理は搬入出先の
  // ターミナルを介さずストレージ間でアイテムを動かすだけなので「内部」と表示する。
  form.label(`引き出し §7${throughputLabel(getOrderThroughput(speedTier))}`, { visible: isStatusTab });
  const orderStatusRefreshTimer = setupOrderStatusSection(
    form,
    isStatusTab,
    dimension,
    player,
    network.id,
    () => listActiveOrders(network.id),
    false
  );
  form.divider({ visible: isStatusTab });
  form.label(`預け入れ §7${throughputLabel(getDepositThroughput(speedTier))}`, { visible: isStatusTab });
  const depositStatusRefreshTimer = setupDepositStatusSection(
    form,
    isStatusTab,
    dimension,
    player,
    network.id,
    () => listActiveDeposits(network.id),
    false
  );
  form.divider({ visible: isStatusTab });
  form.label(`内部 §7${throughputLabel(getOrganizeThroughput(speedTier))}`, { visible: isStatusTab });
  const organizeStatusRefreshTimer = setupOrganizeStatusSection(
    form,
    isStatusTab,
    player,
    network.id,
    () => listActiveOrganize(network.id),
    false
  );

  // 軸ごとに現在のTierと、装着済みのキットを取り出す(Tier0に戻す)ボタンを表示する。
  // CONTROLLER_AXESをループするだけなので、将来「範囲」等の軸が増えても自動的に1行増える。
  for (const axis of CONTROLLER_AXES) {
    const initialTier = getAxisTier(dimension, block.location, axis);
    // 開いた時点の値を素の文字列で渡すと、ボタンを押しても表示が更新されない(DDUIのCustomForm
    // はObservable経由でしか再描画されない)ため、ObservableStringにしてsetData()で更新する。
    const tierLabel = new ObservableString(formatAxisTierLabel(axis, initialTier));
    // Tier0(アップグレード無し)の間はボタンを非活性にする。取り出した直後もtrueに戻す。
    const isEmpty = new ObservableBoolean(initialTier === 0);
    form.label(tierLabel, { visible: isUpgradeTab });
    form.button(
      `取り出す`,
      () => {
        const currentTier = getAxisTier(dimension, block.location, axis);
        if (currentTier === 0) return; // 非活性化されているため通常は到達しない
        giveOrDropKits(dimension, block.location, axis, currentTier, player);
        setAxisTier(block, axis, 0);
        tierLabel.setData(formatAxisTierLabel(axis, 0));
        isEmpty.setData(true);
        player.sendMessage(`§e${axis.label}のアップグレードキットを取り出しました。`);
      },
      { visible: isUpgradeTab, disabled: isEmpty }
    );
    form.divider({ visible: isUpgradeTab });
  }

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
    .finally(() => {
      system.clearRun(orderStatusRefreshTimer);
      system.clearRun(depositStatusRefreshTimer);
      system.clearRun(organizeStatusRefreshTimer);
    });
}
