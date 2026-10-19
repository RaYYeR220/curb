import type { CurbError, Preview } from "@curb/sdk";
import { formatAmount, formatClock, formatTick } from "./format";
import { formatPercent, isCurveEnd, movePercent, type PairInfo } from "./price";

export type Side = "buy" | "sell";

/**
 * Which way a swap runs. Buying the token pays in the paired currency, so it is zeroForOne exactly
 * when the paired currency is currency0.
 */
export function zeroForOneFor(side: Side, tokenIs0: boolean): boolean {
  return side === "buy" ? !tokenIs0 : tokenIs0;
}

/** v4's sign convention: a negative amountSpecified is an exact input. */
export function exactInput(amount: bigint): bigint {
  return -amount;
}

/** The currency a side pays in. */
export function payCurrency(side: Side, pair: PairInfo) {
  return side === "buy" ? pair.paired : pair.token;
}

export function receiveCurrency(side: Side, pair: PairInfo) {
  return side === "buy" ? pair.token : pair.paired;
}

/** A decoded error as the call it was: `OutsideBand(ref: 1, tickAfter: 2, limit: 3, zeroForOne: true)`. */
export function formatRevert(err: Pick<CurbError, "name" | "args">): string {
  const args = Object.entries(err.args)
    .map(([k, v]) => `${k}: ${typeof v === "bigint" ? v.toString() : String(v)}`)
    .join(", ");
  return `${err.name}(${args})`;
}

export type Outcome = "pass" | "refused" | "halted" | "unknown";

export interface PreviewView {
  outcome: Outcome;
  title: string;
  /** The hook's own sentence for a refusal, or ours for a pass. */
  sentence: string;
  /** Where the price would sit after the swap, in plain words. */
  detail?: string;
  revert?: string;
  tickAfter?: number;
  limit?: number;
  ref?: number;
  received?: string;
}

export interface PreviewContext {
  side: Side;
  pair: PairInfo;
  tick: number;
  ref: number;
}

export function previewView(p: Preview, ctx: PreviewContext): PreviewView {
  const { pair } = ctx;
  if (p.ok) {
    const out = receiveCurrency(ctx.side, pair);
    const outIs0 = ctx.side === "buy" ? pair.tokenIs0 : !pair.tokenIs0;
    const got = outIs0 ? p.amount0 : p.amount1;
    const received = `${formatAmount(got < 0n ? -got : got, out.decimals)} ${out.symbol}`;
    const fromRef = movePercent(ctx.ref, p.tickAfter, pair.tokenIs0);
    return {
      outcome: "pass",
      title: "Would pass",
      sentence: `Would pass, ending at tick ${formatTick(p.tickAfter)} and receiving ${received}.`,
      detail: `${pair.token.symbol} would end ${formatPercent(fromRef)} from the reference, inside the band.`,
      tickAfter: p.tickAfter,
      received,
    };
  }
  const err = p.error;
  if (!err) {
    return {
      outcome: "unknown",
      title: "No answer",
      sentence: p.raw
        ? "The pool reverted with an error Curb does not recognise."
        : "No answer from Robinhood Chain's RPC. Check the connection and ask again.",
      revert: p.raw,
    };
  }
  if (err.name === "OutsideBand") {
    const tickAfter = Number(err.args.tickAfter);
    const limit = Number(err.args.limit);
    const ref = Number(err.args.ref);
    const past = movePercent(limit, tickAfter, pair.tokenIs0);
    const band = movePercent(ref, limit, pair.tokenIs0);
    const detail = isCurveEnd(tickAfter)
      ? `It would run through every position in range to the end of the curve; the band's limit is ${formatPercent(band)} from the reference.`
      : `It would take ${pair.token.symbol} ${formatPercent(past)} past the band's limit, which sits ${formatPercent(band)} from the reference.`;
    return {
      outcome: "refused",
      title: "Refused",
      sentence: err.human,
      detail: `${detail} Nothing changed: the hook reverted the whole swap.`,
      revert: formatRevert(err),
      tickAfter,
      limit,
      ref,
    };
  }
  if (err.name === "Halted") {
    return {
      outcome: "halted",
      title: "Halted",
      sentence: err.human,
      detail: `Every swap is refused both ways until ${formatClock(Number(err.args.reopensAt))} at the latest.`,
      revert: formatRevert(err),
    };
  }
  return { outcome: "unknown", title: "Refused", sentence: err.human, revert: formatRevert(err) };
}

/** Rounds down to `sig` significant digits, so a suggested size is one a person would type. */
export function roundDownSig(x: bigint, sig = 3): bigint {
  const digits = x.toString().length;
  if (digits <= sig) return x;
  const f = 10n ** BigInt(digits - sig);
  return (x / f) * f;
}

/**
 * The largest exact input that still passes, found by asking the pool: a coarse walk down by
 * factors of ten from a refused size, then bisection. `fits` is one eth_call per question.
 */
export async function largestFit(
  fits: (amount: bigint) => Promise<boolean>,
  refused: bigint,
  opts: { decades?: number; steps?: number; cancelled?: () => boolean } = {},
): Promise<bigint | null> {
  const { decades = 10, steps = 12, cancelled = () => false } = opts;
  let hi = refused;
  let lo = 0n;
  let probe = refused / 10n;
  for (let i = 0; i < decades && probe > 0n; i++) {
    if (cancelled()) return null;
    if (await fits(probe)) {
      lo = probe;
      break;
    }
    hi = probe;
    probe /= 10n;
  }
  if (lo === 0n) return null;
  for (let i = 0; i < steps && hi - lo > 1n; i++) {
    if (cancelled()) return null;
    const mid = (lo + hi) / 2n;
    if (await fits(mid)) lo = mid;
    else hi = mid;
  }
  return roundDownSig(lo);
}
