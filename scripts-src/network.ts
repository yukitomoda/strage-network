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
function partialKey(id: string): string {
  return `wh:partial:${id}`;
}
function depositsKey(id: string): string {
  return `wh:deposits:${id}`;
}
function depositIssuingKey(id: string): string {
  return `wh:deposit_issuing:${id}`;
}
function depositPartialKey(id: string): string {
  return `wh:deposit_partial:${id}`;
}
function organizeKey(id: string): string {
  return `wh:organize:${id}`;
}

export function getNetworkIds(): string[] {
  return readJson<string[]>(NETWORK_IDS_KEY) ?? [];
}

function setNetworkIds(ids: string[]): void {
  writeJson(NETWORK_IDS_KEY, ids);
}

export function getNetwork(id: string): NetworkData | undefined {
  return readJson<NetworkData>(networkKey(id));
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
  clearProperty(partialKey(id));
  clearProperty(depositsKey(id));
  clearProperty(depositIssuingKey(id));
  clearProperty(depositPartialKey(id));
  clearProperty(organizeKey(id));
}

export function findNetworkByController(dimensionId: string, loc: Vector3): NetworkData | undefined {
  return getAllNetworks().find(
    (network) => network.dimensionId === dimensionId && locEquals(network.controller, loc)
  );
}

export type MemberRole = "controller" | "storage" | "terminal";

export function findMembership(
  dimensionId: string,
  loc: Vector3
): { network: NetworkData; role: MemberRole } | undefined {
  for (const network of getAllNetworks()) {
    if (network.dimensionId !== dimensionId) continue;
    if (locEquals(network.controller, loc)) return { network, role: "controller" };
    if (network.storages.some((s) => locEquals(s, loc))) return { network, role: "storage" };
    if (network.terminals.some((t) => locEquals(t, loc))) return { network, role: "terminal" };
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

function containersShareStorage(a: Container, b: Container): boolean {
  if (a.size !== b.size || a.size === 0) return false;

  // 空きスロットを探す必要はない。どのスロットも「元の中身を退避 -> 目印を書き込んで
  // 確認 -> 必ず元に戻す」という手順にすれば、満杯のコンテナでも判定できる。
  // 倉庫アドオンでは大量にアイテムを詰め込んだコンテナを接続することが普通なので、
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

export function findAdjacentConnectedStorage(
  dimension: Dimension,
  network: NetworkData,
  loc: Vector3
): Vector3 | undefined {
  const container = dimension.getBlock(loc)?.getComponent("inventory")?.container;
  if (!container || container.size <= SINGLE_CONTAINER_MAX_SIZE) return undefined;

  const neighbors: Vector3[] = [
    { x: loc.x + 1, y: loc.y, z: loc.z },
    { x: loc.x - 1, y: loc.y, z: loc.z },
    { x: loc.x, y: loc.y, z: loc.z + 1 },
    { x: loc.x, y: loc.y, z: loc.z - 1 },
  ];
  for (const n of neighbors) {
    if (!network.storages.some((s) => locEquals(s, n))) continue;
    const neighborContainer = dimension.getBlock(n)?.getComponent("inventory")?.container;
    if (neighborContainer && containersShareStorage(container, neighborContainer)) return n;
  }
  return undefined;
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

export function getPartial(networkId: string): PartialResult[] {
  return readJson<PartialResult[]>(partialKey(networkId)) ?? [];
}

export function appendPartial(networkId: string, result: PartialResult): void {
  const results = getPartial(networkId);
  results.push(result);
  writeJson(partialKey(networkId), results);
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

export function getDepositPartial(networkId: string): DepositPartialResult[] {
  return readJson<DepositPartialResult[]>(depositPartialKey(networkId)) ?? [];
}

export function appendDepositPartial(networkId: string, result: DepositPartialResult): void {
  const results = getDepositPartial(networkId);
  results.push(result);
  writeJson(depositPartialKey(networkId), results);
}

// 整理リクエストは同時に1件まで(ボタン連打で重複キューイングしないよう submitOrganize 側で
// 制御する)。将来複数リクエストを認める場合も配列で保持しておけば構造変更は不要。
export function getOrganizeQueue(networkId: string): OrganizeRequest[] {
  return readJson<OrganizeRequest[]>(organizeKey(networkId)) ?? [];
}

export function setOrganizeQueue(networkId: string, requests: OrganizeRequest[]): void {
  writeJson(organizeKey(networkId), requests);
}
