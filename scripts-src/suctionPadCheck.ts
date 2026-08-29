import { Block, Dimension, Vector3 } from "@minecraft/server";
import { NetworkData } from "./state";
import { insertItemStackIntoStorages, StorageIndex } from "./storageScan";

// 吸い込みパッドの回収範囲(ユーザー要望)。ブロック上面の中央から見て、上方向に
// PICKUP_CENTER_HEIGHT_OFFSETだけ離れた点を中心とする半径PICKUP_RADIUSの球状範囲。
// 後で調整する可能性があるため定数にしている。
const PICKUP_CENTER_HEIGHT_OFFSET = 0.3;
const PICKUP_RADIUS = 1.5;

const ITEM_ENTITY_TYPE = "minecraft:item";

// 目標系ターミナルの「広告モデル」(25章)の一種だが、他の4種(自動端末・在庫管理ターミナル・
// 精密ターミナル・搬入出パッド)と違い目標設定を持たない。範囲内にあるアイテムエンティティを
// 無条件にすべて回収しようとするだけ(ホッパーのような動作、ユーザー要望)なので、
// terminalSettings.tsへの設定の読み書きは無い。搬出方向を持たない(常に預け入れ専用)ため、
// targetReconciliation.tsのreconcileAllTargetWithdrawals側には登録しない。
export function reconcileSuctionPadDeposit(
  network: NetworkData,
  dimension: Dimension,
  block: Block,
  budget: number,
  storageIndex: StorageIndex | undefined,
  depositTargets: Vector3[] | undefined
): number {
  if (budget <= 0) return 0;

  const loc = block.location;
  const center = { x: loc.x + 0.5, y: loc.y + 1 + PICKUP_CENTER_HEIGHT_OFFSET, z: loc.z + 0.5 };
  const items = dimension.getEntities({ type: ITEM_ENTITY_TYPE, location: center, maxDistance: PICKUP_RADIUS });

  let remaining = budget;
  let consumed = 0;
  for (const entity of items) {
    if (remaining <= 0) break;
    const itemComponent = entity.getComponent("minecraft:item");
    if (!itemComponent) continue;
    const stack = itemComponent.itemStack;

    const attempt = Math.min(stack.amount, remaining);
    const toInsert = stack.clone();
    toInsert.amount = attempt;
    const inserted = insertItemStackIntoStorages(dimension, network, toInsert, storageIndex, depositTargets);
    if (inserted <= 0) continue; // ネットワーク側が満杯。このエンティティはそのまま残す。

    // EntityItemComponent.itemStackは読み取り専用でスロットも持たないため、量を減らすには
    // エンティティを消してから残り分を同じ場所に再度落とすしかない(全量入った場合も
    // 一貫してこの経路にする)。dimension.spawnItemは通常のドロップと同じ「ふわっと跳ねる」
    // 初速を持たせて生成するため、そのままだと大量投入時に毎サイクル跳ね続けて見える
    // (実機で発見された不具合)。clearVelocity()で初速を即座に打ち消し、その場に留まるようにする。
    const entityLocation = entity.location;
    entity.remove();
    if (inserted < stack.amount) {
      const leftover = stack.clone();
      leftover.amount = stack.amount - inserted;
      dimension.spawnItem(leftover, entityLocation).clearVelocity();
    }

    remaining -= inserted;
    consumed += inserted;
  }

  return consumed;
}
