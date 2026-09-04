import { Dimension, EquipmentSlot, ItemCustomComponent, ItemStack, Player, Vector3, world } from "@minecraft/server";
import {
  CONTROLLER_REMOTE_ACCESS_AXIS,
  getRemoteAccessCrossDimensionForTier,
  getRemoteAccessRangeForTier,
} from "./controllerAxes";
import { getControllerName } from "./controllerSettings";
import { findNetworkByController, getNetwork, isWithinNetworkRange } from "./network";
import { NetworkData, generateRemoteDeliveryTerminalName } from "./state";
import { showRemoteDeliveryUi } from "./remoteDeliveryTerminalUi";
import { getAxisTier } from "./upgrade";

export const REMOTE_DELIVERY_TERMINAL_ITEM_ID = "wh:remote_delivery_terminal";

// このアドオンで初めて「アイテム自身に設定を持たせる」パターン(他のターミナルは全て
// terminalSettings.tsの、ブロック位置をキーにした非表示エンティティに設定を持たせているが、
// リモート配達ターミナルは対応する位置が無いため、ItemStack自身の動的プロパティに直接持たせる。
// docs/design.md参照)。
const LINKED_NETWORK_PROPERTY = "wh:linked_network";
const NOTIFY_ON_COMPLETE_PROPERTY = "wh:notify_on_complete";
const TERMINAL_NAME_PROPERTY = "wh:terminal_name";

// コントローラからの距離に応じて使用可否が変わる(ユーザー要望)。「リモート操作」アップグレード軸
// (controllerAxes.tsのCONTROLLER_REMOTE_ACCESS_AXIS)のTierから距離・別ディメンションからの
// 使用可否を引く(未装着=Tier0は32ブロック・同一ディメンションのみ固定)。onUse(リモート使用)・
// remoteDeliveryTerminalUi.tsの確定時の両方で使う共通チェック。Tierはコントローラ自身の
// ディメンション(player.dimensionではなくnetwork.dimensionId)から引く必要がある
// (T4装着時はプレイヤーが別ディメンションにいる状態で呼ばれうるため)。
export function checkRemoteDeliveryAccess(player: Player, network: NetworkData): string | undefined {
  const controllerDimension = world.getDimension(network.dimensionId);
  const tier = getAxisTier(controllerDimension, network.controller, CONTROLLER_REMOTE_ACCESS_AXIS);
  const sameDimension = player.dimension.id === network.dimensionId;

  if (!sameDimension) {
    if (!getRemoteAccessCrossDimensionForTier(tier)) {
      return "§cリンク先のコントローラとは別のディメンションにいるため使用できません。";
    }
    // 別ディメンションの場合、座標の比較自体が無意味なため距離チェックは行わない。
    return undefined;
  }

  const range = getRemoteAccessRangeForTier(tier);
  if (!isWithinNetworkRange(network, player.location, range)) {
    return `§cリンク先のコントローラから${range}マスを超えているため使用できません。`;
  }
  return undefined;
}

export function getLinkedNetworkId(item: ItemStack): string | undefined {
  const value = item.getDynamicProperty(LINKED_NETWORK_PROPERTY);
  return typeof value === "string" ? value : undefined;
}

export function getRemoteNotifyOnComplete(item: ItemStack): boolean {
  const value = item.getDynamicProperty(NOTIFY_ON_COMPLETE_PROPERTY);
  return typeof value === "boolean" ? value : true; // デフォルトtrue(他のターミナルと同じ)
}

