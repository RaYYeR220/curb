import { deployments } from "@curb/sdk";
import { isAddress, stringToHex, type Address, type Hex } from "viem";

/** What deployments/4663.json holds once the launch has landed; every field past the core is optional. */
export interface Deployments {
  desk: Address;
  router: Address;
  steward?: Address;
  drill?: { drillHook: Address; drillToken: Address };
  launch?: { hook?: Address; token?: Address; payment?: Hex; requestId?: Hex; job?: string; baseCommit?: string };
  proofs?: { drill?: Partial<Record<"outsideBand" | "limitEntered" | "halted" | "treasuryShort" | "haltClosed", Hex>> };
}

export const DEPLOYMENTS = deployments as unknown as Deployments;

export const EXPLORER = "https://robin.etherscan.io";
export const IMD_API = "https://api.imd.fun";
export const CHAIN_ID = 4663;

/** The router, Curb's first contract on Robinhood Chain, was created in this L2 block. */
export const FIRST_BLOCK = 92_855_471n;
/** The public RPC refuses eth_getLogs spans over 10,000,000 blocks. */
export const LOG_SPAN = 9_000_000n;

export const ACTIONS = {
  oracleRequest: stringToHex("oracle.request@oracle-1", { size: 32 }),
  launchOpen: stringToHex("launch.open@launch-1", { size: 32 }),
} as const;

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;

export type PoolLabel = "launch" | "drill";

export interface KnownPool {
  label: PoolLabel;
  hook: Address;
}

export function knownPools(d: Deployments = DEPLOYMENTS): KnownPool[] {
  const out: KnownPool[] = [];
  if (d.launch?.hook) out.push({ label: "launch", hook: d.launch.hook });
  if (d.drill?.drillHook) out.push({ label: "drill", hook: d.drill.drillHook });
  return out;
}

/** An address, or "launch" / "drill"; nothing given means the launch pool once it exists, else the drill. */
export function resolveHook(input: string | undefined, d: Deployments = DEPLOYMENTS): Address {
  const pools = knownPools(d);
  if (!input) {
    const first = pools[0];
    if (!first) throw new Error("No Curb pool is known yet; pass a hook address.");
    return first.hook;
  }
  const named = pools.find((p) => p.label === input.toLowerCase());
  if (named) return named.hook;
  if (isAddress(input, { strict: false })) return input as Address;
  throw new Error(`"${input}" is neither a hook address nor one of: ${pools.map((p) => p.label).join(", ")}.`);
}

export function labelOf(hook: Address, d: Deployments = DEPLOYMENTS): PoolLabel | undefined {
  return knownPools(d).find((p) => p.hook.toLowerCase() === hook.toLowerCase())?.label;
}

