import { Block, Dimension, ItemCustomComponent, Player, system, world } from "@minecraft/server";
import {
  findAdjacentConnectedStorage,
  findMembership,
  findNetworkByController,
  findPhysicalStoragePair,
  getAllNetworks,
  getNetwork,
  isWithinNetworkRange,
  toggleObserver,
  resolveStorageMembership,
  toggleStorage,
  toggleTerminal,
} from "./network";
import { NETWORK_OBSERVER_BLOCK_ID } from "./networkObserverBlock";
import { resetObserverSignal } from "./networkObserverProcessing";
import { locEquals, NetworkData } from "./state";
import { getDrain, removeSettingsEntity as removeStorageSettingsEntity, setDrain } from "./storageSettings";
import { isTerminalLikeBlock } from "./terminalBlock";
import { getToolMode } from "./toolMode";
import { showToolModeUi } from "./toolModeUi";
import {
  currentHighlightMode,
  endEditingSession,
  getEditingNetworkId,
  isAnyoneEditingNetwork,
  setEditingNetworkId,
} from "./editingSession";
import { syncRangeIndicator } from "./rangeIndicator";
import { syncMemberHighlight } from "./memberHighlight";
import { CONTROLLER_RANGE_AXIS, getRangeForTier } from "./controllerAxes";
import { getAxisTier } from "./upgrade";

const HIGHLIGHT_INTERVAL = 10;

// ネットワークオブザーバーの最大接続数。MVP: 固定値。将来はアップグレード軸(4章「グレード管理」
// と同じ枠組み)にする想定だが、現時点では未実装(docs/design.md参照)。
const MAX_OBSERVERS_PER_NETWORK = 3;

// onUse は「ブロックに対して使った場合」も(onUseOnとは別に)発火してしまう。当初は視線の先に
// 何らかのブロックが少しでもあれば一律でメニューを諦めていたが、それだと壁際やブロックが
// 密集した場所ではまず空中に視線を外さないとメニューを開けず不便すぎる(ユーザー指摘)。
// onUseOnが実際に何かを処理するのは、(a)視線の先がコントローラの場合(編集セッションの
// 開始/終了)、(b)ネットワーク編集セッション中に何らかのブロックへ使った場合(接続/切断・
// Drain指定)の2パターンだけなので、この2パターンに該当する時だけメニューを諦めれば十分
// (誤ってメニューと本来の操作が同時に発火する事故を避けつつ、それ以外の場面ではブロックが
// 視線の先にあってもメニューを開けるようにする)。実際のブロック操作の到達距離とは
// 厳密には一致しなくてよい。
const AIR_USE_RAYCAST_DISTANCE = 8;

export const wrenchItemComponent: ItemCustomComponent = {
  // モード選択メニューを開く(視線の先に何もない場合、または何かあっても
  // onUseOnが処理しない場合)。
  onUse(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;
    const hit = player.getBlockFromViewDirection({ maxDistance: AIR_USE_RAYCAST_DISTANCE });
    const targetTypeId = hit?.block.typeId;
    if (targetTypeId === "wh:controller") return; // onUseOnがコントローラの編集開始/終了を処理する
    if (targetTypeId !== undefined && getEditingNetworkId(player) !== undefined) {
      return; // 編集セッション中はonUseOnが接続/切断・Drain指定を処理する
    }
    showToolModeUi(player);
  },
  onUseOn(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;

    const block = event.block;
    const dimension = block.dimension;

    // コントローラへの操作はモードに関係なく共通: Shift+右クリックでネットワーク編集の
    // 開始/終了をトグルする(どのモードでも同じ操作感にするため)。
    if (block.typeId === "wh:controller") {
      handleControllerUse(player, dimension, block);
      return;
    }

    const editingNetworkId = getEditingNetworkId(player);
    if (editingNetworkId === undefined) {
      player.sendMessage(
        "§cまずコントローラをShiftキーを押しながら右クリックしてネットワーク編集を開始してください。"
      );
      return;
    }

    if (getToolMode(player) === "drain") {
      handleDrainModeUse(player, dimension, block, editingNetworkId);
      return;
    }

    handleBuildModeUse(player, dimension, block, editingNetworkId);
  },
};

