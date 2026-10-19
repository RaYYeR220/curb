import { decodeErrorResult, formatUnits, type Abi, type Address, type Hex } from "viem";
import { curbDeskAbi, curbHookAbi, curbRouterAbi, wrappedErrorAbi } from "./abis";

export interface CurbError {
  name: string;
  args: Record<string, unknown>;
  /** One sentence a trader or an agent can act on. */
  human: string;
  /** The hook that refused, when the error came through v4's WrappedError. */
  hook?: Address;
}

const errorsAbi = [...curbHookAbi, ...curbDeskAbi, ...curbRouterAbi, ...wrappedErrorAbi].filter(
  (x) => x.type === "error",
) as Abi;

function named(abiItem: { inputs?: readonly { name?: string }[] } | undefined, args: readonly unknown[] | undefined) {
  const out: Record<string, unknown> = {};
  (abiItem?.inputs ?? []).forEach((input, i) => {
    out[input.name || String(i)] = args?.[i];
  });
  return out;
}

const imd = (wei: unknown) => `${formatUnits(BigInt(wei as bigint), 18)} IMD`;
const utc = (seconds: unknown) => new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");

function explain(name: string, a: Record<string, unknown>): string {
  switch (name) {
    case "OutsideBand": {
      const side = Number(a.tickAfter) > Number(a.ref) ? "upper" : "lower";
      return (
        `Refused: the swap would end at tick ${a.tickAfter}, past the band's ${side} limit ${a.limit} ` +
        `(reference ${a.ref}). Split the order or set a price limit inside the band.`
      );
    }
    case "Halted":
      return `Halted: incident ${a.nonce} is in progress. Trading reopens by ${utc(a.reopensAt)} at the latest.`;
    case "TreasuryShort":
      return `The desk holds ${imd(a.have)} and needs ${imd(a.need)} to pay for the oracle's verdict.`;
    case "NotHalted":
      return "The pool is not halted, so there is no incident to file or resolve.";
    case "AlreadyFiled":
      return `Incident ${a.nonce} has already been filed with the oracle.`;
    case "WindowTooFresh":
      return `The incident's last block (${a.toBlock}) is too recent for the oracle; try again in a few seconds.`;
    case "PriceAboveCap":
      return `IMD lists ${imd(a.price)} for this request, above the desk's cap of ${imd(a.cap)}.`;
    case "Simulated":
      return `Would pass: amount0 ${a.amount0}, amount1 ${a.amount1}, ending at tick ${a.tickAfter}.`;
    default:
      return name;
  }
}

/** Decodes a revert from a Curb pool, the desk or the router, unwrapping v4's WrappedError. */
export function decodeCurbError(data: Hex): CurbError | null {
  if (!data || data.length < 10) return null;
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: errorsAbi, data });
  } catch {
    return null;
  }
  const args = named(decoded.abiItem as { inputs?: readonly { name?: string }[] }, decoded.args as readonly unknown[]);
  if (decoded.errorName === "WrappedError") {
    const inner = decodeCurbError(args.reason as Hex);
    const target = args.target as Address;
    if (inner) return { ...inner, hook: inner.hook ?? target };
    return { name: "WrappedError", args, human: `The hook at ${target} reverted.`, hook: target };
  }
  return { name: decoded.errorName, args, human: explain(decoded.errorName, args) };
}
