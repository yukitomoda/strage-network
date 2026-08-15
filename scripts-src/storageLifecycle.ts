import { world } from "@minecraft/server";
import { findMembership, removeStorage } from "./network";
import { removeSettingsEntity } from "./storageSettings";

// ストレージはバニラのコンテナブロックをそのまま使うため、terminal/controllerのように
// 専用のカスタムコンポーネントで破壊を検知できない。そのためワールド全体の
// playerBreakBlock を監視し、ネットワークに登録済みのストレージ位置と一致したら
// エントリを除去する。
//
// (実機で発見された不具合の修正済み) 設定エンティティの削除(removeSettingsEntity)は、
// membershipの解決に依存せず常に試みる。以前はmembership?.role === "storage"の中でのみ
// 呼んでいたため、次の2パターンで削除されずに残ってしまっていた:
//   1. コントローラを先に壊してネットワークデータごと解体した後、登録済みストレージを
//      壊した場合 -> findMembershipがネットワークを見つけられず、削除がスキップされる。
//   2. 二連チェストの「登録されていない方の半分」(Drain指定はされているが network.storages
//      には載っていない側)を壊した場合 -> findMembershipは元々このブロックをストレージだと
//      認識できないため、削除が一度もスキップされない。
// 残ったエンティティ(当たり判定を持つ)がその後ずっとブロックの再設置を妨げてしまっていた。
// removeSettingsEntityは対象が無ければ何もしない安全な操作なので、常に呼んでよい。
export function registerStorageBreakWatcher(): void {
  world.afterEvents.playerBreakBlock.subscribe((event) => {
    const membership = findMembership(event.dimension.id, event.block.location);
    if (membership?.role === "storage") {
      removeStorage(membership.network.id, event.block.location);
    }
    removeSettingsEntity(event.dimension, event.block.location);
  });
}
