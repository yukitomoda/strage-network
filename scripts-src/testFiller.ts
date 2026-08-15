import { ItemCustomComponent, ItemStack, Player } from "@minecraft/server";

// テスト用: 大規模なネットワークでの動作/負荷を試すために、コンテナをランダムな
// アイテムで満たすツール。作り込みは不要なので、maxStackSize=64で揃う素材だけを
// プールにして「サイズオーバーで例外」等を気にしなくていいようにしている。
const RANDOM_ITEM_POOL = [
  "minecraft:cobblestone",
  "minecraft:oak_log",
  "minecraft:iron_ingot",
  "minecraft:diamond",
  "minecraft:dirt",
  "minecraft:stone",
  "minecraft:glass",
  "minecraft:wheat",
  "minecraft:redstone",
  "minecraft:gold_ingot",
  "minecraft:emerald",
  "minecraft:coal",
  "minecraft:sand",
  "minecraft:gravel",
  "minecraft:oak_planks",
  "minecraft:stick",
  "minecraft:string",
  "minecraft:feather",
  "minecraft:bone",
  "minecraft:leather",
];

export const testFillerItemComponent: ItemCustomComponent = {
  onUseOn(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;

    const container = event.block.getComponent("inventory")?.container;
    if (!container) {
      player.sendMessage("§cコンテナを持つブロックではありません。");
      return;
    }

    let filled = 0;
    for (let i = 0; i < container.size; i++) {
      if (container.getItem(i)) continue;
      const typeId = RANDOM_ITEM_POOL[Math.floor(Math.random() * RANDOM_ITEM_POOL.length)];
      const amount = 1 + Math.floor(Math.random() * 64);
      container.setItem(i, new ItemStack(typeId, amount));
      filled++;
    }
    player.sendMessage(`§b${filled}スロットをランダムなアイテムで埋めました。`);
  },
};
