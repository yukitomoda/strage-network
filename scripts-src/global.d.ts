// Minecraft Bedrock のスクリプト実行環境にはグローバルな console が存在するが、
// @minecraft/server の型定義には含まれないため最小限の宣言を補う。
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