// ネットワーク編集セッションの開始/終了。トグル動作で、同じネットワークを編集中に再度
// Shift+右クリックすると終了する。モードによってこの後の操作内容(接続/切断かDrain指定か)は
// 変わるが、開始/終了の操作自体はどのモードでも同じにする。
function handleControllerUse(player: Player, dimension: Dimension, block: Block): void {
  if (!player.isSneaking) {
    player.sendMessage("§7ネットワーク編集の開始/終了は、コントローラをShiftキーを押しながら右クリックしてください。");
    return;
  }

  const network = findNetworkByController(dimension.id, block.location);
  if (!network) {
    player.sendMessage("§cこのコントローラのネットワーク情報が見つかりません。");
    return;
  }

  if (getEditingNetworkId(player) === network.id) {
    endEditingSession(player);
    player.sendMessage("§eネットワーク編集を終了しました。");
    return;
  }

  setEditingNetworkId(player, network.id);
  // 自分が今まさに編集を開始したので、isAnyoneEditingNetworkを問い合わせるまでもなく必ず表示する。
  syncRangeIndicator(dimension, network, true);
  syncMemberHighlight(dimension, network, getToolMode(player) === "drain" ? "drain" : "build");
  const modeHint =
    getToolMode(player) === "drain"
      ? "ストレージをShiftキーを押しながら右クリックして格納禁止指定を切り替えてください。"
      : "ストレージ/ターミナルをShiftキーを押しながら右クリックして接続/切断してください。";
  player.sendMessage(`§bネットワーク編集を開始しました。${modeHint}再度コントローラをShiftキーを押しながら右クリックすると終了します。`);
}

// 範囲軸(controllerAxes.ts)の現在Tierから、このネットワークの接続可能範囲を引く。
function getEffectiveRange(dimension: Dimension, network: NetworkData): number {
  return getRangeForTier(getAxisTier(dimension, network.controller, CONTROLLER_RANGE_AXIS));
}

// 接続/切断・Drain指定の変更でメンバー構成が変わるたびに呼ぶ。トグル関数がworldの動的
// プロパティへ書き戻した直後の最新状態を反映させるため、渡された network 変数ではなく
// 都度 getNetwork で読み直す(handleBuildModeUse/handleDrainModeUse呼び出し時点のnetwork変数は
// トグル前のスナップショットのため)。
function refreshMemberHighlight(dimension: Dimension, networkId: string, mode: "build" | "drain"): void {
  const network = getNetwork(networkId);
  if (network) syncMemberHighlight(dimension, network, mode);
}

