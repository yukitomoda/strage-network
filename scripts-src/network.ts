import { Container, Dimension, ItemStack, Vector3 } from "@minecraft/server";
import {
  clearProperty,
  DepositIssuingEntry,
  DepositPartialResult,
  DepositRequest,
  generateId,
  IssuingEntry,
  locEquals,
  NetworkData,
  Order,
  OrganizeRequest,
  PartialResult,
  readJson,
  writeJson,
} from "./state";

const NETWORK_IDS_KEY = "wh:network_ids";

function networkKey(id: string): string {
  return `wh:network:${id}`;
}
function ordersKey(id: string): string {
  return `wh:orders:${id}`;
}
function issuingKey(id: string): string {
  return `wh:issuing:${id}`;
}
function orderCancelsKey(id: string): string {
  return `wh:order_cancels:${id}`;
}
function partialKey(id: string): string {
  return `wh:partial:${id}`;
}
function depositsKey(id: string): string {
  return `wh:deposits:${id}`;
}
function depositIssuingKey(id: string): string {
  return `wh:deposit_issuing:${id}`;
}
function depositCancelsKey(id: string): string {
  return `wh:deposit_cancels:${id}`;
}
function depositPartialKey(id: string): string {
  return `wh:deposit_partial:${id}`;
}
function organizeKey(id: string): string {
  return `wh:organize:${id}`;
}
function organizeCancelsKey(id: string): string {
  return `wh:organize_cancels:${id}`;
}

export function getNetworkIds(): string[] {
  return readJson<string[]>(NETWORK_IDS_KEY) ?? [];
}

function setNetworkIds(ids: string[]): void {
  writeJson(NETWORK_IDS_KEY, ids);
}

// オブザーバー機能を追加する前に作られたネットワークは、永続化データに`observers`が
// 存在しない(undefined)。そのまま返すと`network.observers.some(...)`等が例外を投げ、
// findMembership(全ネットワークを走査する)経由でレンチのあらゆる接続操作が無反応になる
// 不具合が実機で見つかった。読み込み時に正規化し、以後の書き戻しで自然に補完されるようにする。
export function getNetwork(id: string): NetworkData | undefined {
  const network = readJson<NetworkData>(networkKey(id));
  if (network && !network.observers) network.observers = [];
  return network;
}

function setNetwork(network: NetworkData): void {
  writeJson(networkKey(network.id), network);
}

export function getAllNetworks(): NetworkData[] {
  const result: NetworkData[] = [];
  for (const id of getNetworkIds()) {
    const network = getNetwork(id);
    if (network) result.push(network);
  }
  return result;
}

export function createNetwork(dimensionId: string, controller: Vector3): NetworkData {
  const network: NetworkData = {
    id: generateId(),
    dimensionId,
    controller,
    storages: [],
    terminals: [],
    observers: [],
  };
  setNetwork(network);
  setNetworkIds([...getNetworkIds(), network.id]);
  return network;
}

export function destroyNetwork(id: string): void {
  setNetworkIds(getNetworkIds().filter((existing) => existing !== id));
  clearProperty(networkKey(id));
  clearProperty(ordersKey(id));
  clearProperty(issuingKey(id));
  clearProperty(orderCancelsKey(id));
  clearProperty(partialKey(id));
  clearProperty(depositsKey(id));
  clearProperty(depositIssuingKey(id));
  clearProperty(depositCancelsKey(id));
  clearProperty(depositPartialKey(id));
  clearProperty(organizeKey(id));
  clearProperty(organizeCancelsKey(id));
}

export function findNetworkByController(dimensionId: string, loc: Vector3): NetworkData | undefined {
  return getAllNetworks().find(
    (network) => network.dimensionId === dimensionId && locEquals(network.controller, loc)
  );
}

export type MemberRole = "controller" | "storage" | "terminal" | "observer";

export function findMembership(
  dimensionId: string,
  loc: Vector3
): { network: NetworkData; role: MemberRole } | undefined {
  for (const network of getAllNetworks()) {
    if (network.dimensionId !== dimensionId) continue;
    if (locEquals(network.controller, loc)) return { network, role: "controller" };
    if (network.storages.some((s) => locEquals(s, loc))) return { network, role: "storage" };
    if (network.terminals.some((t) => locEquals(t, loc))) return { network, role: "terminal" };
    if (network.observers.some((o) => locEquals(o, loc))) return { network, role: "observer" };
  }
  return undefined;
}

