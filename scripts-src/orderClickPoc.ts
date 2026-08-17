import { Container, Entity, ItemCustomComponent, ItemStack, Player, system, world } from "@minecraft/server";

// PoC: chest_screen上書きの独自グリッド上で、アイテムをクリックしたときに「取り出す」のではなく
// 「注文数を+1する」といった任意の処理を実行できるかを検証する。
// 実在コンテナである以上、クリックは通常のインベントリ操作(プレイヤー手持ちへの移動)として
// 処理されてしまうため、それを検知して即座に取り消し、代わりにサーバー側の状態を更新して
// 表示に反映する、という方式が成立するかを試す。
// 既存のchestScreenPoc.ts(wh:test_chest_screen_container / chest_screen.json上書き)をそのまま流用する。
const CONTAINER_ENTITY_TYPE = "wh:test_chest_screen_container";
const CONTAINER_NAME_KEY = "entity.wh:test_chest_screen_container.name";

// ItemStack.setDynamicPropertyは非スタック可能アイテム専用(スタック可能だと例外になる)なため、
// Digital Storageと同じく、lore欄に隠しトークンを埋め込んで商品を判別する方式を採る。
const LORE_MARKER_PREFIX = "wh:test_order_product:";

// 対応表無しで正しいアイコンを出すため、実物の商品アイテムは「表示専用」のスロットに
// そのまま置く(ネイティブレンダラがそのまま正しく描画する)。実際にクリックを検知するのは
// 別途用意した「透明ダミーアイテム」のスロットで、画面上は表示専用スロットの真上に重ねて
// 配置する(RP/ui/wh_test_terminal.json参照)。これにより実物は一切動かない。
const BLANK_ITEM_TYPE = "wh:test_order_blank";

// `playerInventoryItemChange`イベントでの検知・即時取り消しを試したが、実機ではコンテナ画面
// 経由のクリックに対して反応せず(=単なる通常アイテムとして手持ちに残ってしまった)。
// そのため、イベント頼みをやめて「コンテナの中身を定期的にポーリングし、商品が消えていたら
// クリックされたとみなす」方式に切り替える。取得済みの実アイテムは、毎回プレイヤーの
// インベントリ全体からマーカー付きアイテムを掃除することで回収する。
const POLL_INTERVAL_TICKS = 1;

interface ProductDef {
  id: string;
  baseType: string;
  label: string;
}

const PRODUCTS: ProductDef[] = [
  { id: "cobblestone", baseType: "minecraft:cobblestone", label: "丸石" },
  { id: "diamond", baseType: "minecraft:diamond", label: "ダイヤモンド" },
  { id: "oak_log", baseType: "minecraft:oak_log", label: "オークの原木" },
  { id: "iron_ingot", baseType: "minecraft:iron_ingot", label: "鉄インゴット" },
  { id: "gold_ingot", baseType: "minecraft:gold_ingot", label: "金インゴット" },
];

// コンテナの前半(0〜PRODUCTS.length-1)を表示専用の実物、後半をクリック検知用の透明
// ダミーに使う。画面上は同じ位置に重ねて配置する(RP/ui/wh_test_terminal.json参照)。
const TRIGGER_SLOT_OFFSET = PRODUCTS.length;

// 「1.41K」のような任意文字列の個数表示用スロット(表示・検知の次に確保する)。
// バニラのスタック数表示(整数・最大64)では実現できないため、Digital Storageと同じく
// 「名前を空白にしたダミーアイテムのlore」に任意の文字列を書き込み、それをJSON UI側の
// ラベルコントロールが#hover_text(コレクションバインディング)経由で読んで表示する方式にする
// (Machinery/interface/terminal.jsのsetCountLabel/writeCountColumns参照)。
const COUNT_LABEL_SLOT_OFFSET = TRIGGER_SLOT_OFFSET * 2;

// トグルボタン用(表示・検知の2スロット1組)。ON/OFFはアイコン自体を実在の2種類の
// アイテム(染料)で切り替える(対応表を使わずに済ませる、という方針をここでも踏襲)。
const TOGGLE_DISPLAY_SLOT = COUNT_LABEL_SLOT_OFFSET + PRODUCTS.length;
const TOGGLE_TRIGGER_SLOT = TOGGLE_DISPLAY_SLOT + 1;
const TOGGLE_LORE_MARKER = "wh:test_toggle_marker";
let toggleState = false;

