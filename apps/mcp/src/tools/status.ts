import { Phase, VERDICT_NAMES, curbDeskAbi, type Status } from "@curb/sdk";
import type { Address } from "viem";
import type { Context } from "../context";
import { amount, duration, iso, relative, tickPercent, tokenPrice } from "../format";
import { addressUrl, knownPools, resolveHook } from "../known";
import { readHookStatus, readPool, type Pool } from "../pool";

export interface StatusInput {
  hook?: string;
  listPools?: boolean;
}

export async function curbStatus(ctx: Context, input: StatusInput) {
  const hook = resolveHook(input.hook, ctx.deployments);
  const [pool, s, block, pools] = await Promise.all([
    readPool(ctx, hook),
    readHookStatus(ctx, hook),
    ctx.client.getBlock(),
    input.listPools ? listPools(ctx) : Promise.resolve(undefined),
  ]);
  const now = Number(block.timestamp);
  const { band, edge } = pool.params;
  const pinned = s.pinUntil > now;
  const ended = s.edgeSince !== 0 && s.reopensAt !== 0 && now >= s.reopensAt;
  const [d0, d1] = pool.tokenIs0 ? [pool.token.decimals, pool.paired.decimals] : [pool.paired.decimals, pool.token.decimals];
  return {
    summary: summarize(s, pool, now, pinned, ended),
    hook,
    pool: pool.name,
    label: pool.label ?? null,
    deskBinding: pool.deskBinding,
    phase: s.phaseName,
    nonce: s.nonce,
    verdict: VERDICT_NAMES[s.verdict] ?? String(s.verdict),
    ticks: {
      current: s.tick,
      reference: s.ref,
      bandLower: s.lower,
      bandUpper: s.upper,
      edgeZoneLower: s.ref - (band - edge),
      edgeZoneUpper: s.ref + (band - edge),
    },
    price: `1 ${pool.token.symbol} = ${tokenPrice(s.tick, pool.tokenIs0, d0, d1)} ${pool.paired.symbol}`,
    times: {
      chainNow: iso(now),
      edgeSince: iso(s.edgeSince),
      haltStart: iso(s.haltStart),
      reopensAt: iso(s.reopensAt),
      cooldownEnd: iso(s.cooldownEnd),
      pinUntil: iso(s.pinUntil),
    },
    haltEndedUnclosed: ended,
    pin: pinned ? { reference: s.ref, until: iso(s.pinUntil) } : null,
    incidentWindow: {
      fromBlock: s.fromBlock.toString(),
      toBlock: s.toBlock.toString(),
      volume: amount(s.windowVolume, pool.paired.decimals, pool.paired.symbol),
    },
    params: {
      bandTicks: band,
      edgeTicks: edge,
      referenceWindow: duration(pool.params.refWindow),
      limitState: duration(pool.params.limitSeconds),
      maxHalt: duration(pool.params.haltSeconds),
      cooldown: duration(pool.params.cooldownSeconds),
      minLiquidity: pool.params.minLiquidity.toString(),
    },
    explorer: addressUrl(hook),
    ...(pools ? { knownPools: pools } : {}),
  };
}

function summarize(s: Status, pool: Pool, now: number, pinned: boolean, ended: boolean): string {
  const band = `band ${s.lower}..${s.upper} (±${tickPercent(pool.params.band)}) around reference ${s.ref}`;
  switch (s.phase) {
    case Phase.Halted:
      return (
        `${pool.name} is HALTED (incident ${s.nonce}) since ${iso(s.haltStart)}: every swap in either direction is refused ` +
        `until ${iso(s.reopensAt)} at the latest (${relative(s.reopensAt, now)}). A verdict can only end it sooner.`
      );
    case Phase.Limit:
      return (
        `${pool.name} is in the LIMIT state: tick ${s.tick} has been in the edge zone since ${iso(s.edgeSince)}. ` +
        `Unless a swap moves it back toward ${s.ref}, the pool halts both ways at ${iso(s.haltStart)} (${relative(s.haltStart, now)}).`
      );
    case Phase.Cooldown: {
      let out =
        `${pool.name} is OPEN in a cooldown until ${iso(s.cooldownEnd)} (${relative(s.cooldownEnd, now)}) at tick ${s.tick}, ${band}; ` +
        `swaps that end inside the band or move toward the reference pass, and no new halt starts before the cooldown ends.`;
      if (pinned) out += ` The reference is pinned at ${s.ref} until ${iso(s.pinUntil)} after a Concentrated verdict.`;
      if (ended) out += ` Halt ${s.nonce} ended at ${iso(s.reopensAt)}; the next swap closes it.`;
      return out;
    }
    default: {
      let out = `${pool.name} is OPEN at tick ${s.tick}, ${band}: swaps that end inside the band, or move toward the reference, pass.`;
      if (ended) out += ` Halt ${s.nonce} ended at ${iso(s.reopensAt)}; the next swap closes it.`;
      return out;
    }
  }
}

/** Pools named in the deployments plus every hook the desk has bound. */
export async function listPools(ctx: Context) {
  const named = knownPools(ctx.deployments);
  const desk = ctx.deployments.desk;
  const count = await ctx.client.readContract({ address: desk, abi: curbDeskAbi, functionName: "hookCount" });
  const bound = await Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      ctx.client.readContract({ address: desk, abi: curbDeskAbi, functionName: "hooks", args: [BigInt(i)] }),
    ),
  );
  const hooks = new Map<string, Address>();
  for (const p of named) hooks.set(p.hook.toLowerCase(), p.hook);
  for (const h of bound) hooks.set(h.toLowerCase(), h);
  return Promise.all(
    [...hooks.values()].map(async (hook) => {
      const pool = await readPool(ctx, hook);
      return { hook, pool: pool.name, label: pool.label ?? null, deskBinding: pool.deskBinding };
    }),
  );
}
