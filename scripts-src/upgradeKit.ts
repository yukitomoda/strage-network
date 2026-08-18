import { EquipmentSlot, ItemCustomComponent, Player } from "@minecraft/server";
import { CONTROLLER_AXES } from "./controllerAxes";
import { getAxisTier, setAxisTier, UpgradeAxis } from "./upgrade";

// 将来、他のブロックにもアップグレード軸が増えたらここに ...OTHER_AXES を足して合成する。
// このファイル自体は軸の中身を知らないので変更不要。
const ALL_AXES: UpgradeAxis[] = [...CONTROLLER_AXES];

const STEP_BY_ITEM = new Map<string, { axis: UpgradeAxis; fromTier: number; toTier: number }>();
for (const axis of ALL_AXES) {
  axis.kitItemIds.forEach((kitId, index) => {
    STEP_BY_ITEM.set(kitId, { axis, fromTier: index, toTier: index + 1 });
  });
}

export const upgradeKitItemComponent: ItemCustomComponent = {
  onUseOn(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;

    const step = STEP_BY_ITEM.get(event.itemStack.typeId);
    if (!step) return;

    const block = event.block;
    if (block.typeId !== step.axis.blockTypeId) {
      player.sendMessage("§cこのアイテムはこのブロックには使用できません。");
      return;
    }

    const currentTier = getAxisTier(block.dimension, block.location, step.axis);
    if (currentTier !== step.fromTier) {
      player.sendMessage(
        currentTier > step.fromTier
          ? `§eこのブロックは既に${step.axis.label}のこのキットの対象Tierを超えています。`
          : `§cこのキットは${step.axis.label}Tier${step.fromTier}のブロックにのみ使用できます(現在Tier${currentTier})。`
      );
      return;
    }

    setAxisTier(block, step.axis, step.toTier);
    consumeOneFromMainHand(player);
    player.sendMessage(`§b${step.axis.label}をTier${step.toTier}にアップグレードしました。`);
  },
};

function consumeOneFromMainHand(player: Player): void {
  const equippable = player.getComponent("equippable");
  const held = equippable?.getEquipment(EquipmentSlot.Mainhand);
  if (!equippable || !held) return;
  if (held.amount > 1) {
    const remaining = held.clone();
    remaining.amount -= 1;
    equippable.setEquipment(EquipmentSlot.Mainhand, remaining);
  } else {
    equippable.setEquipment(EquipmentSlot.Mainhand, undefined);
  }
}
