import type { Address, Hex } from "viem";
import { Breaker, BreakerRevert, Verdict, type Config, type SwapResult } from "@curb/sdk";
import { Liquidity } from "./liquidity";
import type { PoolData, SwapEvent } from "./types";
import { classify, rank, type Trade } from "./verdict";

export interface ReplayOptions {
  config: Config;
  /** The liquidity floor as basis points of the launch's seeded liquidity. */
  floorBps: bigint;
  /** Seconds from a halt's start to its verdict landing; null applies none, as when the oracle is down. */
  verdictLatency: number | null;
  /** Where the observation stops: halts still running are cut here. */
  endTime: number;
}

/**
 * What Curb would have answered each real swap:
 * - passed: inside the band, or toward the reference;
 * - reanchored: started where nothing trades and landed within a band of the first liquidity;
 * - refused: OutsideBand;
 * - halted: the pool was in a halt.
 */
export type Outcome = "passed" | "reanchored" | "refused" | "halted";

export interface Refusal {
  time: number;
  block: number;
  tx: Hex;
  trader: Address;
  /** Which way the swap pushed the token's price. */
  side: "up" | "down";
  tickBefore: number;
  tickAfter: number;
  ref: number;
  limit: number;
  /** The token's price move the swap asked for, from where it started. */
  movePct: number;
  /** It ended below the liquidity floor: a swap larger than all the liquidity on its side. */
  intoVoid: boolean;
  volume: bigint;
}

export interface Halt {
  nonce: number;
  limitSince: number;
  start: number;
  /** When it ended: an organic verdict's reopen, the full halt, or the observation's end. */
  end: number;
  closed: boolean;
  /** The incident window the desk would ask about, in L2 blocks. */
  window: { fromBlock: number; toBlock: number };
  total: bigint;
  traders: number;
  leader?: Address;
  figure: bigint;
  shareBps: number;
  verdict: Verdict;
  applied: boolean;
  /** The reference when the limit state began, and the token's move from it at the halt. */
  refAtLimit: number;
  tickAtStart: number;
  movePct: number;
  /** Real swaps that arrived while the pool was halted. */
  swapsInside: number;
  newRef?: number;
}

export interface FirstHour {
  swaps: number;
  /** The token's highest and lowest price against its opening price, in percent. */
  maxUpPct: number;
  maxDownPct: number;
  /** The largest single-swap move that ended in liquidity, signed. */
  biggestSwapPct: number;
  refused: number;
  halts: number;
}

export interface PoolReplay {
  swaps: number;
  traders: number;
  outcomes: Outcome[];
  passed: number;
  reanchored: number;
  refused: {
    total: number;
    up: number;
    down: number;
    intoVoid: number;
    /** Runs of consecutive refusals on one side: how many times the price broke out of its band. */
    streaks: number;
    traders: number;
  };
  inHalt: number;
  rolls: number;
  halts: Halt[];
  refusals: Refusal[];
  pairedVolume: bigint;
  refusedVolume: bigint;
  haltedSeconds: number;
  observedSeconds: number;
  /** Seconds halted in the 24 hours after launch. */
  haltedFirstDay: number;
  minLiquidity: bigint;
  peakUpPct: number;
  peakDownPct: number;
  /**
   * The largest single-swap move that ended in liquidity, signed. A swap that ran out of liquidity
   * slides to its price limit, often the end of the tick range, so its "move" says nothing.
   */
  biggestSwapPct: number;
  firstHour: FirstHour;
}

/** The token's price as a tick: ticks price currency0 in currency1, so flip when the token is currency1. */
export const tokenTick = (pool: Pick<PoolData, "pairedIs0">, tick: number) => (pool.pairedIs0 ? -tick : tick);
export const pct = (ticks: number) => (Math.pow(1.0001, ticks) - 1) * 100;

/**
 * Runs one swap with the band check off. The model keeps `refused` private; shadowing it on the
 * instance for this one call leaves every other rule the model's own.
 */
