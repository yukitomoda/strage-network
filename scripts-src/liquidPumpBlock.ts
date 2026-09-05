import { BlockCustomComponent } from "@minecraft/server";
import { LIQUID_PUMP_BLOCK_ID, teardownTerminal } from "./terminalBlock";

export const LIQUID_PUMP_COMPONENT_ID = LIQUID_PUMP_BLOCK_ID;

// 吸い込みパッドと同様、設定を持たず設置するだけで動作する(ユーザー要望)ため、onPlace/
// onPlayerInteractは無い。対象の液体はliquidPumpCheck.tsが毎サイクル自動で判定する。
export const liquidPumpBlockComponent: BlockCustomComponent = {
  onPlayerBreak(event) {
    teardownTerminal(event.dimension, event.block.location);
  },
};
