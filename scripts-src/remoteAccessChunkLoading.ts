import { Dimension, Vector3, world } from "@minecraft/server";
import { NetworkData } from "./state";

// 「リモート操作」アップグレード(controllerAxes.tsのCONTROLLER_REMOTE_ACCESS_AXIS、T1以上)を
// 装着している間、コントローラ周辺(「範囲」軸が取りうる最大距離)を常時読み込み状態にする
// (ユーザー指摘: 長距離のリモート操作を行う場合、倉庫のあるチャンクが読み込まれていない
// 可能性を考慮する必要がある)。Bedrock Script APIのworld.tickingAreaManager
// (/tickingareaコマンド相当)を使う。このファイル自体は「アップグレード軸」の存在を知らず、
// 「装着されているか(active)」を呼び出し側(controllerAxes.ts)が判定してから渡す形にすることで、
// controllerAxes.tsとの循環importを避けている。
//
// 範囲は「範囲」軸(controllerAxes.tsのRANGE_TABLE)が取りうる最大値(16マス)をコントローラ中心に
// 固定でカバーする。現在の範囲軸Tierではなく常に最大値にしておくことで、範囲軸を後から
// アップグレードしても再計算不要にする(倉庫の実体(ストレージ等)は範囲軸の制約内にしか
// 存在しえないため、リモート操作軸のTier(プレイヤー側がどこまで離れて使えるか)とは無関係に
// このサイズで十分)。
const MAX_MEMBER_RADIUS = 16;

function tickingAreaId(networkId: string): string {
  return `wh_remote_${networkId}`;
}

function boundsFor(dimension: Dimension, controller: Vector3): { from: Vector3; to: Vector3 } {
  const { min, max } = dimension.heightRange;
  return {
    from: { x: controller.x - MAX_MEMBER_RADIUS, y: min, z: controller.z - MAX_MEMBER_RADIUS },
    to: { x: controller.x + MAX_MEMBER_RADIUS, y: max, z: controller.z + MAX_MEMBER_RADIUS },
  };
}

// activeがtrueなら(無ければ)作成し、falseなら(あれば)削除する。作成は容量超過等で失敗しうる
// (TickingAreaError)が、この機能自体は致命的にせずコンソールへ記録するに留める(チャンク常時
// 読み込みが効かないだけで、通常のプレイヤー接近時の読み込みには影響しないため)。
export function syncTickingAreaForNetwork(dimension: Dimension, network: NetworkData, active: boolean): void {
  const id = tickingAreaId(network.id);
  const manager = world.tickingAreaManager;
  const exists = manager.hasTickingArea(id);

  if (!active) {
    if (exists) manager.removeTickingArea(id);
    return;
  }
  if (exists) return;

  const options = { dimension, ...boundsFor(dimension, network.controller) };
  if (!manager.hasCapacity(options)) {
    console.warn(`[wh] リモート操作用のticking area(${id})を確保できません(容量上限に達しています)。`);
    return;
  }
  manager.createTickingArea(id, options).catch((e) => {
    console.warn(`[wh] リモート操作用のticking area(${id})の作成に失敗しました: ${e}`);
  });
}

export function removeTickingAreaForNetwork(networkId: string): void {
  const id = tickingAreaId(networkId);
  if (world.tickingAreaManager.hasTickingArea(id)) {
    world.tickingAreaManager.removeTickingArea(id);
  }
}
