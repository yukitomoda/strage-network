// 精密ターミナルの「スロット番号」入力欄(1エントリで複数スロットを指定できる。ユーザー要望)の
// パース/表示を担う共通ロジック。入力書式は「1」「1,2,3」「1-3」「1,3-5,7」のようにカンマ区切りの
// 単一値・範囲(a-b)を組み合わせる。precisionTerminalUi.ts(入力・現在のリスト表示)と
// statusListUi.ts(「状況」タブのツールチップ表示)の両方で同じ書式を使うため、ここに切り出した。

// 不正な入力(数値でない、範囲の開始が終了より大きい等)はundefinedを返す(呼び出し元は
// 既存のreadSlotIndex()と同じく「無効な入力なら何もしない」という扱いにする)。
export function parseSlotIndices(text: string): number[] | undefined {
  const segments = text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;

  const result = new Set<number>();
  for (const segment of segments) {
    const rangeMatch = segment.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) return undefined;
      for (let i = start; i <= end; i++) result.add(i);
      continue;
    }
    if (!/^\d+$/.test(segment)) return undefined;
    result.add(Number(segment));
  }
  if (result.size === 0) return undefined;
  return [...result].sort((a, b) => a - b);
}

// parseSlotIndicesの逆演算: ソート済み・重複無しのスロット番号配列を、連続する区間を
// 「a-b」にまとめたカンマ区切り文字列に整形する(例: [1,2,3,5,7] -> "1-3,5,7")。
// 保存はslotIndices(展開済みの配列)で行うため、表示のたびにこの関数で再構築する
// (入力時の元の書式・順序はそのまま保持しない。常に昇順・最短表記に正規化される)。
export function formatSlotRange(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";

  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (cur !== undefined) {
      start = cur;
      prev = cur;
    }
  }
  return parts.join(",");
}
