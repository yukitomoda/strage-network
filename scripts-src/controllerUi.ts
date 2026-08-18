import { Block, Player, system } from "@minecraft/server";
import { CustomForm, ObservableBoolean, ObservableNumber, ObservableString } from "@minecraft/server-ui";
import { CONTROLLER_AXES, CONTROLLER_CYCLE_AXIS, CONTROLLER_SPEED_AXIS } from "./controllerAxes";
import { getNotifyOnOrganizeComplete, setNotifyOnOrganizeComplete } from "./controllerSettings";
import { getDepositThroughput, listActiveDeposits } from "./depositProcessing";
import { findNetworkByController } from "./network";
import { getCycleIntervalTicks } from "./networkProcessing";
import { getOrderThroughput, listActiveOrders } from "./orderProcessing";
import { getOrganizeThroughput, listActiveOrganize, submitOrganize } from "./organizeProcessing";
import { scanCatalog } from "./storageScan";
import { setupDepositStatusSection, setupOrderStatusSection, setupOrganizeStatusSection } from "./statusListUi";
import { getAxisMaxTier, getAxisTier, giveOrDropKits, setAxisTier, UpgradeAxis } from "./upgrade";

// 各処理の「スループット」は処理ループ1回(サイクル)あたりの予算であり、サーバーtick単位の
// レートではない(実際に何tickごとにサイクルが回るかは「周期」アップグレード軸のTierで別途
// 変わる)。「/tick」のような換算後の値だけを見せると、あたかもサーバーtickごとのレートで
// あるかのように誤解を招く(実機での指摘を受けた修正)ため、単位を「/cycle」と明示する。
function perCycleLabel(throughputPerCycle: number): string {
  return `${throughputPerCycle}/cycle`;
}

function cycleIntervalLabel(cycleTicks: number): string {
  return `${cycleTicks}tick/cycle`;
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
  // その端末に絞り込む。statusListUi.ts参照)。現在のスループット/周期は「アップグレード」
  // タブへ移動した(各軸のTier表示の下にまとめて表示する。後述)。
  form.label('引き出し', { visible: isStatusTab });
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
  form.label('預け入れ', { visible: isStatusTab });
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
  form.label('整理', { visible: isStatusTab });
  const organizeStatusRefreshTimer = setupOrganizeStatusSection(
    form,
    isStatusTab,
    player,
    network.id,
    () => listActiveOrganize(network.id),
    false
  );

  // 軸ごとに現在のTierと、装着済みのキットを取り出す(Tier0に戻す)ボタンを表示する。
  // CONTROLLER_AXESをループするだけなので、将来軸が増えても自動的に1組増える。速度軸には
  // 引き出し/預け入れ/整理のスループットを、周期軸にはサイクル間隔を、Tier表示の下に
  // 併記する(以前は「状況」タブに独立して表示していたが、アップグレードの効果を確認する
  // 場所として一本化した方が分かりやすいという要望を受けて移動した)。
  for (const axis of CONTROLLER_AXES) {
    const initialTier = getAxisTier(dimension, block.location, axis);
    // 開いた時点の値を素の文字列で渡すと、ボタンを押しても表示が更新されない(DDUIのCustomForm
    // はObservable経由でしか再描画されない)ため、ObservableStringにしてsetData()で更新する。
    const tierLabel = new ObservableString(formatAxisTierLabel(axis, initialTier));
    // Tier0(アップグレード無し)の間はボタンを非活性にする。取り出した直後もtrueに戻す。
    const isEmpty = new ObservableBoolean(initialTier === 0);
    form.label(tierLabel, { visible: isUpgradeTab });

    // 軸ごとの効果の内訳。取り出しボタンでTierが0に戻った時に、こちらも合わせて更新する。
    let updateDetailLabels: (tier: number) => void = () => {};
    if (axis === CONTROLLER_SPEED_AXIS) {
      const orderLabel = new ObservableString(`引き出し： §7${perCycleLabel(getOrderThroughput(initialTier))}`);
      const depositLabel = new ObservableString(`預け入れ： §7${perCycleLabel(getDepositThroughput(initialTier))}`);
      const organizeLabel = new ObservableString(`内部： §7${perCycleLabel(getOrganizeThroughput(initialTier))}`);
      form.label(orderLabel, { visible: isUpgradeTab });
      form.label(depositLabel, { visible: isUpgradeTab });
      form.label(organizeLabel, { visible: isUpgradeTab });
      updateDetailLabels = (tier) => {
        orderLabel.setData(`引き出し： §7${perCycleLabel(getOrderThroughput(tier))}`);
        depositLabel.setData(`預け入れ： §7${perCycleLabel(getDepositThroughput(tier))}`);
        organizeLabel.setData(`内部： §7${perCycleLabel(getOrganizeThroughput(tier))}`);
      };
    } else if (axis === CONTROLLER_CYCLE_AXIS) {
      const cycleLabel = new ObservableString(`周期： §7${cycleIntervalLabel(getCycleIntervalTicks(initialTier))}`);
      form.label(cycleLabel, { visible: isUpgradeTab });
      updateDetailLabels = (tier) => {
        cycleLabel.setData(`周期： §7${cycleIntervalLabel(getCycleIntervalTicks(tier))}`);
      };
    }

    form.button(
      `取り出す`,
      () => {
        const currentTier = getAxisTier(dimension, block.location, axis);
        if (currentTier === 0) return; // 非活性化されているため通常は到達しない
        giveOrDropKits(dimension, block.location, axis, currentTier, player);
        setAxisTier(block, axis, 0);
        tierLabel.setData(formatAxisTierLabel(axis, 0));
        updateDetailLabels(0);
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
