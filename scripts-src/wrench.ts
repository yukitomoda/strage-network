import { Block, Dimension, ItemCustomComponent, Player, system, Vector3, world } from "@minecraft/server";
import {
  findAdjacentConnectedStorage,
  findNetworkByController,
  findPhysicalStoragePair,
  getAllNetworks,
  getNetwork,
  resolveStorageMembership,
  toggleStorage,
  toggleTerminal,
} from "./network";
import { locEquals } from "./state";
import { getDrain, removeSettingsEntity as removeStorageSettingsEntity, setDrain } from "./storageSettings";
import { isTerminalLikeBlock } from "./terminalBlock";
import { getToolMode } from "./toolMode";
import { showToolModeUi } from "./toolModeUi";

const EDITING_NETWORK_PROPERTY = "wh:editing_network";
const HIGHLIGHT_INTERVAL = 10;

// onUse は「ブロックに対して使った場合」も(onUseOnとは別に)発火してしまうため、
// 視線の先にブロックが無い(=本当に空中で使った)場合だけモードメニューを開く。
// 実際のブロック操作の到達距離とは厳密には一致しなくてよく、あくまで
// 「ブロックを操作したその右クリックでメニューが誤って開かない」ことが目的の判定。
const AIR_USE_RAYCAST_DISTANCE = 8;

function getEditingNetworkId(player: Player): string | undefined {
  const value = player.getDynamicProperty(EDITING_NETWORK_PROPERTY);
  return typeof value === "string" ? value : undefined;
}

function setEditingNetworkId(player: Player, networkId: string | undefined): void {
  player.setDynamicProperty(EDITING_NETWORK_PROPERTY, networkId);
}

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
    setEditingNetworkId(player, undefined);
    player.sendMessage("§eネットワーク編集を終了しました。");
    return;
  }

  setEditingNetworkId(player, network.id);
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
    const result = toggleTerminal(editingNetworkId, block.location);
    player.sendMessage(result === "connected" ? "§bターミナルを接続しました。" : "§eターミナルを切断しました。");
    return;
  }

  if (block.getComponent("inventory")?.container) {
    const network = getNetwork(editingNetworkId);
    const alreadyConnected = network?.storages.some((s) => locEquals(s, block.location));
    if (network && !alreadyConnected) {
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

export function startWrenchHighlightLoop(): void {
  system.runInterval(() => {
    for (const player of world.getPlayers()) {
      highlightEditingNetwork(player);
    }
  }, HIGHLIGHT_INTERVAL);
}
