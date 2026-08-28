import { RawMessage, world } from "@minecraft/server";
import { CONTROLLER_CYCLE_AXIS, CONTROLLER_RANGE_AXIS, CONTROLLER_SPEED_AXIS, getRangeForTier } from "./controllerAxes";
import { getDepositThroughput } from "./depositProcessing";
import { getCycleIntervalTicks } from "./networkProcessing";
import { getOrderThroughput } from "./orderProcessing";
import { getOrganizeThroughput } from "./organizeProcessing";
import { getAxisMaxTier } from "./upgrade";

// このアドオンの名前を表すlangキー。改名時はスクリプト側ではなくlangファイルの
// wh.addon_nameの値を直すだけでよい(ADDON_SIGNATURE_LINEを使う全アイテムの説明文に
// 自動反映される)。
const ADDON_NAME_TRANSLATE_KEY = "wh.addon_name";

// 「§9§oアドオン名」という署名行。RawMessageのrawtextで書式コード(text)とアドオン名
// (translate)をそのまま連結しているため、この行専用のlangキーは不要。
const ADDON_SIGNATURE_LINE: RawMessage = {
  rawtext: [{ text: "§9§o@" }, { translate: ADDON_NAME_TRANSLATE_KEY }],
};

const BLANK_LINE: RawMessage = { text: "" };

// 「値/cycle」形式のラベル。controllerUi.tsのperCycleLabel()と同じ考え方だが、UIモジュールに
// 依存させたくないのでここでも独立に持つ。
function perCycleLabel(value: number): string {
  return `${value}§7/cycle`;
}

const WRENCH_LORE: RawMessage[] = [
  { translate: "item.wh:wrench.desc.1" },
  BLANK_LINE,
  { translate: "item.wh:wrench.desc.2" },
  { translate: "item.wh:wrench.desc.3" },
  BLANK_LINE,
  ADDON_SIGNATURE_LINE,
];

const CONTROLLER_LORE: RawMessage[] = [{ translate: "item.wh:controller.desc.1" }, BLANK_LINE, ADDON_SIGNATURE_LINE];

const NETWORK_OBSERVER_LORE: RawMessage[] = [
  { translate: "item.wh:network_observer.desc.1" },
  BLANK_LINE,
  ADDON_SIGNATURE_LINE,
];

// ターミナル系(基本/自動/在庫管理)は「概要1行(種別ごとに違う)+使い方1行(共通)」という
// 同じ構造なので、概要のlangキーだけ差し替えて使い回す。
function terminalFamilyLore(summaryKey: string): RawMessage[] {
  return [
    { translate: summaryKey },
    BLANK_LINE,
    { translate: "item.wh:terminal_family.desc.usage" },
    BLANK_LINE,
    ADDON_SIGNATURE_LINE,
  ];
}

const TERMINAL_LORE = terminalFamilyLore("item.wh:terminal.desc.1");
const AUTO_TERMINAL_LORE = terminalFamilyLore("item.wh:auto_terminal.desc.1");
const INVENTORY_TERMINAL_LORE = terminalFamilyLore("item.wh:inventory_terminal.desc.1");
const PRECISION_TERMINAL_LORE = terminalFamilyLore("item.wh:precision_terminal.desc.1");
const DELIVERY_TERMINAL_LORE = terminalFamilyLore("item.wh:delivery_terminal.desc.1");

// 搬入出パッドは他のターミナル系と違いストレージに張り付かない(プレイヤーが上に乗るだけの
// 床置きブロック)ため、terminalFamilyLoreの「ストレージに設置し、」という使い方の文言が
// 合わない。専用の使い方説明を用意する。
const IO_PAD_LORE: RawMessage[] = [
  { translate: "item.wh:io_pad.desc.1" },
  BLANK_LINE,
  { translate: "item.wh:io_pad.desc.usage" },
  BLANK_LINE,
  ADDON_SIGNATURE_LINE,
];

// 速度強化キット: T1〜T4で文章自体は共通(item.wh:speed_kit.desc.*)で、スループット・Tier
// 番号・最大Tierだけがそのキットのtierに応じて変わる。数値を説明文にベタ書きしないのは、
// 後でスループットのテーブル(orderProcessing.ts等)を調整した時に自動で反映されるようにする
// ため(ユーザーからの要望)。
function buildSpeedKitLore(tier: number): RawMessage[] {
  const maxTier = getAxisMaxTier(CONTROLLER_SPEED_AXIS);
  return [
    { translate: "item.wh:speed_kit.desc.summary" },
    BLANK_LINE,
    { rawtext: [{ translate: "item.wh:speed_kit.desc.withdraw" }, { text: perCycleLabel(getOrderThroughput(tier)) }] },
    { rawtext: [{ translate: "item.wh:speed_kit.desc.deposit" }, { text: perCycleLabel(getDepositThroughput(tier)) }] },
    {
      rawtext: [{ translate: "item.wh:speed_kit.desc.internal" }, { text: perCycleLabel(getOrganizeThroughput(tier)) }],
    },
    BLANK_LINE,
    // 「Tier」は既存UI(controllerUi.tsのformatAxisTierLabel)と同じく未翻訳の固定表記。
    { text: `§7§oTier §r§o${tier} §7§o/ ${maxTier}` },
    ADDON_SIGNATURE_LINE,
  ];
}

