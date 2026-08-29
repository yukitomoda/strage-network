import { Dimension, system } from "@minecraft/server";
import { NetworkData } from "./state";
import { CatalogEntry, scanCatalog } from "./storageScan";

// 自動端末/在庫管理ターミナル/精密ターミナル/搬入出パッドの定期チェックはいずれも
// networkProcessing.tsのstartCycleAlignedLoopで同じ基準間隔・同じサイクル間隔式で動くため、
// 同じtickに複数の定期チェックが同じネットワークのscanCatalog(全ストレージ・全スロットを
// 走査するため、ネットワークが大きいほどコストが高い)を重複して呼び出しうる。tickごとに
// ネットワークIDをキーにしたキャッシュを持たせることで、同じtick内での重複走査を1回にまとめる
// (ユーザー指摘: 注文時にもネットワーク在庫を確認するようにするとscanCatalogの呼び出し頻度が
// 増えるため、その対策として新設した)。
let cachedTick = -1;
const cache = new Map<string, CatalogEntry[]>();

export function getNetworkCatalogCached(dimension: Dimension, network: NetworkData): CatalogEntry[] {
  if (system.currentTick !== cachedTick) {
    cache.clear();
    cachedTick = system.currentTick;
  }
  const existing = cache.get(network.id);
  if (existing) return existing;

  const catalog = scanCatalog(dimension, network);
  cache.set(network.id, catalog);
  return catalog;
}