// ロータリースイッチ用(表示・検知の2スロット1組)。クリックのたびに次の状態へ進む
// (末尾まで行ったら先頭に戻る)。トグルの多状態版で、仕組みはほぼ同じ。
const ROTARY_DISPLAY_SLOT = TOGGLE_TRIGGER_SLOT + 1;
const ROTARY_TRIGGER_SLOT = ROTARY_DISPLAY_SLOT + 1;
const ROTARY_LORE_MARKER = "wh:test_rotary_marker";
interface RotaryOption {
  baseType: string;
  label: string;
}
const ROTARY_OPTIONS: RotaryOption[] = [
  { baseType: "minecraft:white_wool", label: "低" },
  { baseType: "minecraft:yellow_wool", label: "中" },
  { baseType: "minecraft:orange_wool", label: "高" },
  { baseType: "minecraft:red_wool", label: "最大" },
];
let rotaryIndex = 0;

// BP/entities/test_chest_screen_container.jsonのinventory_sizeと合わせる。
// Digital Storage側もこの手法(固定サイズのグリッドを持ち、実データが無い枠は専用の
// 「フィラー」アイテムで埋める)を使っていた(Machinery/interface/terminal.jsのrenderPage参照)。
// これをしないと、プレイヤー側インベントリでのShift+クリックが「空いている(何も無い)
// 隠しスロット」に自動移動してしまい、アイテムが消えたように見える不具合があった。
const CONTAINER_INVENTORY_SIZE = 40;

// 商品IDごとの「クリックして増やした注文数」。本来はプレイヤー×ネットワークの注文キューに
// 相当するが、このPoCではポーリング方式のためプレイヤーを区別せずグローバルなMapで代用する。
const orderCounts = new Map<string, number>();

// 「1.41K」のような表記を試すため、初回だけ桁数の異なるダミー値を入れておく。
const DEMO_SEED_COUNTS: Record<string, number> = {
  cobblestone: 64,
  diamond: 1410,
  oak_log: 2,
  iron_ingot: 192,
  gold_ingot: 50000,
};

// 左クリック(drop_one)だけ「一部が減る」変化になるよう、あえて2個スタックにしておく。
// 右クリック・Shift+クリックはどちらもdrop_all(全部無くなる)に割り当てているため区別しない。
// インベントリへ移動する系のアクション(container_auto_place等)は、手持ちが満杯だと
// 動作しなくなるため使わない方針にした。
const INITIAL_STACK_SIZE = 2;

function buildProductItem(product: ProductDef): ItemStack {
  const count = orderCounts.get(product.id) ?? 0;
  const item = new ItemStack(BLANK_ITEM_TYPE, INITIAL_STACK_SIZE);
  item.nameTag = `§b${product.label} §7(注文数: ${count})`;
  item.setLore([
    "§7左クリック:+1 / 右クリック:+5",
    `${LORE_MARKER_PREFIX}${product.id}`,
  ]);
  return item;
}

// 表示専用スロット用。実物そのものなので、対応表無しでネイティブレンダラが正しく描画する。
function buildDisplayItem(product: ProductDef): ItemStack {
  const count = orderCounts.get(product.id) ?? 0;
  const item = new ItemStack(product.baseType, 1);
  item.nameTag = `§b${product.label} §7(注文数: ${count})`;
  return item;
}

function extractProductId(item: ItemStack | undefined): string | undefined {
  if (!item) return undefined;
  const marker = item.getLore().find((line) => line.startsWith(LORE_MARKER_PREFIX));
  return marker?.slice(LORE_MARKER_PREFIX.length);
}

// 表示にもクリック検知にも使わない残りのスロットを埋めるフィラー。満杯スタックの独自
// アイテムにしておくことで、他のアイテムが自動移動(Shift+クリック等)で入り込めなくする。
function buildFillerItem(): ItemStack {
  return new ItemStack(BLANK_ITEM_TYPE, 64);
}

// Digital Storage(formatCount)と同じ考え方の桁数圧縮表記。
function formatCount(value: number): string {
  const count = Math.floor(value);
  if (count < 1000) return String(count);

  const units = ["K", "M", "B", "T"];
  let scaled = count;
  let unit = "";
  for (const nextUnit of units) {
    if (scaled < 1000) break;
    scaled /= 1000;
    unit = nextUnit;
  }

  const text = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
  return `${text.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")}${unit}`;
}

// カウント表示専用スロット用。名前を空白にし、loreに表示したい文字列をそのまま書き込む。
// JSON UI側はこのlore(#hover_text)をラベルとして表示するだけで、数値ではなく任意の
// 文字列を扱える(バニラのスタック数表示は整数・最大64までしか出せないため)。
function buildCountLabelItem(product: ProductDef): ItemStack {
  const count = orderCounts.get(product.id) ?? 0;
  const item = new ItemStack(BLANK_ITEM_TYPE, 1);
  item.nameTag = " ";
  item.setLore([`§r§f${formatCount(count)}`]);
  return item;
}

