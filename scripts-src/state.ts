import { Vector3, world } from "@minecraft/server";

// ネットワークの構造情報。world の動的プロパティに JSON として保存する。
// (ブロックは動的プロパティを持てないため。詳細は docs/design.md 2章参照)
// terminals は所属情報(座標)のみ。ターミナルごとの設定は、これとは別に非表示エンティティ
// (terminalSettings.ts)に持たせる。設定項目が増えてもネットワーク全体のJSONを肥大化させず、
// その1台分の読み書きだけで完結させるため。
export type NetworkData = {
  id: string;
  dimensionId: string;
  controller: Vector3;
  storages: Vector3[];
  terminals: Vector3[];
};

export type OrderLine = {
  itemTypeId: string;
  itemName?: string; // nameTag(銘)がある場合のみ
  requested: number;
  delivered: number;
  exhausted: boolean;
};

export type Order = {
  id: string; // 短い表示用ID。マルチプレイでの識別用途なので厳密な一意性は不要
  playerName: string; // 完了通知の送り先を後から探すため(Entity.idはセッションをまたいで安定しない)
  terminal: Vector3;
  lines: OrderLine[];
};

export type IssuingEntry = {
  order: Order;
  readyAtTick: number;
};

export type PartialResultLine = {
  itemTypeId: string;
  itemName?: string;
  amount: number;
};

export type PartialResult = {
  orderId: string;
  terminal: Vector3;
  shortfall: PartialResultLine[];
};

// 納入(ターミナルの張り付いた先のストレージ -> ネットワーク内のストレージ群)。
// 注文と対称な構造だが、方向が逆で、スループット等も個別に設定できるよう別系統にする。
export type DepositLine = {
  itemTypeId: string;
  itemName?: string;
  requested: number;
  delivered: number;
  exhausted: boolean;
};

export type DepositRequest = {
  id: string;
  terminal: Vector3;
  lines: DepositLine[];
};

export type DepositIssuingEntry = {
  request: DepositRequest;
  readyAtTick: number;
};

export type DepositPartialResult = {
  requestId: string;
  terminal: Vector3;
  shortfall: PartialResultLine[];
};

// 自動端末の「維持したい在庫量」リスト。ターミナルごとの設定として
// terminalSettings.ts (非表示エンティティ)に保存する。
export type WishlistLine = {
  itemTypeId: string;
  itemName?: string;
  targetAmount: number;
};

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// 表示用IDの共通部分。マルチプレイでプレイヤーが自分の注文/ターミナルをチャット上で
// 見分けられればよく、厳密な一意性は不要なので、短い英数字4桁にしている(36^4 ≈ 168万通り)。
function generateShortCode(): string {
  return Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .toUpperCase()
    .padStart(4, "0");
}

// 注文の表示用ID。
export function generateOrderId(): string {
  return `TAK-${generateShortCode()}`;
}

// ターミナルの初期名。設定タブでいつでも変更できる前提の、区別のためだけの仮名。
// 注文ID・自動端末の初期名とひと目で見分けられるよう接頭辞を変えている。
export function generateTerminalName(): string {
  return `TRM-${generateShortCode()}`;
}

export function generateAutoTerminalName(): string {
  return `ATM-${generateShortCode()}`;
}

export function locEquals(a: Vector3, b: Vector3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function readJson<T>(key: string): T | undefined {
  const raw = world.getDynamicProperty(key);
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, value: unknown): void {
  world.setDynamicProperty(key, JSON.stringify(value));
}

export function clearProperty(key: string): void {
  world.setDynamicProperty(key, undefined);
}
