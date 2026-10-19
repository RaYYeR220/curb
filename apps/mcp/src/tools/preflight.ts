import { previewSwap, type Preview } from "@curb/sdk";
import { parseUnits } from "viem";
import type { Context } from "../context";
import { amount, iso } from "../format";
import { resolveHook } from "../known";
import { readHookStatus, readPool } from "../pool";
import { getSqrtPriceAtTick, MAX_TICK, MIN_TICK } from "../tickmath";

export interface PreflightInput {
  hook?: string;
  side: "buy" | "sell";
  amount: string;
  limitTick?: number;
}

interface Fill {
  pay: string;
  receive: string;
  tickAfter: number;
}

export async function curbPreflight(ctx: Context, input: PreflightInput) {
  const hook = resolveHook(input.hook, ctx.deployments);
  const [pool, s] = await Promise.all([readPool(ctx, hook), readHookStatus(ctx, hook)]);
  const router = ctx.deployments.router;
  const buy = input.side === "buy";
  const payC = buy ? pool.paired : pool.token;
  const getC = buy ? pool.token : pool.paired;
  // The swap sells currency0 for currency1 when the input is currency0, which pushes the tick down.
  const zeroForOne = buy ? !pool.tokenIs0 : pool.tokenIs0;
  const direction = zeroForOne ? "down" : "up";

  let exactIn: bigint;
  try {
    exactIn = parseUnits(input.amount, payC.decimals);
  } catch {
    throw new Error(`"${input.amount}" is not a decimal amount of ${payC.symbol}.`);
  }
  if (exactIn <= 0n) throw new Error("amount must be greater than zero.");

  let limit: bigint | undefined;
  if (input.limitTick !== undefined) {
    const t = input.limitTick;
    if (t <= MIN_TICK || t >= MAX_TICK) throw new Error(`limitTick must lie strictly between ${MIN_TICK} and ${MAX_TICK}.`);
    if (zeroForOne ? t > s.tick : t <= s.tick) {
      throw new Error(
        `A ${input.side} on ${pool.name} moves the tick ${direction} from ${s.tick}, so limitTick must be ${zeroForOne ? "below" : "above"} it.`,
      );
    }
    limit = getSqrtPriceAtTick(t);
  }

  const fill = (p: Extract<Preview, { ok: true }>): Fill => {
    const [d0, d1] = [p.amount0, p.amount1];
    const paid = zeroForOne ? d0 : d1;
    const got = zeroForOne ? d1 : d0;
    return { pay: amount(paid, payC.decimals, payC.symbol), receive: amount(got, getC.decimals, getC.symbol), tickAfter: p.tickAfter };
  };

  const preview = await previewSwap(ctx.client, router, pool.key, zeroForOne, -exactIn, limit);
  const base = {
    hook,
    pool: pool.name,
    side: input.side,
    requested: amount(exactIn, payC.decimals, payC.symbol),
    tickBefore: s.tick,
    direction,
    band: { reference: s.ref, lower: s.lower, upper: s.upper },
  };

  if (preview.ok) {
    const f = fill(preview);
    const paidRaw = -(zeroForOne ? preview.amount0 : preview.amount1);
    const partial = paidRaw < exactIn;
    const edgeDist = pool.params.band - pool.params.edge;
    const inEdge = Math.abs(f.tickAfter - s.ref) >= edgeDist;
    const notes: string[] = [];
    if (partial) notes.push(`The price limit stops the swap early: it takes ${f.pay} of the ${base.requested} asked.`);
    if (inEdge) {
      notes.push(
        `It ends in the edge zone (${edgeDist}+ ticks from the reference ${s.ref}). If the price stays there for ` +
          `${pool.params.limitSeconds}s the pool halts both ways for up to ${pool.params.haltSeconds}s.`,
      );
    }
    return {
      wouldPass: true,
      summary: `Would pass: pay ${f.pay}, receive ${f.receive}; tick ${s.tick} -> ${f.tickAfter} (band ${s.lower}..${s.upper}).`,
      ...base,
      pay: f.pay,
      receive: f.receive,
      tickAfter: f.tickAfter,
      partialFill: partial,
      endsInEdgeZone: inEdge,
      notes,
    };
  }

  const err = preview.error;
  if (!err) {
    return {
      wouldPass: false,
      summary: "Refused with revert data the Curb ABIs do not name; pass it to curb_explain_revert or check the pool key and amount.",
      ...base,
      reason: "unknown",
      raw: preview.raw ?? null,
    };
  }

  const out = {
    wouldPass: false,
    summary: err.human,
    ...base,
    reason: err.name,
    args: err.args,
    raw: preview.raw ?? null,
  };

  if (err.name === "OutsideBand") {
    const ref = Number(err.args.ref);
    const bandLimit = Number(err.args.limit);
    const edgeDist = pool.params.band - pool.params.edge;
    // One tick inside each boundary: a downward swap that stops exactly on an initialised tick crosses it.
    const toBand = zeroForOne ? bandLimit + 1 : bandLimit - 1;
    const toEdge = zeroForOne ? ref - edgeDist + 1 : ref + edgeDist - 1;
    const reachable = (t: number) => (zeroForOne ? t < s.tick : t > s.tick);
    const capped = async (t: number) => {
      if (!reachable(t)) return null;
      const p = await previewSwap(ctx.client, router, pool.key, zeroForOne, -exactIn, getSqrtPriceAtTick(t));
      return p.ok ? { limitTick: t, ...fill(p) } : null;
    };
    const [largest, calm] = await Promise.all([capped(toBand), capped(toEdge)]);
    const whatToDo: string[] = [];
    if (largest) {
      whatToDo.push(
        `Set limitTick ${largest.limitTick}: the swap fills up to the band and stops there, paying ${largest.pay} for ${largest.receive}. ` +
          `That is the most one ${input.side} can take right now; split the rest.`,
      );
    }
    if (calm) {
      whatToDo.push(
        `To stay out of the edge zone (no limit clock, no halt), cap it at limitTick ${calm.limitTick}: pay ${calm.pay} for ${calm.receive}.`,
      );
    }
    whatToDo.push(
      `Or wait: the reference follows the price every ${pool.params.refWindow}s by up to ${edgeDist - 1} ticks, which widens the room in this direction.`,
    );
    whatToDo.push("Any swap toward the reference always passes.");
    return { ...out, whatToDo, largestFill: largest, largestWithoutLimitState: calm };
  }

  if (err.name === "Halted") {
    const reopensAt = Number(err.args.reopensAt);
    return {
      ...out,
      reopensAt: iso(reopensAt),
      whatToDo: [
        `Wait until ${iso(reopensAt)} at the latest: halts end on their own, and every swap in either direction is refused until then.`,
        "The desk can end the halt sooner on an Organic verdict; curb_status shows the live phase.",
        "Preflight again once it reopens: the reference may have moved.",
      ],
    };
  }

  return out;
}
