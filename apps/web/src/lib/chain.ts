import {
  encodeAbiParameters,
  erc20Abi,
  keccak256,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ADDRESSES, curbClient, curbDeskAbi, curbHookAbi, robinhood, type PoolKey } from "@curb/sdk";
import { blockRanges } from "./logs";
import type { ChainLog } from "./timeline";
import type { HookParams } from "./phase";
import type { PairInfo } from "./price";

/** The hosted site reads through its own `/rpc` (VITE_RPC=rpc), because the public endpoint
 * sometimes sends its CORS header twice and browsers then refuse the answer. A value that is not
 * an http(s) URL is a path on the site's own origin. */
function rpcUrl(): string | undefined {
  const rpc = import.meta.env.VITE_RPC as string | undefined;
  if (!rpc) return undefined;
  return /^https?:\/\//.test(rpc) ? rpc : new URL(rpc, `${window.location.origin}/`).href;
}

export const client: PublicClient = curbClient(rpcUrl());

const EXPLORER = robinhood.blockExplorers.default.url;
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;
export const blockUrl = (n: bigint | number) => `${EXPLORER}/block/${n}`;

/** The two PoolManager events the board reads: where a pool started, and every swap's tick. */
export const poolManagerEvents = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

const intakeAbi = parseAbi(["function priceOf(bytes32 action, address asset) view returns (uint256)"]);

/** v4's PoolId: the hash of the ABI-encoded key. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

type RawLog = {
  eventName?: string;
  args?: unknown;
  address: Address;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
  blockTimestamp?: bigint | number | Hex | null;
};

const timestamps = new Map<bigint, number>();

/** Flattens logs and stamps each with its block's time, fetching each block at most once. */
async function flatten(logs: readonly RawLog[]): Promise<ChainLog[]> {
  const out: ChainLog[] = [];
  for (const l of logs) {
    if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
    // Robinhood's RPC sends blockTimestamp as 0x0, so zero means "ask the block".
    let ts: number | undefined = l.blockTimestamp ? Number(l.blockTimestamp) || undefined : undefined;
    ts ??= timestamps.get(l.blockNumber);
    if (ts === undefined) {
      ts = Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp);
    }
    timestamps.set(l.blockNumber, ts);
    out.push({
      eventName: l.eventName ?? "",
      args: (l.args ?? {}) as Record<string, unknown>,
      address: l.address,
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      transactionHash: l.transactionHash,
      timestamp: ts,
    });
  }
  return out;
}

async function contractEvents(
  address: Address,
  abi: Abi,
  from: bigint,
  to: bigint,
  filter?: { eventName: string; args: Record<string, unknown> },
) {
  const out: ChainLog[] = [];
  for (const [a, b] of blockRanges(from, to)) {
    // Every event of a contract would go out as a list of topics, which the RPC caps at 100,000
    // blocks; asking by address alone keeps the 10,000,000-block limit, and the ABI sorts them here.
    const logs = filter
      ? await client.getContractEvents({ address, abi, fromBlock: a, toBlock: b, ...filter } as never)
      : parseEventLogs({ abi, logs: await client.getLogs({ address, fromBlock: a, toBlock: b }) });
    out.push(...(await flatten(logs as unknown as RawLog[])));
  }
  return out;
}

export const hookEvents = (hook: Address, from: bigint, to: bigint) => contractEvents(hook, curbHookAbi as Abi, from, to);
export const deskEvents = (desk: Address, from: bigint, to: bigint) => contractEvents(desk, curbDeskAbi as Abi, from, to);

/** One pool's Initialize and Swap events, filtered by its id on the node. */
export async function poolEvents(id: Hex, from: bigint, to: bigint): Promise<ChainLog[]> {
  const [init, swaps] = await Promise.all([
    contractEvents(ADDRESSES.poolManager, poolManagerEvents as Abi, from, to, { eventName: "Initialize", args: { id } }),
    contractEvents(ADDRESSES.poolManager, poolManagerEvents as Abi, from, to, { eventName: "Swap", args: { id } }),
  ]);
  return [...init, ...swaps];
}

export async function readParams(hook: Address): Promise<HookParams> {
  const p = await client.readContract({ address: hook, abi: curbHookAbi, functionName: "params" });
  return { ...p };
}

async function currencyInfo(c: Address): Promise<{ symbol: string; decimals: number }> {
  if (c === zeroAddress) return { symbol: "ETH", decimals: 18 };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: c, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: c, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

/** Which side of the key is the launched token, and both currencies' symbols and decimals. */
export async function readPair(hook: Address, key: PoolKey): Promise<PairInfo> {
  const token = await client.readContract({ address: hook, abi: curbHookAbi, functionName: "token" });
  const tokenIs0 = key.currency0.toLowerCase() === token.toLowerCase();
  const [c0, c1] = await Promise.all([currencyInfo(key.currency0), currencyInfo(key.currency1)]);
  return tokenIs0 ? { token: c0, paired: c1, tokenIs0 } : { token: c1, paired: c0, tokenIs0 };
}

/** What the desk holds, and what one oracle question costs it. */
export async function readTreasury(desk: Address): Promise<{ balance: bigint; questionPrice: bigint | null }> {
  const balance = await client.readContract({ address: ADDRESSES.imd, abi: erc20Abi, functionName: "balanceOf", args: [desk] });
  let questionPrice: bigint | null = null;
  try {
    const action = await client.readContract({ address: desk, abi: curbDeskAbi, functionName: "ORACLE_REQUEST" });
    questionPrice = await client.readContract({ address: ADDRESSES.intake, abi: intakeAbi, functionName: "priceOf", args: [action, ADDRESSES.imd] });
  } catch {
    questionPrice = null;
  }
  return { balance, questionPrice };
}

export async function readLaunchState(desk: Address): Promise<{ state: number; bound: boolean; uri: string }> {
  const [state, bound, uri] = await Promise.all([
    client.readContract({ address: desk, abi: curbDeskAbi, functionName: "launchState" }),
    client.readContract({ address: desk, abi: curbDeskAbi, functionName: "launchBound" }),
    client.readContract({ address: desk, abi: curbDeskAbi, functionName: "launchUri" }),
  ]);
  return { state: Number(state), bound, uri };
}
