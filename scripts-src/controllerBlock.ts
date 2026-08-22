import { BlockCustomComponent, world } from "@minecraft/server";
import { CONTROLLER_AXES, CONTROLLER_BLOCK_ID } from "./controllerAxes";
import { removeSettingsEntity } from "./controllerSettings";
import { showControllerUi } from "./controllerUi";
import { endEditingSession, getEditingNetworkId } from "./editingSession";
import { createNetwork, destroyNetwork, findNetworkByController } from "./network";
import { resetObserverSignal } from "./networkObserverProcessing";
import { getAxisTierFromPermutation, giveOrDropKits } from "./upgrade";

export const CONTROLLER_COMPONENT_ID = "wh:controller";

export const controllerBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    createNetwork(dimension.id, { x: block.location.x, y: block.location.y, z: block.location.z });
  },
  onPlayerBreak(event) {
    const { block, dimension, player } = event;

    // 破壊するとTier(積み上げた状態)自体は失われるが、消費した素材は無駄にならないよう
    // 軸ごとにキットを返す(プレイヤーのインベントリへ、入りきらなければ足元へ)。
    // ネットワークの有無に関わらず必ず行う。
    for (const axis of CONTROLLER_AXES) {
      const tier = getAxisTierFromPermutation(event.brokenBlockPermutation, axis);
      giveOrDropKits(dimension, block.location, axis, tier, player);
    }

    const network = findNetworkByController(dimension.id, block.location);
    if (!network) return;

    // 解体前に、このネットワークを編集中のプレイヤーがいれば編集セッションを終了させる
    // (endEditingSessionが範囲表示インジケータの後片付けも行う)。解体後だとgetAllNetworks()
    // から消えてしまい、定期ループ(wrench.tsのreconcileAllRangeIndicators)ではこのネットワークを
    // 見つけられなくなるため、インジケータが永久に残ってしまう(実機で発見・修正)。編集中の
    // プレイヤー自身が壊した場合も、他プレイヤーが編集中に誰かが壊した場合も同じ経路でカバーする。
    for (const p of world.getPlayers()) {
      if (getEditingNetworkId(p) === network.id) endEditingSession(p);
    }

    // 解体後はnetwork.observersごと消えてrecalculateNetworkObserversの対象から外れるため、
    // 先にオブザーバーの信号だけ0に戻しておく(wrench.tsの手動切断と同じ理由、docs/design.md参照)。
    for (const loc of network.observers) {
      resetObserverSignal(dimension, loc);
    }

    destroyNetwork(network.id);
    removeSettingsEntity(dimension, block.location);
    player?.sendMessage("§e倉庫ネットワークを解体しました。");
  },
  onPlayerInteract(event) {
    // レンチでの右クリック(構築モードの開始/終了)は wrench.ts 側の ItemCustomComponent.onUseOn
    // が別途処理する。ここは素手等でのUI呼び出しのみを担当する。
    const player = event.player;
    if (!player) return;
    showControllerUi(player, event.block);
  },
};
