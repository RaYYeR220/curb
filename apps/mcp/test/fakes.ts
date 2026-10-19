import { ADDRESSES, curbHookAbi, curbRouterAbi, wrappedErrorAbi } from "@curb/sdk";
import { encodeErrorResult, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { vi } from "vitest";
import type { Context } from "../src/context";
import type { Deployments } from "../src/known";

export const DESK: Address = "0xa4dF8fbf3A1aB94795577c74fFae26E1d2083819";
export const ROUTER: Address = "0x040B0f37e4CcdB79e4A2cdA7a894800bbe73eD45";
export const DRILL_HOOK: Address = "0xeE60C95711F5650bbBBee421426820feC6e060c0";
export const DRILL_TOKEN: Address = "0x2c7852B54EFd464AD16D2C36c00b43Af8EA02DD3";
export const LAUNCH_HOOK: Address = "0x1111111111111111111111111111111111112080";
export const CURB: Address = "0x0000000000000000000000000000000000c0b0b0";

export const deployments: Deployments = {
  desk: DESK,
  router: ROUTER,
  drill: { drillHook: DRILL_HOOK, drillToken: DRILL_TOKEN },
  proofs: {
    drill: {
      outsideBand: "0xb650a39530addc0b7e9af4ff8246d0eddd1778d3d77201549134b3088480ebb4",
      treasuryShort: "0xb5e739198e9868f42f2510264755d495e42f1ff8202eadc889d3fac1cfe79ab7",
      haltClosed: "0x9de3edbec3a9433a18919fac13b2344760c04e1adcb166967fc20e7bbe15a9dd",
    },
  },
};

/** The drill pool as it stood after its halt closed: open, nonce 1, reference 230129. */
export function drillStatus(over: Record<string, unknown> = {}) {
  return {
    phase: 0,
    nonce: 1,
    ref: 230129,
    lower: 229829,
    upper: 230429,
    tick: 230129,
    edgeSince: 0n,
    haltStart: 0n,
    reopensAt: 0n,
    cooldownEnd: 1792438299n,
    pinUntil: 0n,
    verdict: 0,
    fromBlock: 92857518n,
    toBlock: 92861075n,
    windowVolume: 1066106246299n,
    ...over,
  };
}

export const drillParams = {
  bandTicks: 300,
  edgeTicks: 60,
  refWindow: 120,
  limitSeconds: 10,
  haltSeconds: 300,
  cooldownSeconds: 300,
  minLiquidity: 10n ** 18n,
  arbBlocks: true,
};

export const NOW = 1792438859;

export interface FakeChain {
  status?: ReturnType<typeof drillStatus>;
  key?: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  token?: Address;
  params?: typeof drillParams;
  tokens?: Record<string, { symbol: string; decimals: number }>;
  deskKind?: number;
  deskHooks?: Address[];
  treasury?: bigint;
  price?: bigint;
  now?: number;
  head?: bigint;
  simulate?: (args: readonly unknown[]) => Hex;
  events?: Record<string, unknown[]>;
}

/** A revert as viem throws it from eth_call: the data sits on a nested cause. */
export function revert(data: Hex): Error {
  return Object.assign(new Error("execution reverted"), { cause: { data } });
}

export function simulated(amount0: bigint, amount1: bigint, tickAfter: number): Hex {
  return encodeErrorResult({ abi: curbRouterAbi, errorName: "Simulated", args: [amount0, amount1, tickAfter] });
}

export function wrapped(hook: Address, reason: Hex): Hex {
  return encodeErrorResult({ abi: wrappedErrorAbi, errorName: "WrappedError", args: [hook, "0xb47b2fb1", reason, "0xa9e35b2f"] });
}

export function outsideBand(ref: number, tickAfter: number, limit: number, zeroForOne: boolean, hook: Address = DRILL_HOOK): Hex {
  return wrapped(hook, encodeErrorResult({ abi: curbHookAbi, errorName: "OutsideBand", args: [ref, tickAfter, limit, zeroForOne] }));
}

export function fakeClient(f: FakeChain = {}) {
  const status = f.status ?? drillStatus();
  const key = f.key ?? { currency0: zeroAddress, currency1: DRILL_TOKEN, fee: 12500, tickSpacing: 60, hooks: DRILL_HOOK };
  const tokens: Record<string, { symbol: string; decimals: number }> = {
    [DRILL_TOKEN.toLowerCase()]: { symbol: "DRILL", decimals: 18 },
    [CURB.toLowerCase()]: { symbol: "CURB", decimals: 18 },
    [ADDRESSES.imd.toLowerCase()]: { symbol: "IMD", decimals: 18 },
    ...f.tokens,
  };
  const readContract = vi.fn(async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    switch (functionName) {
      case "status":
        return status;
      case "poolKey":
        return key;
      case "token":
        return f.token ?? DRILL_TOKEN;
      case "params":
        return f.params ?? drillParams;
      case "symbol":
        return tokens[address.toLowerCase()]!.symbol;
      case "decimals":
        return tokens[address.toLowerCase()]!.decimals;
      case "pools":
        return [f.deskKind ?? 2, 0n];
      case "hookCount":
        return BigInt((f.deskHooks ?? [DRILL_HOOK]).length);
      case "hooks":
        return (f.deskHooks ?? [DRILL_HOOK])[Number(args![0])];
      case "balanceOf":
        return f.treasury ?? 0n;
      case "priceOf":
        return f.price ?? 500000000000000000n;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  });
  const simulateContract = vi.fn(async ({ args }: { args: readonly unknown[] }) => {
    if (!f.simulate) throw new Error("no simulate configured");
    throw revert(f.simulate(args));
  });
  const getContractEvents = vi.fn(async ({ eventName }: { eventName: string }) => f.events?.[eventName] ?? []);
  const client = {
    readContract,
    simulateContract,
    getContractEvents,
    getBlock: vi.fn(async () => ({ number: f.head ?? 92_870_000n, timestamp: BigInt(f.now ?? NOW) })),
    getBlockNumber: vi.fn(async () => f.head ?? 92_870_000n),
    getTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(),
    call: vi.fn(),
  };
  return client;
}

export function fakeContext(client: ReturnType<typeof fakeClient>, over: Partial<Context> = {}): Context {
  return {
    client: client as unknown as PublicClient,
    fetch: vi.fn() as unknown as typeof fetch,
    imdApi: "https://api.imd.fun",
    deployments,
    checkTimeoutMs: 5_000,
    ...over,
  };
}

/** A log as viem's getContractEvents returns it, with only the fields the tools read. */
export function log(eventName: string, args: Record<string, unknown>, tx: Hex, blockNumber = 92_860_000n) {
  return { eventName, args, transactionHash: tx, blockNumber };
}
