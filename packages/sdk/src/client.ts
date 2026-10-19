import { createPublicClient, defineChain, http, type Address, type Hex, type PublicClient } from "viem";
import { curbHookAbi, curbRouterAbi } from "./abis";
import { decodeCurbError, type CurbError } from "./errors";
import { Phase, Verdict } from "./model";

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Etherscan", url: "https://robin.etherscan.io" } },
});

export const ADDRESSES = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  intake: "0xa43e6F75ee006411F79Ac1C84120606C2330DE82",
  launchFactory: "0xA25B02A1e93903b790E6aaf7dA1b8B8d50294645",
  imd: "0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127",
  oracleSigner: "0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982",
} as const satisfies Record<string, Address>;

export const MIN_SQRT_PRICE_PLUS_ONE = 4295128740n;
export const MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341n;

export function curbClient(rpc?: string): PublicClient {
  return createPublicClient({ chain: robinhood, transport: http(rpc) }) as PublicClient;
}

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface Status {
  phase: Phase;
  phaseName: string;
  nonce: number;
  ref: number;
  lower: number;
  upper: number;
  tick: number;
  edgeSince: number;
  haltStart: number;
  reopensAt: number;
  cooldownEnd: number;
  pinUntil: number;
  verdict: Verdict;
  fromBlock: bigint;
  toBlock: bigint;
  windowVolume: bigint;
}

export const PHASE_NAMES = ["open", "limit", "halted", "cooldown"] as const;
export const VERDICT_NAMES = ["none", "organic", "concentrated", "inconclusive"] as const;

export async function readStatus(client: PublicClient, hook: Address): Promise<Status> {
  const s = await client.readContract({ address: hook, abi: curbHookAbi, functionName: "status" });
  return {
    phase: s.phase as Phase,
    phaseName: PHASE_NAMES[s.phase] ?? String(s.phase),
    nonce: s.nonce,
    ref: s.ref,
    lower: s.lower,
    upper: s.upper,
    tick: s.tick,
    edgeSince: Number(s.edgeSince),
    haltStart: Number(s.haltStart),
    reopensAt: Number(s.reopensAt),
    cooldownEnd: Number(s.cooldownEnd),
    pinUntil: Number(s.pinUntil),
    verdict: s.verdict as Verdict,
    fromBlock: s.fromBlock,
    toBlock: s.toBlock,
    windowVolume: s.windowVolume,
  };
}

export async function readPoolKey(client: PublicClient, hook: Address): Promise<PoolKey> {
  const k = await client.readContract({ address: hook, abi: curbHookAbi, functionName: "poolKey" });
  return { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks };
}

export type Preview =
  | { ok: true; amount0: bigint; amount1: bigint; tickAfter: number }
  | { ok: false; error: CurbError | null; raw: Hex | undefined };

/**
 * Asks the pool what it would do with a swap, without sending one: CurbRouter.simulate always
 * reverts, with Simulated(...) when the swap would pass or with the hook's reason when it would not.
 * Works from any address, with no balance or approval.
 */
export async function previewSwap(
  client: PublicClient,
  router: Address,
  key: PoolKey,
  zeroForOne: boolean,
  amountSpecified: bigint,
  sqrtPriceLimitX96: bigint = zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE,
): Promise<Preview> {
  try {
    await client.simulateContract({
      address: router,
      abi: curbRouterAbi,
      functionName: "simulate",
      args: [key, zeroForOne, amountSpecified, sqrtPriceLimitX96],
    });
  } catch (e) {
    const raw = revertData(e);
    const error = raw ? decodeCurbError(raw) : null;
    if (error?.name === "Simulated") {
      return {
        ok: true,
        amount0: error.args.amount0 as bigint,
        amount1: error.args.amount1 as bigint,
        tickAfter: Number(error.args.tickAfter),
      };
    }
    return { ok: false, error, raw };
  }
  return { ok: false, error: null, raw: undefined };
}

/** The revert data inside a viem error, wherever it is nested. */
export function revertData(e: unknown): Hex | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur; i++) {
    const c = cur as { data?: unknown; raw?: unknown; cause?: unknown };
    if (typeof c.raw === "string" && c.raw.startsWith("0x")) return c.raw as Hex;
    if (typeof c.data === "string" && c.data.startsWith("0x")) return c.data as Hex;
    if (c.data && typeof (c.data as { data?: unknown }).data === "string") return (c.data as { data: Hex }).data;
    cur = c.cause;
  }
  return undefined;
}