// バニラの二連チェストは隣接する2つの独立したブロックだが、中身(コンテナ)は
// 実質1つを共有している。両方を別々にストレージとして登録すると、スキャン時に
// 同じ中身を二重カウントしてしまうため、接続時に検知して防止する。
//
// 「サイズが等しい(54)」だけでは不十分: 例えば [A1 A2 B1 B2] のように別々の
// 二連チェストが隣接して並んでいる場合、A2とB1はどちらも54スロットで隣接して
// いるが、実際には中身を共有していない。サイズはあくまで「その可能性がある」
// ことの足切りにしか使えないため、最終的には実際に中身を共有しているかを
// 直接確認する(一意な目印アイテムを一時的に置いて、もう片方から見えるか確認する)。
const SINGLE_CONTAINER_MAX_SIZE = 27;

function neighborsOf(loc: Vector3): Vector3[] {
  return [
    { x: loc.x + 1, y: loc.y, z: loc.z },
    { x: loc.x - 1, y: loc.y, z: loc.z },
    { x: loc.x, y: loc.y, z: loc.z + 1 },
    { x: loc.x, y: loc.y, z: loc.z - 1 },
  ];
}

function containersShareStorage(a: Container, b: Container): boolean {
  if (a.size !== b.size || a.size === 0) return false;

  // 空きスロットを探す必要はない。どのスロットも「元の中身を退避 -> 目印を書き込んで
  // 確認 -> 必ず元に戻す」という手順にすれば、満杯のコンテナでも判定できる。
  // Storage Networkでは大量にアイテムを詰め込んだコンテナを接続することが普通なので、
  // 空きスロット前提の判定は実用上ほぼ機能しない。
  const probeSlot = 0;
  const original = a.getItem(probeSlot);

  const marker = new ItemStack("minecraft:stick", 1);
  marker.nameTag = `wh:probe:${Date.now()}:${Math.random()}`;

  a.setItem(probeSlot, marker);
  let shared = false;
  for (let i = 0; i < b.size; i++) {
    if (b.getItem(i)?.nameTag === marker.nameTag) {
      shared = true;
      break;
    }
  }
  a.setItem(probeSlot, original); // 元の中身(空だった場合はundefined)に必ず戻す

  return shared;
}

// 中身を共有する隣接ブロック(二連チェストのもう半分)を、ネットワーク登録の有無に関係なく
// 純粋に物理的に探す。倉庫レンチのDrain機能で「登録されていない方の半分」を扱う時にも使う。
export function findPhysicalStoragePair(dimension: Dimension, loc: Vector3): Vector3 | undefined {
  const container = dimension.getBlock(loc)?.getComponent("inventory")?.container;
  if (!container || container.size <= SINGLE_CONTAINER_MAX_SIZE) return undefined;

  for (const n of neighborsOf(loc)) {
    const neighborContainer = dimension.getBlock(n)?.getComponent("inventory")?.container;
    if (neighborContainer && containersShareStorage(container, neighborContainer)) return n;
  }
  return undefined;
}

export function findAdjacentConnectedStorage(
  dimension: Dimension,
  network: NetworkData,
  loc: Vector3
): Vector3 | undefined {
  const pair = findPhysicalStoragePair(dimension, loc);
  return pair && network.storages.some((s) => locEquals(s, pair)) ? pair : undefined;
}

// loc がどのネットワークの登録済みストレージに属すかを解決する。loc 自体が登録されて
// いなくても、二連チェストの「登録されていない方の半分」であれば、中身を共有する
// 登録済みの隣(=正としての登録位置)を見つけて返す(倉庫レンチのDrain機能で使用)。
export function resolveStorageMembership(
  dimension: Dimension,
  loc: Vector3
): { network: NetworkData; registeredLocation: Vector3 } | undefined {
  for (const network of getAllNetworks()) {
    if (network.dimensionId !== dimension.id) continue;
    if (network.storages.some((s) => locEquals(s, loc))) return { network, registeredLocation: loc };
  }

  const pair = findPhysicalStoragePair(dimension, loc);
  if (!pair) return undefined;

  for (const network of getAllNetworks()) {
    if (network.dimensionId !== dimension.id) continue;
    if (network.storages.some((s) => locEquals(s, pair))) return { network, registeredLocation: pair };
  }
  return undefined;
}