function unbanded<T>(b: Breaker, run: () => T): T {
  const target = b as unknown as Record<string, unknown>;
  target.refused = () => false;
  try {
    return run();
  } finally {
    delete target.refused;
  }
}

/**
 * Shadow replay: the breaker sees every real swap in order and its price follows the real one.
 * - A swap Curb would refuse is counted, then applied with the band off, standing for the same
 *   order split over time; the limit clock and the halt then react to where the price really went.
 * - A swap that lands in a halt is counted and held for the reopen: the price follows it, but no
 *   sample, limit clock or tape entry comes from it, so the halt closes on the price the market
 *   reopened at.
 */
export function replay(pool: PoolData, o: ReplayOptions): PoolReplay {
  const floor = (pool.seeded * o.floorBps) / 10_000n;
  const b = new Breaker(o.config, pool.initTick, pool.launchTime);
  const liq = new Liquidity(pool.tickSpacing, floor, pool.initTick);
  const tape: Trade[] = [];
  const halts: Halt[] = [];
  const byNonce = new Map<number, Halt>();
  const refusals: Refusal[] = [];
  const outcomes: Outcome[] = [];
  const traders = new Set<Address>();
  let rolls = 0;
  let streaks = 0;
  let pairedTotal = 0n;
  // CurbHook's window snapshots, as L2 block numbers.
  let current = pool.launchBlock;
  let previous = pool.launchBlock;
  let lastSwapBlock = pool.launchBlock;
  const shift = (block: number) => {
    previous = current;
    current = block;
  };

  const open0 = tokenTick(pool, pool.initTick);
  let peakUp = 0;
  let peakDown = 0;
  let biggest = 0;
  const hourEnd = pool.launchTime + 3600;
  let biggestFirstHour = 0;
  const firstHour: FirstHour = { swaps: 0, maxUpPct: 0, maxDownPct: 0, biggestSwapPct: 0, refused: 0, halts: 0 };

  /** Records the halt in progress at `t`, if one has begun, and lands its verdict. */
  const noteHalt = (t: number) => {
    const s = b.state;
    if (s.edgeSince === 0 || byNonce.has(s.nonce)) return;
    const [start, end] = b.halt();
    if (t < start) return;
    const window = { fromBlock: previous, toBlock: lastSwapBlock };
    const r = rank(tape, window.fromBlock, window.toBlock);
    const { verdict, shareBps } = classify(r.figure, r.total);
    const h: Halt = {
      nonce: s.nonce,
      limitSince: s.edgeSince,
      start,
      end,
      closed: false,
      window,
      total: r.total,
      traders: r.traders,
      leader: r.leader,
      figure: r.figure,
      shareBps,
      verdict,
      applied: false,
      refAtLimit: s.edgeRef,
      tickAtStart: s.lastTick,
      movePct: pct(tokenTick(pool, s.lastTick) - tokenTick(pool, s.edgeRef)),
      swapsInside: 0,
    };
    const at = o.verdictLatency === null ? Infinity : start + o.verdictLatency;
    if ((verdict === Verdict.Organic || verdict === Verdict.Concentrated) && at < end) {
      b.resolve(at, s.nonce, verdict);
      h.applied = true;
      h.end = b.halt()[1];
    }
    halts.push(h);
    byNonce.set(s.nonce, h);
    if (start < hourEnd) firstHour.halts++;
  };

  for (const e of pool.events) {
    if (e.kind === "liquidity") {
      liq.modify(e.tickLower, e.tickUpper, e.delta);
      continue;
    }
    noteHalt(e.time);
    traders.add(e.trader);
    const liquidBefore = liq.liquid();
    const liquidAfter = e.liquidity >= floor;
    const tickBefore = b.state.lastTick;
    const boundary = liquidBefore ? undefined : liq.boundary(tickBefore, e.tick);
    const move = tokenTick(pool, e.tick) - tokenTick(pool, tickBefore);
    const volume = pairedVolume(pool, e);
    pairedTotal += volume;
    let r: SwapResult | undefined;
    let outcome: Outcome;
    try {
      r = b.swapFull(e.time, e.tick, liquidBefore, liquidAfter, boundary);
      outcome = r.reanchored ? "reanchored" : "passed";
    } catch (err) {
      if (!(err instanceof BreakerRevert)) throw err;
      if (err.errorName === "Halted") {
        outcome = "halted";
        byNonce.get(b.state.nonce)!.swapsInside++;
        b.state = { ...b.state, lastTick: e.tick };
      } else if (err.errorName === "OutsideBand") {
        outcome = "refused";
        const side = move > 0 ? "up" : "down";
        const prev = refusals.at(-1);
        if (outcomes.at(-1) !== "refused" || prev?.side !== side) streaks++;
        refusals.push({
          time: e.time,
          block: e.block,
          tx: e.tx,
          trader: e.trader,
          side,
          tickBefore,
          tickAfter: e.tick,
          ref: err.args[0] as number,
          limit: err.args[2] as number,
          movePct: pct(move),
          intoVoid: !liquidAfter,
          volume,
        });
        if (e.time < hourEnd) firstHour.refused++;
        r = unbanded(b, () => b.swapFull(e.time, e.tick, liquidBefore, liquidAfter, boundary));
      } else throw err;
    }
    if (r) {
      if (r.closed) {
        const h = byNonce.get(r.closed.nonce)!;
        h.end = r.closed.haltEnd;
        h.closed = true;
        h.newRef = r.closed.newRef;
        shift(e.block);
      }
      if (r.rolled) {
        rolls++;
        shift(e.block);
      }
      if (r.reanchored) shift(e.block);
      lastSwapBlock = e.block;
      tape.push({ block: e.block, trader: e.trader, volume });
    }
    outcomes.push(outcome);
    liq.swapped(e.tick, e.liquidity);

    const fromOpen = tokenTick(pool, e.tick) - open0;
    peakUp = Math.max(peakUp, fromOpen);
    peakDown = Math.min(peakDown, fromOpen);
    if (liquidAfter && Math.abs(move) > Math.abs(biggest)) biggest = move;
    if (e.time < hourEnd) {
      firstHour.swaps++;
      firstHour.maxUpPct = Math.max(firstHour.maxUpPct, pct(fromOpen));
      firstHour.maxDownPct = Math.min(firstHour.maxDownPct, pct(fromOpen));
      if (liquidAfter && Math.abs(move) > Math.abs(biggestFirstHour)) biggestFirstHour = move;
      firstHour.biggestSwapPct = pct(biggestFirstHour);
    }
  }
  noteHalt(o.endTime);

  const haltedUntil = (until: number) =>
    halts.reduce((sum, h) => sum + Math.max(0, Math.min(h.end, until, o.endTime) - h.start), 0);
  const count = (k: Outcome) => outcomes.filter((x) => x === k).length;
  return {
    swaps: outcomes.length,
    traders: traders.size,
    outcomes,
    passed: count("passed"),
    reanchored: count("reanchored"),
    refused: {
      total: refusals.length,
      up: refusals.filter((x) => x.side === "up").length,
      down: refusals.filter((x) => x.side === "down").length,
      intoVoid: refusals.filter((x) => x.intoVoid).length,
      streaks,
      traders: new Set(refusals.map((x) => x.trader)).size,
    },
    inHalt: count("halted"),
    rolls,
    halts,
    refusals,
    pairedVolume: pairedTotal,
    refusedVolume: refusals.reduce((s, x) => s + x.volume, 0n),
    haltedSeconds: haltedUntil(Infinity),
    haltedFirstDay: haltedUntil(pool.launchTime + 86_400),
    observedSeconds: o.endTime - pool.launchTime,
    minLiquidity: floor,
    peakUpPct: pct(peakUp),
    peakDownPct: pct(peakDown),
    biggestSwapPct: pct(biggest),
    firstHour,
  };
}

function pairedVolume(pool: PoolData, e: SwapEvent): bigint {
  const moved = pool.pairedIs0 ? e.amount0 : e.amount1;
  return moved < 0n ? -moved : moved;
}
