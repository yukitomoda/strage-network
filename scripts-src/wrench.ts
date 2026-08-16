import { Block, Dimension, ItemCustomComponent, Player, system, Vector3, world } from "@minecraft/server";
import {
  findAdjacentConnectedStorage,
  findMembership,
  findNetworkByController,
  findPhysicalStoragePair,
  getAllNetworks,
  getNetwork,
  isWithinNetworkRange,
  NETWORK_RANGE_BLOCKS,
  resolveStorageMembership,
  toggleStorage,
  toggleTerminal,
} from "./network";
import { locEquals } from "./state";
import { getDrain, removeSettingsEntity as removeStorageSettingsEntity, setDrain } from "./storageSettings";
import { isTerminalLikeBlock } from "./terminalBlock";
import { getToolMode } from "./toolMode";
import { showToolModeUi } from "./toolModeUi";
import { endEditingSession, getEditingNetworkId, isAnyoneEditingNetwork, setEditingNetworkId } from "./editingSession";
import { syncRangeIndicator } from "./rangeIndicator";

const HIGHLIGHT_INTERVAL = 10;

// onUse は「ブロックに対して使った場合」も(onUseOnとは別に)発火してしまうため、
// 視線の先にブロックが無い(=本当に空中で使った)場合だけモードメニューを開く。
// 実際のブロック操作の到達距離とは厳密には一致しなくてよく、あくまで
// 「ブロックを操作したその右クリックでメニューが誤って開かない」ことが目的の判定。
const AIR_USE_RAYCAST_DISTANCE = 8;

export const wrenchItemComponent: ItemCustomComponent = {
  // 空中(ブロックを対象としない)で使った時: モード選択メニューを開く。
  onUse(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;
    const hit = player.getBlockFromViewDirection({ maxDistance: AIR_USE_RAYCAST_DISTANCE });
    if (hit) return; // ブロックに対する使用(onUseOnが別途処理する)。メニューは開かない。
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
  const modeHint =
    getToolMode(player) === "drain"
      ? "ストレージをShiftキーを押しながら右クリックしてDrain指定を切り替えてください。"
      : "ストレージ/ターミナルをShiftキーを押しながら右クリックして接続/切断してください。";
  player.sendMessage(`§bネットワーク編集を開始しました。${modeHint}再度コントローラをShiftキーを押しながら右クリックすると終了します。`);
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
      if (network && !isWithinNetworkRange(network, block.location)) {
        player.sendMessage(
          `§cコントローラから各方向に${NETWORK_RANGE_BLOCKS}マスを超えているため接続できません。`
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
    player.sendMessage(result === "connected" ? "§bターミナルを接続しました。" : "§eターミナルを切断しました。");
    return;
  }

  if (block.getComponent("inventory")?.container) {
    const network = getNetwork(editingNetworkId);
    const alreadyConnected = network?.storages.some((s) => locEquals(s, block.location));
    if (network && !alreadyConnected) {
      // 新規接続(切断は範囲外でも常に許可する。ターミナル側と同じ理由)。
      if (!isWithinNetworkRange(network, block.location)) {
        player.sendMessage(
          `§cコントローラから各方向に${NETWORK_RANGE_BLOCKS}マスを超えているため接続できません。`
        );
        return;
      }

      const paired = findAdjacentConnectedStorage(dimension, network, block.location);
      if (paired) {
        player.sendMessage(
          "§c隣接するチェストと中身を共有しているため、既にネットワークに含まれています(二重登録を防止しました)。"
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

  player.sendMessage(
    newValue
      ? "§eこのストレージをDrain指定にしました(新規の預け入れ先から除外し、倉庫の整理でできるだけ空にします)。"
      : "§bこのストレージのDrain指定を解除しました。"
  );
}

function spawnHighlightParticle(dimension: Dimension, particleId: string, p: Vector3): void {
  try {
    dimension.spawnParticle(particleId, { x: p.x + 0.5, y: p.y + 1.2, z: p.z + 0.5 });
  } catch {
    // チャンク未読み込み等は無視
  }
}

// 編集中のプレイヤーに、現在のモードに応じた強調表示を行う。
// 構築モード: 接続済みの全メンバー(緑系パーティクル)。
// Drainモード: Drain指定済みのストレージのみ(赤系パーティクル、区別のため)。
// どちらも「編集中のネットワーク」に絞る(モードが違っても同じ土台を使う一貫性のため)。
function highlightEditingNetwork(player: Player): void {
  const networkId = getEditingNetworkId(player);
  if (networkId === undefined) return;

  const network = getAllNetworks().find((n) => n.id === networkId);
  if (!network) return;

  const dimension = world.getDimension(network.dimensionId);

  if (getToolMode(player) === "drain") {
    // Drain指定済み(赤系)だけでなく、Drain指定できる対象=接続済みの全ストレージ(緑系)も
    // 見えるようにする(どれがまだ操作対象になるのか分からない、というフィードバック不足の解消)。
    // コントローラ自身も、構築モードと同じく常に位置が分かるようにしておく。
    spawnHighlightParticle(dimension, "minecraft:villager_happy", network.controller);
    for (const loc of network.storages) {
      const particleId = getDrain(dimension, loc) ? "minecraft:villager_angry" : "minecraft:villager_happy";
      spawnHighlightParticle(dimension, particleId, loc);
    }
    return;
  }

  const points = [network.controller, ...network.storages, ...network.terminals];
  for (const p of points) spawnHighlightParticle(dimension, "minecraft:villager_happy", p);
}

// 接続範囲インジケータの表示状態を全ネットワーク分まとめて再計算する(rangeIndicator.tsの
// syncRangeIndicator参照)。プレイヤーの参加/離脱・編集開始/終了のたびに個別に呼ぶだけでは、
// ログアウトのタイミング次第で後片付けが漏れることがある(playerLeaveの後片付けを参照)ため、
// この定期実行を「必ず正しい状態に収束させる」ための保険として毎tickループに乗せている。
function reconcileAllRangeIndicators(): void {
  for (const network of getAllNetworks()) {
    const dimension = world.getDimension(network.dimensionId);
    syncRangeIndicator(dimension, network, isAnyoneEditingNetwork(network.id));
  }
}

export function startWrenchHighlightLoop(): void {
  system.runInterval(() => {
    for (const player of world.getPlayers()) {
      highlightEditingNetwork(player);
    }
    reconcileAllRangeIndicators();
  }, HIGHLIGHT_INTERVAL);
}

// 編集セッション中(wh:editing_networkを持つ)にプレイヤーがログアウトすると、
// 明示的な終了操作(コントローラのShift+右クリック/レンチメニューの終了ボタン)を
// 経ないまま抜けてしまう。beforeEvents.playerLeaveはプレイヤーがまだ存在する時点で
// 発火するため、ここでendEditingSessionを呼んで即座に後片付けを試みる。
// (実機で発見された不具合の修正): シングルプレイでワールドを終了する場合など、
// このイベント内の処理が完了する前にワールド自体が終了してしまい、後片付けが
// 反映されないことがあった。そのため、これは「できれば即座に」という best-effort の
// 位置づけにとどめ、確実な後片付けはstartWrenchHighlightLoopの定期的な
// reconcileAllRangeIndicators側に委ねている(isAnyoneEditingNetworkはオンライン中の
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
