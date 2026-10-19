/**
 * A TypeScript twin of src/libraries/Breaker.sol, rule for rule. The backtest replays real pools
 * through it, the web simulator previews trades with it, and test/differential replays its traces
 * against the Solidity library so the two cannot drift apart.
 */

export enum Phase {
  Open = 0,
  Limit = 1,
  Halted = 2,
  Cooldown = 3,
}

export enum Verdict {
  None = 0,
  Organic = 1,
  Concentrated = 2,
  Inconclusive = 3,
}

export interface Config {
  band: number;
  edge: number;
  refWindow: number;
  limitSeconds: number;
  haltSeconds: number;
  cooldownSeconds: number;
}

export interface State {
  ref: number;
  lastTick: number;
  edgeRef: number;
  nonce: number;
  verdict: Verdict;
  windowStart: number;
  lastObs: number;
  voidStart: boolean;
  cum: bigint;
  edgeSince: number;
  cooldownEnd: number;
  pinUntil: number;
  reopenedAt: number;
}

export interface Closed {
  nonce: number;
  haltStart: number;
  haltEnd: number;
  verdict: Verdict;
  newRef: number;
  cooldownEnd: number;
}

export interface SwapResult {
  rolled: boolean;
  twap?: number;
  limitCleared: boolean;
  closed?: Closed;
  limitEntered: boolean;
  reanchored: boolean;
  haltsAt: number;
}

export class BreakerRevert extends Error {
  constructor(
    public readonly errorName: string,
    public readonly args: readonly (number | boolean)[],
  ) {
    super(`${errorName}(${args.join(", ")})`);
  }
}

const dist = (a: number, b: number) => Math.abs(a - b);
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const MIN_TICK = -887272;
const MAX_TICK = 887272;

function limits(ref: number, band: number): [number, number] {
  return [Math.max(ref - band, MIN_TICK), Math.min(ref + band, MAX_TICK)];
}

function floorDiv(num: bigint, den: bigint): bigint {
  const q = num / den;
  return num % den !== 0n && num < 0n ? q - 1n : q;
}

export class Breaker {
  state: State;

  constructor(
    public readonly config: Config,
    tick: number,
    now: number,
  ) {
    this.state = {
      ref: tick,
      lastTick: tick,
      edgeRef: 0,
      nonce: 0,
      verdict: Verdict.None,
      windowStart: now,
      lastObs: now,
      voidStart: false,
      cum: 0n,
      edgeSince: 0,
      cooldownEnd: 0,
      pinUntil: 0,
      reopenedAt: 0,
    };
  }

  halt(s: State = this.state): [number, number] {
    const c = this.config;
    if (s.edgeSince === 0) return [0, 0];
    const start = Math.max(s.edgeSince, s.cooldownEnd) + c.limitSeconds;
    let end = start + c.haltSeconds;
    if (s.reopenedAt !== 0 && s.reopenedAt < end) end = s.reopenedAt;
    return [start, end];
  }

  phase(now: number, s: State = this.state): Phase {
    const c = this.config;
    if (s.edgeSince !== 0) {
      const [start, end] = this.halt(s);
      if (now < start) return Phase.Limit;
      if (now < end) return Phase.Halted;
      return now < start + c.haltSeconds + c.cooldownSeconds ? Phase.Cooldown : Phase.Open;
    }
    return now < s.cooldownEnd ? Phase.Cooldown : Phase.Open;
  }

  /** A swap whose liquidity is the same before and after it. */
  swap(now: number, tickAfter: number, liquid: boolean): SwapResult {
    return this.swapFull(now, tickAfter, liquid, liquid);
  }

  /**
   * The hook's full path. `boundary` is the first tick with real liquidity the swap crossed, when it
   * started where nothing trades; the hook reads it from the PoolManager's tick bitmap.
   */
  swapFull(now: number, tickAfter: number, liquidBefore: boolean, liquidAfter: boolean, boundary?: number): SwapResult {
    const s: State = { ...this.state };
    const r = this.beforeSwap(s, now, liquidBefore);
    const tickBefore = s.lastTick;
    if (this.refused(s.ref, tickBefore, tickAfter)) {
      const admissible =
        boundary !== undefined && s.voidStart && dist(tickAfter, boundary) <= this.config.band;
      if (!admissible) {
        const [lower, upper] = limits(s.ref, this.config.band);
        throw new BreakerRevert("OutsideBand", [s.ref, tickAfter, tickAfter < s.ref ? lower : upper, tickAfter < tickBefore]);
      }
      s.ref = this.rollRef(s.ref, tickAfter);
      s.windowStart = now;
      s.lastObs = now;
      s.cum = 0n;
      r.reanchored = true;
    }
    this.land(s, now, tickAfter, liquidAfter, r);
    this.state = s;
    return r;
  }

