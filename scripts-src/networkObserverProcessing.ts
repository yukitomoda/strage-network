import { Dimension, Vector3 } from "@minecraft/server";
import { displayKeyEquals } from "./itemIdentity";
import { NETWORK_OBSERVER_BLOCK_ID } from "./networkObserverBlock";
import { getObserverSettings } from "./observerSettings";
import { NetworkData, ObserverSettings } from "./state";
import { CatalogEntry, scanCatalog } from "./storageScan";

// BlockPermutation.getState/withStateの型はバニラの既知ステートのみを対象にしたジェネリックで、
// カスタムステート名は型に存在しないため、upgrade.tsと同じ理由でasキャストする。
const SIGNAL_STATE = "wh:signal_strength";

function countOf(catalog: CatalogEntry[], itemTypeId: string | undefined, itemName: string | undefined): number {
  if (!itemTypeId) return 0;
  return catalog.find((e) => displayKeyEquals(e.key, { typeId: itemTypeId, name: itemName }))?.total ?? 0;
}

// バニラのコンパレーターの「コンテナ充填率読み取り」と同じ式(ユーザー承認済み、docs/design.md参照)。
// 在庫0の時だけ0、最大値以上の時だけ15、それ以外は1〜14に単調増加でマッピングする。
function stockSignal(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 0;
  if (count >= max) return 15;
  return Math.min(14, Math.floor((count / max) * 14) + 1);
}

// 品目1<品目2なら0、==なら7、品目1>品目2なら15。
function compareSignal(count1: number, count2: number): number {
  if (count1 < count2) return 0;
  if (count1 === count2) return 7;
  return 15;
}

function computeSignalStrength(catalog: CatalogEntry[], settings: ObserverSettings): number {
  if (settings.mode === "stock") {
    const count = countOf(catalog, settings.itemTypeId, settings.itemName);
    return stockSignal(count, settings.maxAmount ?? 0);
  }
  const count1 = countOf(catalog, settings.itemTypeId, settings.itemName);
  const count2 = countOf(catalog, settings.itemTypeId2, settings.itemName2);
  return compareSignal(count1, count2);
}

// ネットワークが持つ最大3基のオブザーバー全てを、その時点のネットワーク在庫に基づいて
// 再計算する。カタログ(在庫スキャン)はこのネットワーク分1回だけ作って使い回す
// (depositProcessing.tsのbuildStorageIndexと同じ考え方)。
// 呼び出し元(networkProcessing.ts)が「コントローラによる出し入れ発生時は直ちに」
// 「そうでなくても5サイクルごとに」呼ぶことで、docs/design.mdの要求を満たす。
export function recalculateNetworkObservers(dimension: Dimension, network: NetworkData): void {
  if (network.observers.length === 0) return;
  const catalog = scanCatalog(dimension, network);

  for (const loc of network.observers) {
    const block = dimension.getBlock(loc);
    if (!block?.isValid || block.typeId !== NETWORK_OBSERVER_BLOCK_ID) continue;

    const settings = getObserverSettings(dimension, loc);
    const signal = settings ? computeSignalStrength(catalog, settings) : 0;
    block.setPermutation(block.permutation.withState(SIGNAL_STATE as any, signal as any));
  }
}

// ネットワークから切断された(または範囲外で自動切断された)オブザーバーの信号強度を0に戻す。
// 切断後は定期チェック(recalculateNetworkObservers)の対象から外れるため、切断時点の出力値が
// そのまま残ってしまう不具合があった。wrench.tsでの手動切断・controllerAxes.tsでの
// 範囲アップグレードによる自動切断の両方から呼ぶ。
export function resetObserverSignal(dimension: Dimension, loc: Vector3): void {
  const block = dimension.getBlock(loc);
  if (!block?.isValid || block.typeId !== NETWORK_OBSERVER_BLOCK_ID) return;
  block.setPermutation(block.permutation.withState(SIGNAL_STATE as any, 0 as any));
}