// トグルの表示専用アイテム。ON/OFFを、実在の2種類のアイテム(染料)を切り替えることで表現する
// (対応表を使わずアイコンを変える、という考え方は商品表示と同じ)。
function buildToggleDisplayItem(): ItemStack {
  const item = new ItemStack(toggleState ? "minecraft:lime_dye" : "minecraft:red_dye", 1);
  item.nameTag = toggleState ? "§aトグル: ON" : "§cトグル: OFF";
  return item;
}

// トグルのクリック検知用ダミーアイテム。商品と違って中間状態が要らないので、1個だけの
// スタックにする(2個にしていると、左クリック1回では1個しか減らず「変化なし」と判定されて
// しまい、2回クリックしないと切り替わらない不具合になっていた)。
function buildToggleTriggerItem(): ItemStack {
  const item = new ItemStack(BLANK_ITEM_TYPE, 1);
  item.nameTag = toggleState ? "§aトグル: ON" : "§cトグル: OFF";
  item.setLore(["§7クリックでON/OFFを切り替え", TOGGLE_LORE_MARKER]);
  return item;
}

// ロータリーの表示専用アイテム。現在の状態を、実在アイテム(色付きウール)で表現する。
function buildRotaryDisplayItem(): ItemStack {
  const option = ROTARY_OPTIONS[rotaryIndex];
  const item = new ItemStack(option.baseType, 1);
  item.nameTag = `§eロータリー: ${option.label}`;
  return item;
}

// ロータリーのクリック検知用ダミーアイテム。トグルと同じく1個スタック(中間状態不要)。
function buildRotaryTriggerItem(): ItemStack {
  const option = ROTARY_OPTIONS[rotaryIndex];
  const item = new ItemStack(BLANK_ITEM_TYPE, 1);
  item.nameTag = `§eロータリー: ${option.label}`;
  item.setLore(["§7クリックで次の状態へ", ROTARY_LORE_MARKER]);
  return item;
}

function initializeContainer(container: Container): void {
  if (orderCounts.size === 0) {
    PRODUCTS.forEach((product) => orderCounts.set(product.id, DEMO_SEED_COUNTS[product.id] ?? 0));
  }

  PRODUCTS.forEach((product, i) => {
    container.setItem(i, buildDisplayItem(product));
    container.setItem(TRIGGER_SLOT_OFFSET + i, buildProductItem(product));
    container.setItem(COUNT_LABEL_SLOT_OFFSET + i, buildCountLabelItem(product));
  });

  container.setItem(TOGGLE_DISPLAY_SLOT, buildToggleDisplayItem());
  container.setItem(TOGGLE_TRIGGER_SLOT, buildToggleTriggerItem());

  container.setItem(ROTARY_DISPLAY_SLOT, buildRotaryDisplayItem());
  container.setItem(ROTARY_TRIGGER_SLOT, buildRotaryTriggerItem());

  for (let slot = ROTARY_TRIGGER_SLOT + 1; slot < CONTAINER_INVENTORY_SIZE; slot++) {
    container.setItem(slot, buildFillerItem());
  }
}

// ポーリング対象のコンテナは、スポーン時にentity idを覚えておくのではなく毎回ワールドから
// 探し直す(自己修復パターン、rangeIndicator.ts等と同じ考え方)。前者の方式では、ワールド
// 退出→再入場でスクリプトが再起動されるとリストが空に戻ってしまい、退出前からあった
// コンテナがポーリング対象から外れてしまう(実機で発見・修正済み)。
const ORDER_CONTAINER_SEARCH_DIMENSIONS = ["overworld", "nether", "the_end"];

function findAllOrderContainers(): Entity[] {
  const found: Entity[] = [];
  for (const dimensionId of ORDER_CONTAINER_SEARCH_DIMENSIONS) {
    const dimension = world.getDimension(dimensionId);
    found.push(...dimension.getEntities({ type: CONTAINER_ENTITY_TYPE }));
  }
  return found;
}

// UIを閉じたら注文数を0に戻す(今回作りたいのは「開くたびに0から数え直す」注文数であり、
// 累積するカウンタではないため)。
world.afterEvents.entityContainerClosed.subscribe((event) => {
  const entity = event.entity;
  if (entity.typeId !== CONTAINER_ENTITY_TYPE) return;

  orderCounts.clear();

  const container = entity.getComponent("inventory")?.container;
  if (!container) return;
  initializeContainer(container);
});

export const testOrderClickItemComponent: ItemCustomComponent = {
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

    initializeContainer(container);

    player.sendMessage("§b注文テスト用コンテナをスポーンしました。アイテムをクリックして注文数を増やしてみてください。");
  },
};

interface GoneSlot {
  entityId: string;
  slot: number;
  product: ProductDef;
  remainingAmount: number;
}

