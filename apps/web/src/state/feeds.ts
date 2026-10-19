import { useMemo } from "react";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { curbDeskAbi, readPoolKey, readStatus, type PoolKey, type Status } from "@curb/sdk";
import {
  client,
  deskEvents,
  hookEvents,
  poolEvents,
  poolIdOf,
  readLaunchState,
  readPair,
  readParams,
  readTreasury,
} from "../lib/chain";
import { DESK_FROM_BLOCK, deployments, livePools, POOLS, type PoolDef } from "../lib/deployments";
import type { FailedFiling } from "../lib/incidents";
import type { HookParams } from "../lib/phase";
import type { PairInfo } from "../lib/price";
import { mergeLogs, type ChainLog } from "../lib/timeline";
import { errorMessage, Feed, useFeed } from "./store";

/** Chain time minus local time, so countdowns follow the chain's clock, not the visitor's. */
export interface Clock {
  head: bigint;
  headTime: number;
  offset: number;
}

async function readClock(): Promise<Clock> {
  const b = await client.getBlock();
  return { head: b.number, headTime: Number(b.timestamp), offset: Number(b.timestamp) - Date.now() / 1000 };
}

export interface PoolState {
  def: PoolDef;
  hook: Address;
  key?: PoolKey;
  poolId?: Hex;
  pair?: PairInfo;
  params?: HookParams;
  status?: Status;
  clock?: Clock;
  /** Where the pool started: its first incident window opens here. */
  init?: { block: bigint; timestamp: number; tick: number };
  hookLogs: ChainLog[];
  swaps: ChainLog[];
  scannedTo?: bigint;
  error?: string;
  /** Local time of the last good refresh, in ms. */
  updatedAt?: number;
}

async function refreshPool(s: PoolState): Promise<PoolState> {
  let { key, poolId, pair, params } = s;
  if (!key || !pair || !params || !poolId) {
    key = await readPoolKey(client, s.hook);
    poolId = poolIdOf(key);
    [pair, params] = await Promise.all([readPair(s.hook, key), readParams(s.hook)]);
  }
  const [clock, status] = await Promise.all([readClock(), readStatus(client, s.hook)]);
  const from = s.scannedTo !== undefined ? s.scannedTo + 1n : s.def.fromBlock;
  let { hookLogs, swaps, init } = s;
  if (clock.head >= from) {
    const [h, p] = await Promise.all([hookEvents(s.hook, from, clock.head), poolEvents(poolId, from, clock.head)]);
    hookLogs = mergeLogs(hookLogs, h);
    swaps = mergeLogs(
      swaps,
      p.filter((l) => l.eventName === "Swap"),
    );
    const i = p.find((l) => l.eventName === "Initialize");
    if (i && !init) init = { block: i.blockNumber, timestamp: i.timestamp, tick: Number(i.args.tick) };
  }
  return {
    ...s,
    key,
    poolId,
    pair,
    params,
    status,
    clock,
    init,
    hookLogs,
    swaps,
    scannedTo: clock.head,
    error: undefined,
    updatedAt: Date.now(),
  };
}

const poolFeeds = new Map<string, Feed<PoolState>>();

export function poolFeed(def: PoolDef & { hook: Address }): Feed<PoolState> {
  let f = poolFeeds.get(def.hook);
  if (!f) {
    f = new Feed<PoolState>(
      { def, hook: def.hook, hookLogs: [], swaps: [] },
      refreshPool,
      (s, e) => ({ ...s, error: errorMessage(e) }),
    );
    poolFeeds.set(def.hook, f);
  }
  return f;
}

export function usePool(def: PoolDef & { hook: Address }): PoolState {
  return useFeed(poolFeed(def));
}

type LivePool = PoolDef & { hook: Address };

/**
 * The pools to show: those in the deployments file, plus a launch pool the desk has bound since the
 * site was built. The desk's Bound event is the authority on which hook is the launch's.
 */
export function useLivePools(): LivePool[] {
  const desk = useDesk();
  return useMemo(() => {
    const pools = livePools();
    const bound = desk.logs.find((l) => l.eventName === "Bound" && Number(l.args.kind) === 1);
    const launch = POOLS.find((p) => p.key === "launch");
    if (bound && launch && !pools.some((p) => p.key === "launch")) {
      pools.unshift({ ...launch, hook: bound.args.hook as Address, fromBlock: DESK_FROM_BLOCK });
    }
    return pools;
  }, [desk.logs]);
}

export function findPool(pools: readonly LivePool[], hook: Address): LivePool | undefined {
  return pools.find((p) => p.hook.toLowerCase() === hook.toLowerCase());
}

export interface DeskState {
  desk: Address;
  logs: ChainLog[];
  scannedTo?: bigint;
  treasury?: { balance: bigint; questionPrice: bigint | null };
  launch?: { state: number; bound: boolean; uri: string };
  failedFilings?: FailedFiling[];
  error?: string;
  updatedAt?: number;
}

/**
 * Reverted transactions leave no logs, so the desk's failed filings come from the recorded drill
 * proofs: each is checked on chain (reverted, sent to the desk, `fileIncident(hook)`) before it is
 * shown against an incident.
 */
async function readFailedFilings(desk: Address): Promise<FailedFiling[]> {
  const known: { hash: Hex; error: string }[] = [];
  const proof = deployments.proofs?.drill?.treasuryShort;
  if (proof) known.push({ hash: proof, error: "TreasuryShort" });
  const out: FailedFiling[] = [];
  for (const k of known) {
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: k.hash }),
      client.getTransactionReceipt({ hash: k.hash }),
    ]);
    if (receipt.status !== "reverted" || tx.to?.toLowerCase() !== desk.toLowerCase()) continue;
    const call = decodeFunctionData({ abi: curbDeskAbi, data: tx.input });
    if (call.functionName !== "fileIncident") continue;
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    out.push({
      hash: k.hash,
      hook: (call.args as readonly [Address])[0],
      block: receipt.blockNumber,
      timestamp: Number(block.timestamp),
      error: k.error,
    });
  }
  return out;
}

async function refreshDesk(s: DeskState): Promise<DeskState> {
  const head = await client.getBlockNumber();
  const from = s.scannedTo !== undefined ? s.scannedTo + 1n : DESK_FROM_BLOCK;
  const [logs, treasury, launch, failedFilings] = await Promise.all([
    head >= from ? deskEvents(s.desk, from, head) : Promise.resolve([]),
    readTreasury(s.desk),
    readLaunchState(s.desk),
    s.failedFilings ? Promise.resolve(s.failedFilings) : readFailedFilings(s.desk),
  ]);
  return {
    ...s,
    logs: mergeLogs(s.logs, logs),
    scannedTo: head,
    treasury,
    launch,
    failedFilings,
    error: undefined,
    updatedAt: Date.now(),
  };
}

export const deskFeed = new Feed<DeskState>(
  { desk: deployments.desk, logs: [] },
  refreshDesk,
  (s, e) => ({ ...s, error: errorMessage(e) }),
);

export const useDesk = () => useFeed(deskFeed);
