import { BlockCustomComponent, Dimension, EnchantmentType, Entity, ItemCustomComponent, ItemStack, Player, Vector3 } from "@minecraft/server";

// PoC: 「chest_screen.json」をJSON UIで上書きし、本物のコンテナ(non-inventory)を土台に
// 独自パネル(検索欄やグリッドの自由なレイアウト)を差し込めるかを検証する。
// アイコン描画自体はcommon.container_item(バニラのネイティブレンダラ)に丸投げするため、
// 対応表を持たずに任意のアイテムを正しく描画できるはず、というのが確認したい点。
// 参考: tmp/UtilityCraft-Digital-Storage(オープンソース、docs/design.md参照)。
// ファイル自体はこのPoC用に新規に書いており、上記リポジトリのコードは1行もコピーしていない。
const CONTAINER_ENTITY_TYPE = "wh:test_chest_screen_container";
// $container_title(chest_screen.jsonのrequires判定に使う値)は、エンティティに名前が
// 無いと汎用の"entity.unknown.name"になってしまうことが実機で判明した(日本語訳が「不明」)。
// 参考アドオンはおそらくnameTagを翻訳キーの文字列そのものに設定して回避しており、
// ここでも同じ手法を試す(対応する言語エントリはRP/texts/*.lang参照)。
const CONTAINER_NAME_KEY = "entity.wh:test_chest_screen_container.name";

// 「任意のアイテムでも正しく描画できるか」を試すため、あえて色々な属性のアイテムを混ぜる。
function buildTestItems(): ItemStack[] {
  const plain = new ItemStack("minecraft:diamond", 42);

  const named = new ItemStack("minecraft:iron_sword", 1);
  named.nameTag = "§e伝説の剣";

  const enchanted = new ItemStack("minecraft:diamond_pickaxe", 1);
  enchanted.getComponent("enchantable")?.addEnchantment({ type: new EnchantmentType("efficiency"), level: 5 });

  const lored = new ItemStack("minecraft:written_book", 1);
  lored.setLore(["§7これはPoC用のダミーです。", "§7任意のNBTでも描画できるか確認する。"]);

  const bigStack = new ItemStack("minecraft:cobblestone", 64);

  return [plain, named, enchanted, lored, bigStack];
}

export const testChestScreenItemComponent: ItemCustomComponent = {
  onUse(event) {
    const player = event.source;
    if (!(player instanceof Player)) return;

    const viewDirection = player.getViewDirection();
    const spawnLoc = {
      x: player.location.x + viewDirection.x * 2,
      y: player.location.y + 1,
      z: player.location.z + viewDirection.z * 2,
    };

    const entity = player.dimension.spawnEntity(CONTAINER_ENTITY_TYPE, spawnLoc);
    entity.nameTag = CONTAINER_NAME_KEY;
    const container = entity.getComponent("inventory")?.container;
    if (!container) {
      player.sendMessage("§cコンテナコンポーネントの取得に失敗しました。");
      return;
    }

    const items = buildTestItems();
    items.forEach((item, i) => container.setItem(i, item));

    player.sendMessage("§bテスト用コンテナをスポーンしました。右クリックして開いてください。");
  },
};

// ブロック版PoC。ブロックはminecraft:inventoryを持てずコンテナ画面を強制的に開くAPIも無いため、
// 「ブロックと同じ座標にコンテナエンティティを重ねて置き、右クリックをエンティティ側に
// 拾わせる」という方針が成立するかを確認する。設定エンティティ(terminalSettings.ts)と
// 同じく、近傍探索+owner_loc完全一致で紐付けて取得する。
const BLOCK_OWNER_LOCATION_PROPERTY = "wh:test_owner_loc";

// 当たり判定をブロック面の中心付近だけに絞る(collision_box: width/height 0.6の立方体を
// ブロック中心に配置)。上下左右奥行きそれぞれ20%ずつ余白ができるため、縁を狙えば
// 通常のブロック設置ができ、中心付近を狙った右クリックだけがエンティティに命中する狙い。
function centerOf(loc: Vector3): Vector3 {
  return { x: loc.x + 0.5, y: loc.y + 0.2, z: loc.z + 0.5 };
}

function findContainerEntity(dimension: Dimension, blockLoc: Vector3): Entity | undefined {
  const candidates = dimension.getEntities({ type: CONTAINER_ENTITY_TYPE, location: centerOf(blockLoc), maxDistance: 2 });
  return candidates.find((entity) => {
    const raw = entity.getDynamicProperty(BLOCK_OWNER_LOCATION_PROPERTY);
    if (typeof raw !== "string") return false;
    try {
      const loc = JSON.parse(raw) as Vector3;
      return loc.x === blockLoc.x && loc.y === blockLoc.y && loc.z === blockLoc.z;
    } catch {
      return false;
    }
  });
}

export const testChestScreenBlockComponent: BlockCustomComponent = {
  onPlace(event) {
    const { block, dimension } = event;
    if (findContainerEntity(dimension, block.location)) return;

    const entity = dimension.spawnEntity(CONTAINER_ENTITY_TYPE, centerOf(block.location));
    entity.nameTag = CONTAINER_NAME_KEY;
    entity.setDynamicProperty(BLOCK_OWNER_LOCATION_PROPERTY, JSON.stringify(block.location));

    const container = entity.getComponent("inventory")?.container;
    const items = buildTestItems();
    items?.forEach((item, i) => container?.setItem(i, item));
  },
  onPlayerBreak(event) {
    findContainerEntity(event.dimension, event.block.location)?.remove();
  },
};
