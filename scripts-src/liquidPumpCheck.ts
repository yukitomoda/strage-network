import { Block, Dimension, FluidContainer, FluidType, ItemStack, Vector3 } from "@minecraft/server";
import { NetworkData } from "./state";
import { consumeFromStorages, insertItemStackIntoStorages } from "./storageScan";
import { isRedstoneLocked, LIQUID_PUMP_BLOCK_ID } from "./terminalBlock";

const EMPTY_BUCKET_ITEM_ID = "minecraft:bucket";

type ExtractableFluid = {
  itemId: string;
  // ワールド側から実際に汲み出す(ブロックのair化 or 大釜のfillLevelを0にする)。
  take: () => void;
};

// facing_direction(minecraft:placement_directionトレイト、設置時にプレイヤーが向いていた方向)
// が指す面に、対象の液体を示すバルブ柄のテクスチャが表示される(BP側permutations参照)。
// ユーザー要望「ブロックの背後にある液体を対象にする」を、その面の1マス先=facing_directionの
// 指す方向として実装する(プレイヤーからはバルブが向いている方向の液体を汲んでいるように見える)。
const FACING_DIRECTION_VECTORS: Record<string, Vector3> = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
};

function getTargetLiquidLocation(block: Block): Vector3 {
  const facing = block.permutation.getAllStates()["minecraft:facing_direction"] as string | undefined;
  const dir = FACING_DIRECTION_VECTORS[facing ?? "north"] ?? FACING_DIRECTION_VECTORS.north;
  const loc = block.location;
  return { x: loc.x + dir.x, y: loc.y + dir.y, z: loc.z + dir.z };
}

// スコープは水・溶岩のみ(ユーザー指定)。ポーション/粉雪/染料入り大釜は対象外。
function detectExtractableFluid(block: Block | undefined): ExtractableFluid | undefined {
  if (!block) return undefined;

  // (a) ワールドの水源/溶岩源ブロック。liquid_depth === 0(ソース)のみ対象で、流れている
  // 水/溶岩(1以上)はバニラのバケツと同じく汲めない。
  if (block.typeId === "minecraft:water" || block.typeId === "minecraft:lava") {
    const depth = block.permutation.getAllStates()["liquid_depth"];
    if (depth !== 0) return undefined;
    const isWater = block.typeId === "minecraft:water";
    return {
      itemId: isWater ? "minecraft:water_bucket" : "minecraft:lava_bucket",
      take: () => block.setType("minecraft:air"),
    };
  }

  // (b) 満タンの大釜。fillLevelが最大値のもの(バケツ1杯分)のみ対象で、中途半端な水位は
  // 対象外(バニラのバケツでも汲めないことに合わせた)。
  if (block.typeId === "minecraft:cauldron") {
    const fluid = block.getComponent("minecraft:fluid_container");
    if (!fluid || fluid.fillLevel !== FluidContainer.maxFillLevel) return undefined;

    const fluidType = fluid.getFluidType();
    if (fluidType !== FluidType.Water && fluidType !== FluidType.Lava) return undefined;
    return {
      itemId: fluidType === FluidType.Water ? "minecraft:water_bucket" : "minecraft:lava_bucket",
      take: () => {
        fluid.fillLevel = FluidContainer.minFillLevel;
      },
    };
  }

  return undefined;
}

// 液体ポンプ1台につき1サイクル最大1回の変換(汲み出しのみ、ユーザー指定によりスコープ外の
// 「注ぎ込み」は実装しない)。他の目標系ターミナル(自動端末/在庫管理ターミナル/精密ターミナル/
// 搬入出パッド)のような共有スループット予算は導入していない: 対象が固定1マスのため、
// 1台あたり1サイクル1個という上限が自然に付くからである(targetReconciliation.tsには乗せず、
// networkProcessing.tsから直接呼ぶ独立処理にしている)。
// 戻り値: 変換が実際に発生したか(ネットワークオブザーバーの即時再計算トリガーに使う)。
export function processLiquidPump(dimension: Dimension, network: NetworkData, block: Block): boolean {
  const target = dimension.getBlock(getTargetLiquidLocation(block));
  const fluid = detectExtractableFluid(target);
  if (!fluid) return false;

  // 空バケツを1個消費できるか確認する。無ければ何もしない(プレイヤーがバケツを
  // 供給する必要がある、ユーザー指定の仕様)。
  const consumed = consumeFromStorages(dimension, network, { typeId: EMPTY_BUCKET_ITEM_ID }, 1);
  if (consumed <= 0) return false;

  // ワールドの液体を消費する前に、必ず先に満タンバケツの格納が成功するか確認する。
  // 順序を守らないと、ネットワーク満杯時に「バケツだけ消えて液体もアイテムも
  // 生成されない」というアイテム消失が起こりうる。格納に失敗した場合は消費した
  // 空バケツを戻して中断する(ワールド側にはまだ手を付けていないので、ここまでなら
  // 元の状態に完全に戻せる)。
  const inserted = insertItemStackIntoStorages(dimension, network, new ItemStack(fluid.itemId, 1));
  if (inserted <= 0) {
    insertItemStackIntoStorages(dimension, network, new ItemStack(EMPTY_BUCKET_ITEM_ID, 1));
    return false;
  }

  fluid.take();
  return true;
}

// networkProcessing.tsのサイクルから呼ばれる。network.terminalsをLIQUID_PUMP_BLOCK_IDで
// 絞り込み、各ポンプについてprocessLiquidPumpを1回ずつ試す。
export function processNetworkLiquidPumps(dimension: Dimension, network: NetworkData): boolean {
  let changed = false;
  for (const loc of network.terminals) {
    const block = dimension.getBlock(loc);
    if (!block?.isValid || block.typeId !== LIQUID_PUMP_BLOCK_ID) continue;
    if (isRedstoneLocked(block)) continue;
    if (processLiquidPump(dimension, network, block)) changed = true;
  }
  return changed;
}
