import { ItemStack } from "@minecraft/server";

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
