import { ItemStack } from "@minecraft/server";
import addonItemNames from "./addonItemNames.json";
import vanillaItemNames from "./vanillaItemNames.json";

// 「検索UIの表示で判別できない属性は区別しない」という原則に基づく比較キー。
// 表示(標準名+カスタム名)にもマッチングにも、このキーだけを使う。
// 詳細は docs/design.md 5章参照。
export type DisplayKey = {
  typeId: string;
  name?: string;
};

export function displayKeyOf(stack: ItemStack): DisplayKey {
  return { typeId: stack.typeId, name: stack.nameTag };
}

export function displayKeyEquals(a: DisplayKey, b: DisplayKey): boolean {
  return a.typeId === b.typeId && (a.name ?? "") === (b.name ?? "");
}

export function stackMatchesKey(stack: ItemStack, key: DisplayKey): boolean {
  return displayKeyEquals(displayKeyOf(stack), key);
}

export function displayLabel(key: DisplayKey): string {
  return key.name ?? key.typeId;
}

// 検索欄はこれまでdisplayLabel(=typeIdかカスタム名)にしかマッチしなかったため、カスタム名の
// 無いバニラアイテムは"minecraft:diamond"のような生のtypeIdでしか探せなかった(ユーザー指摘)。
// サーバー側は本来任意プレイヤーの翻訳済み文字列を知る手段を持たない(RawMessageのtranslateは
// クライアント側で解決される)ため、Minecraft本体とこのアドオン自身のlangファイルから
// ビルド時に静的に抽出したテーブル(vanillaItemNames.json/addonItemNames.json、
// tools/generate-vanilla-item-names.mjs・tools/generate-addon-item-names.mjs参照)を使い、
// Player.clientSystemInfo.localeで判明するそのプレイヤーのクライアントロケールに応じて
// 表示名を引く。他アドオン(サードパーティ)のアイテムはこの表に無いため、従来通り
// displayLabel一致のみへ自動的にフォールバックする(検索の裾野が狭まるだけで壊れない)。
type ItemNameTable = Record<string, Record<string, string>>;

function localizedNameOf(localizationKey: string, locale: string): string | undefined {
  return (
    (addonItemNames as ItemNameTable)[locale]?.[localizationKey] ??
    (vanillaItemNames as ItemNameTable)[locale]?.[localizationKey]
  );
}

// ひらがな/カタカナを区別せず検索できるように、比較前にカタカナをひらがなへ正規化する
// (ユーザー要望)。全角カタカナ(U+30A1-U+30F6)とひらがな(U+3041-U+3096)はUnicode上
// 0x60だけ離れているだけなので、単純な引き算で変換できる(長音記号「ー」等、対応する
// ひらがなが無い文字はそのまま残る)。
function normalizeKana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function normalizeForSearch(text: string): string {
  return normalizeKana(text.toLowerCase());
}

export function matchesSearchQuery(
  entry: { label: string; localizationKey: string },
  query: string,
  locale: string
): boolean {
  const q = normalizeForSearch(query.trim());
  if (q === "") return true;
  if (normalizeForSearch(entry.label).includes(q)) return true;
  const localized = localizedNameOf(entry.localizationKey, locale);
  return !!localized && normalizeForSearch(localized).includes(q);
}
