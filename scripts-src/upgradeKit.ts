import { ItemCustomComponent, Player } from "@minecraft/server";
import { CONTROLLER_AXES } from "./controllerAxes";
import { getAxisTier, giveOrDropKits, setAxisTier, UpgradeAxis } from "./upgrade";

// 将来、他のブロックにもアップグレード軸が増えたらここに ...OTHER_AXES を足して合成する。
// このファイル自体は軸の中身を知らないので変更不要。
const ALL_AXES: UpgradeAxis[] = [...CONTROLLER_AXES];

// キットはどのTierのものでも直接使え(飛び級可)、装着するとそのキットのTierに一気に設定される。
// 軸ごとに同時に装着できるキットは1つだけだが、既に何か装着済みの状態で別のキットを使った場合は
// 「取り外してから装着し直す」のではなく、その場で置き換える(元のキットはプレイヤーへ返す。
// giveOrDropKitsを使うため、インベントリ優先・満杯なら足元へドロップという既存の返却挙動と
// 統一される)。この飛び級可の方式にしたのは、下から順番にしか使えない旧仕様だと、レシピ側で
// 上位キットが下位キットを消費する構成(design.md「グレード管理」参照)と組み合わせた時、
// ブロックに直接使う分とレシピ消費用の分とで下位キットを二重に用意する必要が生じてしまうため。
const TARGET_TIER_BY_ITEM = new Map<string, { axis: UpgradeAxis; targetTier: number }>();
for (const axis of ALL_AXES) {
  axis.kitItemIds.forEach((kitId, index) => {
    TARGET_TIER_BY_ITEM.set(kitId, { axis, targetTier: index + 1 });
  });
}

export const upgradeKitItemComponent: ItemCustomComponent = {
  onUseOn(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;

    const target = TARGET_TIER_BY_ITEM.get(event.itemStack.typeId);
    if (!target) return;

    const block = event.block;
    if (block.typeId !== target.axis.blockTypeId) {
      player.sendMessage("§cこのアイテムはこのブロックには使用できません。");
      return;
    }

    const currentTier = getAxisTier(block.dimension, block.location, target.axis);
    if (currentTier === target.targetTier) {
      player.sendMessage(`§e${target.axis.label}は既にTier${target.targetTier}です。`);
      return;
    }

    if (currentTier !== 0) {
      giveOrDropKits(block.dimension, block.location, target.axis, currentTier, player);
    }

    setAxisTier(block, target.axis, target.targetTier);
    consumeOneFromMainHand(player);
    player.sendMessage(
      currentTier !== 0
        ? `§b${target.axis.label}をTier${currentTier}からTier${target.targetTier}に付け替えました(元のキットは返却済みです)。`
        : `§b${target.axis.label}をTier${target.targetTier}にアップグレードしました。`
    );
  },
};

// giveOrDropKitsが使うplayer.getComponent("inventory")のコンテナAPIと、手持ち操作専用の
// equippable API(EquipmentSlot.Mainhand)を同じtick内で混在させて操作すると、実機で
// インベントリスロットの見た目が同期されない不具合があった(Shift+クリック等でようやく
// 反映される)。原因の切り分けのため、こちらもinventoryコンテナ経由(selectedSlotIndex)に
// 統一する。
function consumeOneFromMainHand(player: Player): void {
  const inventory = player.getComponent("inventory")?.container;
  const held = inventory?.getItem(player.selectedSlotIndex);
  if (!inventory || !held) return;
  if (held.amount > 1) {
    const remaining = held.clone();
    remaining.amount -= 1;
    inventory.setItem(player.selectedSlotIndex, remaining);
  } else {
    inventory.setItem(player.selectedSlotIndex, undefined);
  }
}
