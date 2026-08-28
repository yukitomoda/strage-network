import { BlockCustomComponent } from "@minecraft/server";
import { showIoPadUi } from "./ioPadUi";
import { generateIoPadName } from "./state";
import { ensureSettingsEntity, setTerminalName } from "./terminalSettings";
import { IO_PAD_BLOCK_ID, teardownTerminal } from "./terminalBlock";

export const IO_PAD_COMPONENT_ID = IO_PAD_BLOCK_ID;

// 他のターミナル系と同じく非表示エンティティ(terminalSettings.ts)で設定を持つ。搬入出パッドは
// 張り付いた先という概念が無く(プレイヤーがパッドに乗った時の所持数が対象。padCheck.ts参照)、
// getAttachedStorageLocationは使わない。
export const ioPadBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    ensureSettingsEntity(dimension, block.location);
    setTerminalName(dimension, block.location, generateIoPadName());
  },
  onPlayerBreak(event) {
    teardownTerminal(event.dimension, event.block.location);
  },
  onPlayerInteract(event) {
    const player = event.player;
    const block = event.block;
    if (!player) return;
    showIoPadUi(player, block);
  },
};
