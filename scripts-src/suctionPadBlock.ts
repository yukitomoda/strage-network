import { BlockCustomComponent } from "@minecraft/server";
import { SUCTION_PAD_BLOCK_ID, teardownTerminal } from "./terminalBlock";

export const SUCTION_PAD_COMPONENT_ID = SUCTION_PAD_BLOCK_ID;

// 吸い込みパッドは名前も個別設定も持たない(常に周囲のアイテムを無条件に回収するだけ、
// ユーザー要望)ため、他のターミナル系と違い設定用の非表示エンティティを作らない
// (teardownTerminalのremoveSettingsEntity呼び出しは、無くても無害なのでそのまま流用する)。
// UIも持たないため、ホッパーと同様に設置するだけで動作し、onPlace/onPlayerInteractは無い。
export const suctionPadBlockComponent: BlockCustomComponent = {
  onPlayerBreak(event) {
    teardownTerminal(event.dimension, event.block.location);
  },
};