function isToggleTriggerItem(item: ItemStack | undefined): boolean {
  return item?.getLore().includes(TOGGLE_LORE_MARKER) ?? false;
}

function isRotaryTriggerItem(item: ItemStack | undefined): boolean {
  return item?.getLore().includes(ROTARY_LORE_MARKER) ?? false;
}

function pollOrderContainers(): void {
  const goneSlots: GoneSlot[] = [];
  const toggledEntityIds: string[] = [];
  const rotatedEntityIds: string[] = [];

  for (const entity of findAllOrderContainers()) {
    if (!entity.isValid) continue;
    const entityId = entity.id;

    const container = entity.getComponent("inventory")?.container;
    if (!container) continue;

    PRODUCTS.forEach((product, i) => {
      const slotItem = container.getItem(TRIGGER_SLOT_OFFSET + i);
      const stillHere = extractProductId(slotItem) === product.id;
      const remainingAmount = stillHere ? (slotItem?.amount ?? 0) : 0;
      if (stillHere && remainingAmount === INITIAL_STACK_SIZE) return; // 変化なし

      goneSlots.push({ entityId, slot: TRIGGER_SLOT_OFFSET + i, product, remainingAmount });
    });

    if (!isToggleTriggerItem(container.getItem(TOGGLE_TRIGGER_SLOT))) {
      toggledEntityIds.push(entityId);
    }
    if (!isRotaryTriggerItem(container.getItem(ROTARY_TRIGGER_SLOT))) {
      rotatedEntityIds.push(entityId);
    }
  }

  if (goneSlots.length === 0 && toggledEntityIds.length === 0 && rotatedEntityIds.length === 0) return;

  // drop_one/drop_allはどちらも地面に実体としてドロップするだけなので、回収する。
  for (const player of world.getPlayers()) {
    const dropped = player.dimension.getEntities({ type: "minecraft:item", location: player.location, maxDistance: 16 });
    for (const itemEntity of dropped) {
      const stack = itemEntity.getComponent("item")?.itemStack;
      if (stack && (extractProductId(stack) !== undefined || isToggleTriggerItem(stack) || isRotaryTriggerItem(stack))) {
        itemEntity.remove();
      }
    }
  }

  for (const { entityId, slot, product, remainingAmount } of goneSlots) {
    const entity = world.getEntity(entityId);
    const container = entity?.getComponent("inventory")?.container;
    if (!container) continue;

    // 一部だけ減った = 左クリック(drop_one)、全部無くなった = 右クリック(drop_all)。
    const gesture = remainingAmount > 0 ? "left" : "right";
    const weight = gesture === "left" ? 1 : 5;

    orderCounts.set(product.id, (orderCounts.get(product.id) ?? 0) + weight);
    const displaySlot = slot - TRIGGER_SLOT_OFFSET;
    container.setItem(slot, buildProductItem(product));
    container.setItem(displaySlot, buildDisplayItem(product)); // 表示専用スロットの注文数も更新
    container.setItem(COUNT_LABEL_SLOT_OFFSET + displaySlot, buildCountLabelItem(product)); // 個数ラベルも更新

    for (const player of world.getPlayers()) {
      player.sendMessage(`§a${product.label}: ${gesture}クリックを検知(+${weight}, 注文数 ${orderCounts.get(product.id)})`);
    }
  }

  for (const entityId of toggledEntityIds) {
    const entity = world.getEntity(entityId);
    const container = entity?.getComponent("inventory")?.container;
    if (!container) continue;

    toggleState = !toggleState;
    container.setItem(TOGGLE_TRIGGER_SLOT, buildToggleTriggerItem());
    container.setItem(TOGGLE_DISPLAY_SLOT, buildToggleDisplayItem());

    for (const player of world.getPlayers()) {
      player.sendMessage(`§aトグルを検知: ${toggleState ? "ON" : "OFF"}`);
    }
  }

  for (const entityId of rotatedEntityIds) {
    const entity = world.getEntity(entityId);
    const container = entity?.getComponent("inventory")?.container;
    if (!container) continue;

    rotaryIndex = (rotaryIndex + 1) % ROTARY_OPTIONS.length;
    container.setItem(ROTARY_TRIGGER_SLOT, buildRotaryTriggerItem());
    container.setItem(ROTARY_DISPLAY_SLOT, buildRotaryDisplayItem());

    for (const player of world.getPlayers()) {
      player.sendMessage(`§eロータリーを検知: ${ROTARY_OPTIONS[rotaryIndex].label}`);
    }
  }
}

export function startOrderClickPocLoop(): void {
  system.runInterval(pollOrderContainers, POLL_INTERVAL_TICKS);
}