  resolve(now: number, nonce: number, v: Verdict): number {
    const s = this.state;
    if (v !== Verdict.Organic && v !== Verdict.Concentrated) throw new BreakerRevert("BadVerdict", []);
    if (this.phase(now) !== Phase.Halted) throw new BreakerRevert("NotHalted", []);
    if (nonce !== s.nonce) throw new BreakerRevert("WrongIncident", [s.nonce, nonce]);
    if (s.verdict !== Verdict.None) throw new BreakerRevert("AlreadyResolved", []);
    s.verdict = v;
    if (v === Verdict.Organic) s.reopenedAt = now;
    return this.halt()[1];
  }

  private beforeSwap(s: State, now: number, liquid: boolean): SwapResult {
    const c = this.config;
    const r: SwapResult = { rolled: false, limitCleared: false, limitEntered: false, reanchored: false, haltsAt: 0 };
    if (s.edgeSince !== 0) {
      const [start, end] = this.halt(s);
      if (now >= start) {
        if (now < end) throw new BreakerRevert("Halted", [s.nonce, end]);
        r.closed = this.close(s, now, start, end, liquid);
      }
    }
    s.voidStart = !liquid;
    if (s.pinUntil !== 0 && now >= s.pinUntil) s.pinUntil = 0;
    if (s.pinUntil === 0 && liquid && now >= s.windowStart + c.refWindow) {
      const t = this.twap(s, now);
      s.ref = this.rollRef(t, s.lastTick);
      s.windowStart = now;
      s.lastObs = now;
      s.cum = 0n;
      r.rolled = true;
      r.twap = t;
      if (s.edgeSince !== 0) {
        s.edgeSince = 0;
        r.limitCleared = true;
      }
    }
    // Time spent where nothing trades is not sampled: the window slides past it instead.
    if (liquid) s.cum += BigInt(s.lastTick) * BigInt(now - s.lastObs);
    else s.windowStart += now - s.lastObs;
    s.lastObs = now;
    return r;
  }

  private land(s: State, now: number, tickAfter: number, liquid: boolean, r: SwapResult) {
    const c = this.config;
    s.lastTick = tickAfter;
    if (s.pinUntil === 0) {
      const edge = dist(tickAfter, s.ref) >= c.band - c.edge;
      if (edge && liquid && s.edgeSince === 0) {
        s.edgeSince = now;
        s.edgeRef = s.ref;
        r.limitEntered = true;
      } else if (!edge && s.edgeSince !== 0) {
        s.edgeSince = 0;
        r.limitCleared = true;
      }
    }
    r.haltsAt = this.halt(s)[0];
  }

  private close(s: State, now: number, start: number, end: number, liquid: boolean): Closed {
    const c = this.config;
    const v = s.verdict;
    const cooldownEnd = start + c.haltSeconds + c.cooldownSeconds;
    const pin = v === Verdict.Concentrated;
    const tick = s.lastTick;
    const newRef = pin ? this.rollRef(s.edgeRef, tick) : liquid ? tick : clamp(s.ref, tick - c.band, tick + c.band);
    const closed: Closed = { nonce: s.nonce, haltStart: start, haltEnd: end, verdict: v, newRef, cooldownEnd };
    s.ref = newRef;
    s.pinUntil = pin ? cooldownEnd : 0;
    s.cooldownEnd = cooldownEnd;
    s.windowStart = now;
    s.lastObs = now;
    s.cum = 0n;
    s.edgeSince = 0;
    s.reopenedAt = 0;
    s.verdict = Verdict.None;
    s.nonce += 1;
    return closed;
  }

  private refused(ref: number, before: number, after: number): boolean {
    const [lower, upper] = limits(ref, this.config.band);
    if (after >= lower && after <= upper) return false;
    return dist(after, ref) > dist(before, ref);
  }

  private rollRef(twapTick: number, tick: number): number {
    const span = this.config.band - this.config.edge - 1;
    return clamp(twapTick, tick - span, tick + span);
  }

  private twap(s: State, now: number): number {
    if (now <= s.windowStart || now - s.lastObs >= this.config.refWindow) return s.lastTick;
    const num = s.cum + BigInt(s.lastTick) * BigInt(now - s.lastObs);
    return Number(floorDiv(num, BigInt(now - s.windowStart)));
  }
}