// 従来のネットワーク構築モード(ストレージ/ターミナルを右クリックして接続/切断)。倉庫レンチの
// デフォルトモード。コントローラでの編集開始/終了はhandleControllerUseに一本化されている。
function handleBuildModeUse(player: Player, dimension: Dimension, block: Block, editingNetworkId: string): void {
  if (isTerminalLikeBlock(block.typeId)) {
    const network = getNetwork(editingNetworkId);
    const alreadyInThisNetwork = network?.terminals.some((t) => locEquals(t, block.location));
    if (!alreadyInThisNetwork) {
      // 新規接続(切断は範囲外でも常に許可する。既存メンバーが後から範囲外になった場合に
      // 切断すらできなくなる事故を避けるため)。
      if (network && !isWithinNetworkRange(network, block.location, getEffectiveRange(dimension, network))) {
        player.sendMessage(
          `§cコントローラから各方向に${getEffectiveRange(dimension, network)}マスを超えているため接続できません。`
        );
        return;
      }

      // ターミナルはストレージと違い、同時に複数のネットワークに接続されると
      // どちらのネットワーク宛の引き出し/預け入れとして処理すべきか曖昧になり誤動作する
      // (実機で発見された不具合の修正済み)。そのため、他のネットワークに既に
      // 接続済みのターミナルは、そのネットワークから切断するまで新規接続を拒否する。
      const existingMembership = findMembership(dimension.id, block.location);
      if (existingMembership && existingMembership.role === "terminal") {
        player.sendMessage(
          "§cこのターミナルは既に別のネットワークに接続されています(1台のターミナルは同時に1つのネットワークにしか接続できません)。"
        );
        return;
      }
    }

    const result = toggleTerminal(editingNetworkId, block.location);
    refreshMemberHighlight(dimension, editingNetworkId, "build");
    player.sendMessage(result === "connected" ? "§bターミナルを接続しました。" : "§eターミナルを切断しました。");
    return;
  }

  if (block.typeId === NETWORK_OBSERVER_BLOCK_ID) {
    const network = getNetwork(editingNetworkId);
    const alreadyConnected = network?.observers.some((o) => locEquals(o, block.location));
    if (network && !alreadyConnected) {
      // 新規接続(切断は範囲外でも常に許可する。ストレージ/ターミナルと同じ理由)。
      if (!isWithinNetworkRange(network, block.location, getEffectiveRange(dimension, network))) {
        player.sendMessage(
          `§cコントローラから各方向に${getEffectiveRange(dimension, network)}マスを超えているため接続できません。`
        );
        return;
      }

      if (network.observers.length >= MAX_OBSERVERS_PER_NETWORK) {
        player.sendMessage(
          `§cネットワークオブザーバーは1ネットワークにつき最大${MAX_OBSERVERS_PER_NETWORK}基までしか接続できません。`
        );
        return;
      }
    }

    const result = toggleObserver(editingNetworkId, block.location);
    if (result === "disconnected") {
      resetObserverSignal(dimension, block.location);
    }
    refreshMemberHighlight(dimension, editingNetworkId, "build");
    player.sendMessage(result === "connected" ? "§bオブザーバーを接続しました。" : "§eオブザーバーを切断しました。");
    return;
  }

  if (block.getComponent("inventory")?.container) {
    const network = getNetwork(editingNetworkId);
    const alreadyConnected = network?.storages.some((s) => locEquals(s, block.location));
    if (network && !alreadyConnected) {
      // 二連チェストで、クリックしたのは登録されていない側だが、中身を共有するもう半分は
      // 既に接続済み: 新規接続の試みとしてではなく、その接続済みの半分を切断する操作として
      // 扱う(ユーザー指摘: 見た目上は両方とも強調表示されるのに、登録されている方でないと
      // 切断できず分かりにくい。どちらの半分を右クリックしても切断できるようにしてほしい)。
      // Drainモード(handleDrainModeUse)のresolveStorageMembershipと同じ考え方。
      // 切断は範囲外でも常に許可する方針(下の新規接続の範囲チェックより先に判定する)。
      const paired = findAdjacentConnectedStorage(dimension, network, block.location);
      if (paired) {
        toggleStorage(editingNetworkId, paired); // 接続済みと確認済みのため必ず切断側になる
        removeStorageSettingsEntity(dimension, paired);
        removeStorageSettingsEntity(dimension, block.location);
        refreshMemberHighlight(dimension, editingNetworkId, "build");
        player.sendMessage("§eストレージを切断しました。");
        return;
      }

      // 新規接続(切断は範囲外でも常に許可する。ターミナル側と同じ理由)。
      if (!isWithinNetworkRange(network, block.location, getEffectiveRange(dimension, network))) {
        player.sendMessage(
          `§cコントローラから各方向に${getEffectiveRange(dimension, network)}マスを超えているため接続できません。`
        );
        return;
      }
    }

    const result = toggleStorage(editingNetworkId, block.location);
    if (result === "disconnected") {
      removeStorageSettingsEntity(dimension, block.location);
      const pair = findPhysicalStoragePair(dimension, block.location);
      if (pair) removeStorageSettingsEntity(dimension, pair);
    }
    refreshMemberHighlight(dimension, editingNetworkId, "build");
    player.sendMessage(result === "connected" ? "§bストレージを接続しました。" : "§eストレージを切断しました。");
    return;
  }

  player.sendMessage("§cこのブロックは接続できません(コンテナを持つブロックのみ接続可能です)。");
}

