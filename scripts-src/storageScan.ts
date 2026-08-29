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

// 引き出しUIのカタログ(=ネットワーク内のストレージ群の在庫)。
export function scanCatalog(dimension: Dimension, network: NetworkData): CatalogEntry[] {
  return scanContainers(networkStorageContainers(dimension, network));
}

// 預け入れUIのカタログ(=ターミナルの張り付いた先のコンテナの中身)。
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
// 大きいネットワーク(例: ラージチェスト30個=1620スロット)で、預け入れする品目ごとに全スロットを
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
// index は network.storages 全体から作られている一方、storages(候補先)は Drain指定などで
// 絞り込まれている場合があるため、priority 側も storages に実在するものだけに絞ってから使う
// (絞り込み対象外の場所を誤って先頭に混入させないため)。insertSlotIntoStorages(精密ターミナル用)
// からも使うためexportしている。
export function orderStoragesByPriority(storages: Vector3[], key: DisplayKey, index?: StorageIndex): Vector3[] {
  if (!index) return storages;
  const priority = index.get(serializeKey(key));
  if (!priority || priority.length === 0) return storages;

  const storageSet = new Set(storages.map((l) => `${l.x},${l.y},${l.z}`));
  const prioritized = priority.filter((l) => storageSet.has(`${l.x},${l.y},${l.z}`));
  const prioritySet = new Set(prioritized.map((l) => `${l.x},${l.y},${l.z}`));
  const rest = storages.filter((l) => !prioritySet.has(`${l.x},${l.y},${l.z}`));
  return [...prioritized, ...rest];
}