// 周期短縮キット: 速度強化キットと同じ発想で、処理間隔(tick数)・Tier番号・最大Tierを
// networkProcessing.ts/upgrade.tsから毎回取得する。
function buildCycleKitLore(tier: number): RawMessage[] {
  const maxTier = getAxisMaxTier(CONTROLLER_CYCLE_AXIS);
  return [
    { translate: "item.wh:cycle_kit.desc.summary" },
    BLANK_LINE,
    {
      rawtext: [
        { translate: "item.wh:cycle_kit.desc.interval" },
        { text: `${getCycleIntervalTicks(tier)} §7ticks` },
      ],
    },
    BLANK_LINE,
    { text: `§7§oTier §r§o${tier} §7§o/ ${maxTier}` },
    ADDON_SIGNATURE_LINE,
  ];
}

// 範囲強化キット: 速度/周期強化キットと同じ発想で、接続可能範囲(マス数)・Tier番号・最大Tierを
// controllerAxes.ts/upgrade.tsから毎回取得する。
function buildRangeKitLore(tier: number): RawMessage[] {
  const maxTier = getAxisMaxTier(CONTROLLER_RANGE_AXIS);
  return [
    { translate: "item.wh:range_kit.desc.summary" },
    BLANK_LINE,
    { rawtext: [{ translate: "item.wh:range_kit.desc.range" }, { text: `±${getRangeForTier(tier)}` }] },
    BLANK_LINE,
    { text: `§7§oTier §r§o${tier} §7§o/ ${maxTier}` },
    ADDON_SIGNATURE_LINE,
  ];
}

// Bedrockにはアイテム"型"に静的な説明文を持たせる仕組みが無い(minecraft:display_nameは
// 名前のみ)ため、対応表はここでitemId -> Loreの行配列(または動的に組み立てる関数)として持つ。
// 1要素=1行。
const ITEM_DESCRIPTIONS: Record<string, RawMessage[] | (() => RawMessage[])> = {
  "wh:wrench": WRENCH_LORE,
  "wh:controller": CONTROLLER_LORE,
  "wh:terminal": TERMINAL_LORE,
  "wh:auto_terminal": AUTO_TERMINAL_LORE,
  "wh:inventory_terminal": INVENTORY_TERMINAL_LORE,
  "wh:precision_terminal": PRECISION_TERMINAL_LORE,
  "wh:delivery_terminal": DELIVERY_TERMINAL_LORE,
  "wh:io_pad": IO_PAD_LORE,
  "wh:network_observer": NETWORK_OBSERVER_LORE,
  "wh:speed_kit_tier1": () => buildSpeedKitLore(1),
  "wh:speed_kit_tier2": () => buildSpeedKitLore(2),
  "wh:speed_kit_tier3": () => buildSpeedKitLore(3),
  "wh:speed_kit_tier4": () => buildSpeedKitLore(4),
  "wh:cycle_kit_tier1": () => buildCycleKitLore(1),
  "wh:cycle_kit_tier2": () => buildCycleKitLore(2),
  "wh:cycle_kit_tier3": () => buildCycleKitLore(3),
  "wh:cycle_kit_tier4": () => buildCycleKitLore(4),
  "wh:range_kit_tier1": () => buildRangeKitLore(1),
  "wh:range_kit_tier2": () => buildRangeKitLore(2),
  "wh:range_kit_tier3": () => buildRangeKitLore(3),
  "wh:range_kit_tier4": () => buildRangeKitLore(4),
};

export function startItemDescriptionWatcher(): void {
  world.afterEvents.playerInventoryItemChange.subscribe(
    (event) => {
      const { itemStack, slot, player } = event;
      if (!itemStack) return;
      if (itemStack.getLore().length > 0) return; // 付与済み(このsetItem自体の再発火も含む)

      const loreSource = ITEM_DESCRIPTIONS[itemStack.typeId];
      if (!loreSource) return;
      const lore = typeof loreSource === "function" ? loreSource() : loreSource;

      const inventory = player.getComponent("inventory")?.container;
      if (!inventory) return;

      // Hotbar/Inventoryどちらの場合もslotはこのプレイヤーのコンテナ内での絶対スロット番号
      // (Hotbarは0-8, Inventoryは9-35)をそのまま指しているため、オフセット計算は不要。
      // 以前は+9のオフセットを加えていたが、これがInventory側で二重補正になり、書き戻し先が
      // 1行(9スロット)下にずれて「元のアイテムはそのまま・1マス下に説明文付きのコピーが
      // 新規生成される」という複製バグの原因になっていた。
      const updated = itemStack.clone();
      updated.setLore(lore);
      inventory.setItem(slot, updated);
    },
    { includeItems: Object.keys(ITEM_DESCRIPTIONS), ignoreQuantityChange: true }
  );
}