// Drainモード: 編集中のネットワークに接続済みのストレージをShift+右クリックすると、
// そのストレージへの新規預け入れを止め(depositProcessing.ts/insertIntoStorages)、
// 倉庫の整理ではできる限り中身を他のストレージへ退避させる(organizeProcessing.ts)。
// 構築モードと同様、事前にコントローラで編集セッションを開始しておく必要がある。
function handleDrainModeUse(player: Player, dimension: Dimension, block: Block, editingNetworkId: string): void {
  if (!block.getComponent("inventory")?.container) {
    player.sendMessage("§cこのブロックはストレージとして扱えません(コンテナを持つブロックのみ対象です)。");
    return;
  }

  const resolved = resolveStorageMembership(dimension, block.location);
  if (!resolved || resolved.network.id !== editingNetworkId) {
    player.sendMessage("§cこのストレージは編集中のネットワークに接続されていません。");
    return;
  }

  const { registeredLocation } = resolved;
  const newValue = !getDrain(dimension, registeredLocation);
  setDrain(dimension, registeredLocation, newValue);

  // 二連チェストの場合、中身を共有するもう半分(登録されていない側)にも同じ値を反映する。
  const pair = findPhysicalStoragePair(dimension, registeredLocation);
  if (pair) setDrain(dimension, pair, newValue);

  refreshMemberHighlight(dimension, editingNetworkId, "drain");

  player.sendMessage(
    newValue
      ? "§eこのストレージを格納禁止に指定しました。"
      : "§bこのストレージの格納禁止指定を解除しました。"
  );
}

// 接続範囲インジケータ(rangeIndicator.ts)・メンバーハイライト(memberHighlight.ts)の表示状態を
// 全ネットワーク分まとめて再計算する。プレイヤーの参加/離脱・編集開始/終了のたびに個別に
// 呼ぶだけでは、ログアウトのタイミング次第で後片付けが漏れることがある(playerLeaveの
// 後片付けを参照)ため、この定期実行を「必ず正しい状態に収束させる」ための保険として
// 毎tickループに乗せている(通常は接続/切断/Drain指定変更の都度その場で同期されるため、
// この定期実行が実際に表示を動かすのは主に取りこぼしの自己修復時)。
function reconcileAllIndicators(): void {
  for (const network of getAllNetworks()) {
    const dimension = world.getDimension(network.dimensionId);
    const editing = isAnyoneEditingNetwork(network.id);
    syncRangeIndicator(dimension, network, editing);
    syncMemberHighlight(dimension, network, editing ? currentHighlightMode(network) : "off");
  }
}

export function startWrenchHighlightLoop(): void {
  system.runInterval(reconcileAllIndicators, HIGHLIGHT_INTERVAL);
}

// 編集セッション中(wh:editing_networkを持つ)にプレイヤーがログアウトすると、
// 明示的な終了操作(コントローラのShift+右クリック/レンチメニューの終了ボタン)を
// 経ないまま抜けてしまう。beforeEvents.playerLeaveはプレイヤーがまだ存在する時点で
// 発火するため、ここでendEditingSessionを呼んで即座に後片付けを試みる。
// (実機で発見された不具合の修正): シングルプレイでワールドを終了する場合など、
// このイベント内の処理が完了する前にワールド自体が終了してしまい、後片付けが
// 反映されないことがあった。そのため、これは「できれば即座に」という best-effort の
// 位置づけにとどめ、確実な後片付けはstartWrenchHighlightLoopの定期的な
// reconcileAllIndicators側に委ねている(isAnyoneEditingNetworkはオンライン中の
// プレイヤーしか見ないため、ログアウトした時点でそのプレイヤーの分は自動的に
// 「編集中ではない」扱いになり、壁は正しく消える。唯一、このイベントが正常に処理されずに
// wh:editing_networkが消し忘れられた場合は、次回ログイン時に編集モードへ復帰したように
// 見えてしまう副作用が残るが、実害は軽微でありコントローラを再度Shift+右クリックすれば
// いつでも解消できる)。
export function registerWrenchPlayerLeaveWatcher(): void {
  world.beforeEvents.playerLeave.subscribe((event) => {
    endEditingSession(event.player);
  });
}