export function getRemoteTerminalName(item: ItemStack): string | undefined {
  const value = item.getDynamicProperty(TERMINAL_NAME_PROPERTY);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// プレイヤーが今まさにメインハンドに持っているリモート配達ターミナルを取得する(設定変更・
// 注文送信のたびに都度取得し直す。UIを開いた時点のitemStackへの参照をtickをまたいで
// 保持しない方針。手放す/持ち替える等の想定外の状態変化を安全側で無視できる)。
export function getHeldRemoteDeliveryTerminal(player: Player): ItemStack | undefined {
  const item = player.getComponent("equippable")?.getEquipment(EquipmentSlot.Mainhand);
  return item?.typeId === REMOTE_DELIVERY_TERMINAL_ITEM_ID ? item : undefined;
}

// held itemを書き換えて手に持っているスロットへ書き戻す共通処理。ItemComponentUseEvent系の
// itemStackは読み取り専用のため、変更後は必ずこれで反映する必要がある。
function updateHeldItem(player: Player, mutate: (item: ItemStack) => void): void {
  const equippable = player.getComponent("equippable");
  const current = getHeldRemoteDeliveryTerminal(player);
  if (!equippable || !current) return;
  const updated = current.clone();
  mutate(updated);
  equippable.setEquipment(EquipmentSlot.Mainhand, updated);
}

export function linkToController(player: Player, dimension: Dimension, controllerLoc: Vector3): void {
  const network = findNetworkByController(dimension.id, controllerLoc);
  if (!network) {
    player.sendMessage("§cこのコントローラのネットワーク情報が見つかりません。");
    return;
  }
  updateHeldItem(player, (item) => {
    item.setDynamicProperty(LINKED_NETWORK_PROPERTY, network.id);
    // 名前は初回リンク時だけ自動採番する(再リンクで上書きしない。他のターミナルの
    // generateXName()はonPlace時の1回きりの初期化なので、それと同じ考え方)。
    if (!getRemoteTerminalName(item)) {
      item.setDynamicProperty(TERMINAL_NAME_PROPERTY, generateRemoteDeliveryTerminalName());
    }
  });
  const controllerName = getControllerName(dimension, controllerLoc);
  player.sendMessage(`§bこのアイテムを「${controllerName}」にリンクしました。`);
}

export function unlinkHeldItem(player: Player): void {
  updateHeldItem(player, (item) => {
    item.setDynamicProperty(LINKED_NETWORK_PROPERTY, undefined);
  });
}

export function setRemoteNotifyOnComplete(player: Player, value: boolean): void {
  updateHeldItem(player, (item) => item.setDynamicProperty(NOTIFY_ON_COMPLETE_PROPERTY, value));
}

export function setRemoteTerminalName(player: Player, name: string): void {
  updateHeldItem(player, (item) =>
    item.setDynamicProperty(TERMINAL_NAME_PROPERTY, name.length > 0 ? name : undefined)
  );
}

// wrench.tsのAIR_USE_RAYCAST_DISTANCEと同じ考え方: onUseは「ブロックに対して使った場合」も
// (onUseOnとは別に)発火してしまうため、視線の先にブロックが無い場合だけリモート使用として扱う。
const AIR_USE_RAYCAST_DISTANCE = 8;

export const remoteDeliveryTerminalItemComponent: ItemCustomComponent = {
  // コントローラに対して使った場合: リンクする。
  onUseOn(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;
    const block = event.block;
    if (block.typeId !== "wh:controller") return;
    linkToController(player, block.dimension, block.location);
  },
  // 空中で使った場合: リンク済み・範囲内ならリモートUIを開く。
  onUse(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;
    const hit = player.getBlockFromViewDirection({ maxDistance: AIR_USE_RAYCAST_DISTANCE });
    if (hit) return; // ブロックに対する使用はonUseOnが処理する

    const item = getHeldRemoteDeliveryTerminal(player);
    if (!item) return;

    const networkId = getLinkedNetworkId(item);
    if (!networkId) {
      player.sendMessage("§cまずこのアイテムを持ってコントローラを右クリックし、リンクしてください。");
      return;
    }
    const network = getNetwork(networkId);
    if (!network) {
      player.sendMessage("§cリンクされたネットワークが見つかりません(コントローラが解体された可能性があります)。");
      return;
    }
    const accessError = checkRemoteDeliveryAccess(player, network);
    if (accessError) {
      player.sendMessage(accessError);
      return;
    }
    showRemoteDeliveryUi(player, item, network);
  },
};
