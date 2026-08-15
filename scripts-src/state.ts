import { Vector3, world } from "@minecraft/server";

// ネットワークの構造情報。world の動的プロパティに JSON として保存する。
// (ブロックは動的プロパティを持てないため。詳細は docs/design.md 2章参照)
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
  id: string;
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

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
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