// ネットワークの接続範囲(コントローラを中心とした立方体の半径、ブロック数)。コントローラの
// 「範囲」アップグレード軸のTierに応じて可変(controllerAxes.tsのgetRangeForTier参照)。
// network.ts自体はアップグレード軸の仕組みを知らないため、範囲の値は呼び出し側が
// 都度getRangeForTierで引いてから渡す。
//
// 立方体(各軸の距離が全てrange以内)で判定する。当初は球(ユークリッド距離)だったが、
// Minecraft本来の距離判定(ワールドボーダー等)は立方体状のものが多く感覚に合う、判定が
// シンプルになる、可視化(rangeIndicator.ts)も高さごとに断面の大きさが変わらず済む、
// という理由から立方体に変更した。
export function isWithinNetworkRange(network: NetworkData, loc: Vector3, range: number): boolean {
  return (
    Math.abs(network.controller.x - loc.x) <= range &&
    Math.abs(network.controller.y - loc.y) <= range &&
    Math.abs(network.controller.z - loc.z) <= range
  );
}

// 範囲軸のTierダウン時、新しい範囲の外に出たメンバーを自動的に切断する
// (controllerAxes.tsのpruneRangeAxisMembersから呼ばれる。詳細はそちらのコメント参照)。
export function pruneOutOfRangeMembers(
  networkId: string,
  range: number
): { removedStorages: Vector3[]; removedTerminals: Vector3[]; removedObservers: Vector3[] } {
  const network = getNetwork(networkId);
  if (!network) return { removedStorages: [], removedTerminals: [], removedObservers: [] };

  const removedStorages = network.storages.filter((s) => !isWithinNetworkRange(network, s, range));
  const removedTerminals = network.terminals.filter((t) => !isWithinNetworkRange(network, t, range));
  const removedObservers = network.observers.filter((o) => !isWithinNetworkRange(network, o, range));
  for (const s of removedStorages) removeStorage(networkId, s);
  for (const t of removedTerminals) removeTerminal(networkId, t);
  for (const o of removedObservers) removeObserver(networkId, o);
  return { removedStorages, removedTerminals, removedObservers };
}

export function toggleStorage(networkId: string, loc: Vector3): "connected" | "disconnected" {
  const network = getNetwork(networkId);
  if (!network) throw new Error(`network not found: ${networkId}`);
  if (network.storages.some((s) => locEquals(s, loc))) {
    network.storages = network.storages.filter((s) => !locEquals(s, loc));
    setNetwork(network);
    return "disconnected";
  }
  network.storages.push(loc);
  setNetwork(network);
  return "connected";
}

export function toggleTerminal(networkId: string, loc: Vector3): "connected" | "disconnected" {
  const network = getNetwork(networkId);
  if (!network) throw new Error(`network not found: ${networkId}`);
  if (network.terminals.some((t) => locEquals(t, loc))) {
    network.terminals = network.terminals.filter((t) => !locEquals(t, loc));
    setNetwork(network);
    return "disconnected";
  }
  network.terminals.push(loc);
  setNetwork(network);
  return "connected";
}

export function toggleObserver(networkId: string, loc: Vector3): "connected" | "disconnected" {
  const network = getNetwork(networkId);
  if (!network) throw new Error(`network not found: ${networkId}`);
  if (network.observers.some((o) => locEquals(o, loc))) {
    network.observers = network.observers.filter((o) => !locEquals(o, loc));
    setNetwork(network);
    return "disconnected";
  }
  network.observers.push(loc);
  setNetwork(network);
  return "connected";
}

export function removeStorage(networkId: string, loc: Vector3): void {
  const network = getNetwork(networkId);
  if (!network) return;
  network.storages = network.storages.filter((s) => !locEquals(s, loc));
  setNetwork(network);
}

export function removeTerminal(networkId: string, loc: Vector3): void {
  const network = getNetwork(networkId);
  if (!network) return;
  network.terminals = network.terminals.filter((t) => !locEquals(t, loc));
  setNetwork(network);
}

export function removeObserver(networkId: string, loc: Vector3): void {
  const network = getNetwork(networkId);
  if (!network) return;
  network.observers = network.observers.filter((o) => !locEquals(o, loc));
  setNetwork(network);
}

