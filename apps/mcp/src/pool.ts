import { curbDeskAbi, curbHookAbi, readPoolKey, readStatus, type PoolKey, type Status } from "@curb/sdk";
import { erc20Abi, zeroAddress, type Address } from "viem";
import type { Context } from "./context";
import { labelOf, type PoolLabel } from "./known";

export interface Currency {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface Params {
  band: number;
  edge: number;
  refWindow: number;
  limitSeconds: number;
  haltSeconds: number;
  cooldownSeconds: number;
  minLiquidity: bigint;
}

export interface Pool {
  hook: Address;
  label?: PoolLabel;
  /** How the desk knows this hook: "launch", "drill", or "unbound" (the desk cannot file incidents for it). */
  deskBinding: "launch" | "drill" | "unbound";
  key: PoolKey;
  token: Currency;
  paired: Currency;
  tokenIs0: boolean;
  params: Params;
  name: string;
}

const DESK_KINDS = ["unbound", "launch", "drill"] as const;

async function currency(ctx: Context, address: Address): Promise<Currency> {
  if (address === zeroAddress) return { address, symbol: "ETH", decimals: 18 };
  const [symbol, decimals] = await Promise.all([
    ctx.client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    ctx.client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address, symbol, decimals };
}

function notCurbHook(hook: Address) {
  return (e: unknown): never => {
    const why = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    throw new Error(`${hook} does not answer as a Curb hook on Robinhood Chain (${why})`);
  };
}

/** The hook's status(), with a plain error when the address is not a Curb hook. */
export function readHookStatus(ctx: Context, hook: Address): Promise<Status> {
  return readStatus(ctx.client, hook).catch(notCurbHook(hook));
}

/** The pool behind a Curb hook: its key, which side is the launched token, and its breaker settings. */
export async function readPool(ctx: Context, hook: Address): Promise<Pool> {
  let key: PoolKey;
  let token: Address;
  let p;
  try {
    [key, token, p] = await Promise.all([
      readPoolKey(ctx.client, hook),
      ctx.client.readContract({ address: hook, abi: curbHookAbi, functionName: "token" }),
      ctx.client.readContract({ address: hook, abi: curbHookAbi, functionName: "params" }),
    ]);
  } catch (e) {
    throw new Error(`${hook} does not answer as a Curb hook on Robinhood Chain (${(e as Error).message.split("\n")[0]})`);
  }
  const tokenIs0 = key.currency0.toLowerCase() === token.toLowerCase();
  const [tokenC, pairedC, binding] = await Promise.all([
    currency(ctx, token),
    currency(ctx, tokenIs0 ? key.currency1 : key.currency0),
    ctx.client
      .readContract({ address: ctx.deployments.desk, abi: curbDeskAbi, functionName: "pools", args: [hook] })
      .then(([kind]) => DESK_KINDS[kind] ?? "unbound")
      .catch(() => "unbound" as const),
  ]);
  return {
    hook,
    label: labelOf(hook, ctx.deployments),
    deskBinding: binding,
    key,
    token: tokenC,
    paired: pairedC,
    tokenIs0,
    params: {
      band: p.bandTicks,
      edge: p.edgeTicks,
      refWindow: p.refWindow,
      limitSeconds: p.limitSeconds,
      haltSeconds: p.haltSeconds,
      cooldownSeconds: p.cooldownSeconds,
      minLiquidity: p.minLiquidity,
    },
    name: `${tokenC.symbol}/${pairedC.symbol}`,
  };
}
