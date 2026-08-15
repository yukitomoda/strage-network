import { world } from "@minecraft/server";
import { findMembership, removeStorage } from "./network";

// ストレージはバニラのコンテナブロックをそのまま使うため、terminal/controllerのように
// 専用のカスタムコンポーネントで破壊を検知できない。そのためワールド全体の
// playerBreakBlock を監視し、ネットワークに登録済みのストレージ位置と一致したら
// エントリを除去する。
export function registerStorageBreakWatcher(): void {
  world.afterEvents.playerBreakBlock.subscribe((event) => {
    const membership = findMembership(event.dimension.id, event.block.location);
    if (membership?.role === "storage") {
      removeStorage(membership.network.id, event.block.location);
    }
  });
}