export function getOrders(networkId: string): Order[] {
  return readJson<Order[]>(ordersKey(networkId)) ?? [];
}

export function setOrders(networkId: string, orders: Order[]): void {
  writeJson(ordersKey(networkId), orders);
}

export function getIssuing(networkId: string): IssuingEntry[] {
  return readJson<IssuingEntry[]>(issuingKey(networkId)) ?? [];
}

export function setIssuing(networkId: string, entries: IssuingEntry[]): void {
  writeJson(issuingKey(networkId), entries);
}

// キャンセル対象の引き出しrequestId一覧。通常のorders/issuingキューとは別の専用キューにして、
// processNetworkOrdersが毎tickの先頭で優先的に(=通常の処理順を待たず)消費する。
export function getOrderCancels(networkId: string): string[] {
  return readJson<string[]>(orderCancelsKey(networkId)) ?? [];
}

export function setOrderCancels(networkId: string, requestIds: string[]): void {
  writeJson(orderCancelsKey(networkId), requestIds);
}

// 「不足」記録は現状どのUIからも読み出されていない(将来のUI表示のための記録、8/9章参照)が、
// 上限なくpushし続けると動的プロパティの1件あたり文字数上限(32767)をいずれ超えて例外になる
// (実機で発見。自動端末等の定期チェックが慢性的な品薄品目に対して5秒おきに新しい引き出しを
// 発行し続けると、finalizeOrderのたびに際限なく積み上がる)。直近PARTIAL_HISTORY_LIMIT件だけ
// 保持するローリングウィンドウにして上限を防ぐ。
const PARTIAL_HISTORY_LIMIT = 20;

export function getPartial(networkId: string): PartialResult[] {
  return readJson<PartialResult[]>(partialKey(networkId)) ?? [];
}

export function appendPartial(networkId: string, result: PartialResult): void {
  const results = getPartial(networkId);
  results.push(result);
  writeJson(partialKey(networkId), results.slice(-PARTIAL_HISTORY_LIMIT));
}

export function getDeposits(networkId: string): DepositRequest[] {
  return readJson<DepositRequest[]>(depositsKey(networkId)) ?? [];
}

export function setDeposits(networkId: string, requests: DepositRequest[]): void {
  writeJson(depositsKey(networkId), requests);
}

export function getDepositIssuing(networkId: string): DepositIssuingEntry[] {
  return readJson<DepositIssuingEntry[]>(depositIssuingKey(networkId)) ?? [];
}

export function setDepositIssuing(networkId: string, entries: DepositIssuingEntry[]): void {
  writeJson(depositIssuingKey(networkId), entries);
}

// キャンセル対象の預け入れrequestId一覧。orderCancels(network.ts)と全く同じ発想の専用キュー。
export function getDepositCancels(networkId: string): string[] {
  return readJson<string[]>(depositCancelsKey(networkId)) ?? [];
}

export function setDepositCancels(networkId: string, requestIds: string[]): void {
  writeJson(depositCancelsKey(networkId), requestIds);
}

export function getDepositPartial(networkId: string): DepositPartialResult[] {
  return readJson<DepositPartialResult[]>(depositPartialKey(networkId)) ?? [];
}

export function appendDepositPartial(networkId: string, result: DepositPartialResult): void {
  const results = getDepositPartial(networkId);
  results.push(result);
  writeJson(depositPartialKey(networkId), results.slice(-PARTIAL_HISTORY_LIMIT));
}

// 整理リクエストは同時に1件まで(ボタン連打で重複キューイングしないよう submitOrganize 側で
// 制御する)。将来複数リクエストを認める場合も配列で保持しておけば構造変更は不要。
export function getOrganizeQueue(networkId: string): OrganizeRequest[] {
  return readJson<OrganizeRequest[]>(organizeKey(networkId)) ?? [];
}

export function setOrganizeQueue(networkId: string, requests: OrganizeRequest[]): void {
  writeJson(organizeKey(networkId), requests);
}

// キャンセル対象の整理requestId一覧。orderCancels/depositCancelsと全く同じ発想の専用キュー。
export function getOrganizeCancels(networkId: string): string[] {
  return readJson<string[]>(organizeCancelsKey(networkId)) ?? [];
}

export function setOrganizeCancels(networkId: string, requestIds: string[]): void {
  writeJson(organizeCancelsKey(networkId), requestIds);
}