// sourceContainer から指定アイテムを最大 amount 個取り出し、ネットワーク内のストレージ群へ
// 分散して格納する(1つのストレージで入りきらない分は次のストレージへ)。extractFromStorages
// と対称: 取り出しと格納は1スロット単位でアトミックに行うため、宙に浮いたアイテムは発生しない。
// storageIndex を渡すと、既に同じアイテムを持っているストレージを優先してスタックさせる。
// destinationStorages を渡すと、搬入先候補をそのリストに絞り込める(省略時はnetwork.storages
// 全体)。Drain指定されたストレージを除外する目的で、呼び出し元(預け入れ処理・倉庫の整理)が
// ネットワークにつき1tick1回だけ絞り込んで渡す想定(毎回このstorage単位で絞り込みを
// 計算し直すと、Drain判定用の非表示エンティティ検索が呼び出し回数分走ってしまうため)。
// 戻り値は実際に搬入できた数(候補先が満杯なら amount より少なくなる)。
export function insertIntoStorages(
  dimension: Dimension,
  network: NetworkData,
  key: DisplayKey,
  amount: number,
  sourceContainer: Container,
  storageIndex?: StorageIndex,
  destinationStorages: Vector3[] = network.storages
): number {
  let remaining = amount;
  const orderedStorages = orderStoragesByPriority(destinationStorages, key, storageIndex);

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

// 精密ターミナル(orderProcessing.tsのline.slotIndices経由、1スロットずつ呼ばれる。単一スロット
// なら直接、複数スロットならextractFromStoragesIntoSlots経由)専用。extractFromStoragesと同じ順で
// ネットワークのストレージを走査するが、格納先はdestContainerの指定スロットのみ
// (「コンテナのどこでもいい」という前提のextractFromStoragesとは異なる)。既存の中身がkeyと
// 矛盾する場合は何もしない(精密ターミナルの希望リスト補充では、呼び出し元のprecisionTerminalCheck.ts
// が既に矛盾チェックをしているはずだが、念のためここでも防御する)。搬入量はアイテムの
// maxAmount(最大スタック数)と既存の中身から計算した空き分でも制限する。
export function extractFromStoragesIntoSlot(
  dimension: Dimension,
  network: NetworkData,
  key: DisplayKey,
  amount: number,
  destContainer: Container,
  slotIndex: number
): number {
  const existing = destContainer.getItem(slotIndex);
  if (existing && !displayKeyEquals(displayKeyOf(existing), key)) return 0;

  const maxStack = existing?.maxAmount ?? new ItemStack(key.typeId, 1).maxAmount;
  const room = maxStack - (existing?.amount ?? 0);
  let remaining = Math.min(amount, room);
  if (remaining <= 0) return 0;
  const requested = remaining;

  for (const loc of network.storages) {
    if (remaining <= 0) break;
    const container = dimension.getBlock(loc)?.getComponent("inventory")?.container;
    if (!container) continue;

    for (let i = 0; i < container.size && remaining > 0; i++) {
      const item = container.getItem(i);
      if (!item || !displayKeyEquals(displayKeyOf(item), key)) continue;

      const take = Math.min(remaining, item.amount);
      const current = destContainer.getItem(slotIndex);
      if (current) {
        const merged = current.clone();
        merged.amount += take;
        destContainer.setItem(slotIndex, merged);
      } else {
        const placed = item.clone();
        placed.amount = take;
        destContainer.setItem(slotIndex, placed);
      }

      if (take >= item.amount) {
        container.setItem(i, undefined);
      } else {
        const remainder = item.clone();
        remainder.amount = item.amount - take;
        container.setItem(i, remainder);
      }
      remaining -= take;
    }
  }

  return requested - remaining;
}

// n個のスロットにamountをできるだけ均等に配分する(端数は配列の先頭側から+1個ずつ乗せる)。
// 精密ターミナルの複数スロット指定(1エントリで複数スロットを維持する機能)の配分計算に使う。
export function evenSplit(amount: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(amount / n);
  const remainder = amount % n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

// ネットワーク内に指定アイテムが実際にどれだけあるか(上限capまで)を読み取り専用で数える。
// extractFromStoragesIntoSlotsが、スロットへの配分量を決める前に「実際に取り出せる総量」を
// 把握するために使う(取り出しは行わない)。
function countAvailable(dimension: Dimension, network: NetworkData, key: DisplayKey, cap: number): number {
  let total = 0;
  for (const loc of network.storages) {
    if (total >= cap) break;
    const container = dimension.getBlock(loc)?.getComponent("inventory")?.container;
    if (!container) continue;
    for (let i = 0; i < container.size && total < cap; i++) {
      const item = container.getItem(i);
      if (!item || !displayKeyEquals(displayKeyOf(item), key)) continue;
      total += item.amount;
    }
  }
  return Math.min(total, cap);
}

// 精密ターミナルの複数スロット指定(1エントリで複数スロットを維持する機能。ユーザー要望)専用。
// 単純に先頭のスロットから満たしていくと、ネットワーク在庫が要求量に足りない場合に後方の
// スロットだけ0のまま、という偏った結果になってしまう(例: 3スロットに10個ずつ要求しているのに
// 在庫が20個しか無い場合、10,10,0になってしまう)。そこで先に「実際に取り出せる総量」を
// countAvailableで確定させてから、evenSplitで各スロットへの配分量を決め、1スロットずつ
// extractFromStoragesIntoSlotを呼ぶ(例: 20個を3スロットに配分 -> 7,7,6)。各スロットの
// 空き容量(スタック上限)によっては配分通りに届かないことがあるが、それは物理的な制約として
// 許容する(「可能な限り均等に分配する」というユーザー要望の通り)。
export function extractFromStoragesIntoSlots(
  dimension: Dimension,
  network: NetworkData,
  key: DisplayKey,
  amount: number,
  destContainer: Container,
  slotIndices: number[]
): number {
  if (slotIndices.length === 0) return 0;
  if (slotIndices.length === 1) {
    return extractFromStoragesIntoSlot(dimension, network, key, amount, destContainer, slotIndices[0]);
  }

  const available = countAvailable(dimension, network, key, amount);
  const allocations = evenSplit(available, slotIndices.length);

  let delivered = 0;
  for (let i = 0; i < slotIndices.length; i++) {
    if (allocations[i] <= 0) continue;
    delivered += extractFromStoragesIntoSlot(dimension, network, key, allocations[i], destContainer, slotIndices[i]);
  }
  return delivered;
}

// 精密ターミナル専用。insertIntoStoragesと対称だが、取り出し元はsourceContainerの指定スロットのみ
// (コンテナ全体の走査が不要なため、単一スロット分の処理だけで済む)。
export function insertSlotIntoStorages(
  dimension: Dimension,
  network: NetworkData,
  key: DisplayKey,
  amount: number,
  sourceContainer: Container,
  slotIndex: number,
  storageIndex?: StorageIndex,
  destinationStorages: Vector3[] = network.storages
): number {
  const item = sourceContainer.getItem(slotIndex);
  if (!item || !displayKeyEquals(displayKeyOf(item), key)) return 0;

  const take = Math.min(amount, item.amount);
  let leftover: ItemStack | undefined = item.clone();
  leftover.amount = take;

  const orderedStorages = orderStoragesByPriority(destinationStorages, key, storageIndex);
  for (const loc of orderedStorages) {
    if (!leftover) break;
    const destContainer = dimension.getBlock(loc)?.getComponent("inventory")?.container;
    if (!destContainer) continue;
    leftover = destContainer.addItem(leftover);
  }

  const inserted = take - (leftover?.amount ?? 0);
  if (inserted <= 0) return 0;

  if (inserted >= item.amount) {
    sourceContainer.setItem(slotIndex, undefined);
  } else {
    const remainder = item.clone();
    remainder.amount = item.amount - inserted;
    sourceContainer.setItem(slotIndex, remainder);
  }
  return inserted;
}
