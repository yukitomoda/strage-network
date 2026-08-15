import { Container, Dimension, ItemStack, Vector3 } from "@minecraft/server";
import { DisplayKey, displayKeyEquals, displayKeyOf, displayLabel } from "./itemIdentity";
import { NetworkData } from "./state";

function serializeKey(key: DisplayKey): string {
  return JSON.stringify([key.typeId, key.name ?? ""]);
}

// label は検索用の照合キー(typeIdかnameTag)。表示にはこれを使わず localizationKey を使う
// (客先クライアントのlangファイルで解決してもらい、自前の翻訳テーブルは持たない)。
export type CatalogEntry = { key: DisplayKey; label: string; localizationKey: string; total: number };

// 任意のコンテナ集合から在庫カタログを作る。毎回ライブスキャンするので永続化は不要、常に最新。
function scanContainers(containers: Container[]): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const container of containers) {
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (!item) continue;
      const key = displayKeyOf(item);
      const existing = entries.find((e) => displayKeyEquals(e.key, key));
      if (existing) {
        existing.total += item.amount;
      } else {
        entries.push({ key, label: displayLabel(key), localizationKey: item.localizationKey, total: item.amount });
      }
    }
  }
  return entries;
}

function networkStorageContainers(dimension: Dimension, network: NetworkData): Container[] {
  const containers: Container[] = [];
  for (const loc of network.storages) {
    const container = dimension.getBlock(loc)?.getComponent("inventory")?.container;
    if (container) containers.push(container);
  }
  return containers;
}

// 注文UIのカタログ(=ネットワーク内のストレージ群の在庫)。
export function scanCatalog(dimension: Dimension, network: NetworkData): CatalogEntry[] {
  return scanContainers(networkStorageContainers(dimension, network));
}

// 納入UIのカタログ(=ターミナルの張り付いた先のコンテナの中身)。
export function scanContainerCatalog(container: Container): CatalogEntry[] {
  return scanContainers([container]);
}

// ストレージから指定アイテムを最大 amount 個取り出し、destContainer へ格納する。
// 取り出しと格納は1スロット単位でアトミックに行うため、宙に浮いたアイテムは発生しない。
// 戻り値は実際に届けられた数(在庫不足やdestContainer満杯なら amount より少なくなる)。
export function extractFromStorages(
  dimension: Dimension,
  network: NetworkData,
  key: DisplayKey,
  amount: number,
  destContainer: Container
): number {
  let remaining = amount;

  for (const loc of network.storages) {
    if (remaining <= 0) break;
    const block = dimension.getBlock(loc);
    const container = block?.getComponent("inventory")?.container;
    if (!container) continue;

    for (let i = 0; i < container.size && remaining > 0; i++) {
      const item = container.getItem(i);
      if (!item || !displayKeyEquals(displayKeyOf(item), key)) continue;

      const take = Math.min(remaining, item.amount);
      const toDeliver = item.clone();
      toDeliver.amount = take;

      const leftover = destContainer.addItem(toDeliver);
      const delivered = take - (leftover?.amount ?? 0);
      if (delivered <= 0) {
        // 搬入先(ターミナル)が満杯で1個も入らなかった。これ以上続けても無駄。
        return amount - remaining;
      }

      if (delivered >= item.amount) {
        container.setItem(i, undefined);
      } else {
        const remainder = item.clone();
        remainder.amount = item.amount - delivered;
        container.setItem(i, remainder);
      }
      remaining -= delivered;
    }
  }

  return amount - remaining;
}

// 「どのストレージに何(displayKey)が既に置かれているか」の索引。key は serializeKey() の値。
// 大きいネットワーク(例: ラージチェスト30個=1620スロット)で、納入する品目ごとに全スロットを
// 何度も舐め直すと重くなりすぎるため、1tickにつき1回だけ作って使い回す想定(呼び出し元で保持)。
export type StorageIndex = Map<string, Vector3[]>;

export function buildStorageIndex(dimension: Dimension, network: NetworkData): StorageIndex {
  const index: StorageIndex = new Map();
  for (const loc of network.storages) {
    const container = dimension.getBlock(loc)?.getComponent("inventory")?.container;
    if (!container) continue;

    const seenInThisContainer = new Set<string>();
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (!item) continue;
      const serialized = serializeKey(displayKeyOf(item));
      if (seenInThisContainer.has(serialized)) continue; // 同じストレージを同じキーで二重登録しない
      seenInThisContainer.add(serialized);

      const existing = index.get(serialized);
      if (existing) existing.push(loc);
      else index.set(serialized, [loc]);
    }
  }
  return index;
}

// 索引がある場合、そのキーを既に持っているストレージを優先し、残りを末尾に回す。
function orderStoragesByPriority(storages: Vector3[], key: DisplayKey, index?: StorageIndex): Vector3[] {
  if (!index) return storages;
  const priority = index.get(serializeKey(key));
  if (!priority || priority.length === 0) return storages;

  const prioritySet = new Set(priority.map((l) => `${l.x},${l.y},${l.z}`));
  const rest = storages.filter((l) => !prioritySet.has(`${l.x},${l.y},${l.z}`));
  return [...priority, ...rest];
}

// sourceContainer から指定アイテムを最大 amount 個取り出し、ネットワーク内のストレージ群へ
// 分散して格納する(1つのストレージで入りきらない分は次のストレージへ)。extractFromStorages
// と対称: 取り出しと格納は1スロット単位でアトミックに行うため、宙に浮いたアイテムは発生しない。
// storageIndex を渡すと、既に同じアイテムを持っているストレージを優先してスタックさせる。
// 戻り値は実際に搬入できた数(ネットワーク側が満杯なら amount より少なくなる)。
export function insertIntoStorages(
  dimension: Dimension,
  network: NetworkData,
  key: DisplayKey,
  amount: number,
  sourceContainer: Container,
  storageIndex?: StorageIndex
): number {
  let remaining = amount;
  const orderedStorages = orderStoragesByPriority(network.storages, key, storageIndex);

  for (let i = 0; i < sourceContainer.size && remaining > 0; i++) {
    const item = sourceContainer.getItem(i);
    if (!item || !displayKeyEquals(displayKeyOf(item), key)) continue;

    const take = Math.min(remaining, item.amount);
    let leftover: ItemStack | undefined = item.clone();
    leftover.amount = take;

    for (const loc of orderedStorages) {
      if (!leftover) break;
      const destContainer = dimension.getBlock(loc)?.getComponent("inventory")?.container;
      if (!destContainer) continue;
      leftover = destContainer.addItem(leftover);
    }

    const inserted = take - (leftover?.amount ?? 0);
    if (inserted <= 0) {
      // ネットワーク側がどこも満杯で1個も入らなかった。これ以上続けても無駄。
      return amount - remaining;
    }

    if (inserted >= item.amount) {
      sourceContainer.setItem(i, undefined);
    } else {
      const remainder = item.clone();
      remainder.amount = item.amount - inserted;
      sourceContainer.setItem(i, remainder);
    }
    remaining -= inserted;
  }

  return amount - remaining;
}
