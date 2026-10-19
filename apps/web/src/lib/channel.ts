/**
 * Geometry for the channel chart: time runs left to right, the band is a channel around a stepped
 * reference, and the price moves inside it. Pools sit quiet for hours between bursts, so long quiet
 * stretches are folded into a marked gap; every active stretch keeps one shared seconds-to-pixels
 * scale, so a 5-minute halt is always drawn the same width as any other 5 minutes.
 */

export interface Span {
  from: number;
  to: number;
  x0: number;
  x1: number;
}

export interface TimeScale {
  spans: Span[];
  /** Folded stretches between spans, each drawn `gapPx` wide. */
  gaps: Span[];
  start: number;
  end: number;
  width: number;
  x(t: number): number;
}

export interface TimeScaleOptions {
  /** Quiet longer than this (seconds) is folded. */
  maxGap: number;
  /** Width of a folded gap. */
  gapPx: number;
  /** Seconds of context kept either side of activity. */
  pad: number;
}

export function timeScale(
  times: readonly number[],
  start: number,
  end: number,
  width: number,
  opts: TimeScaleOptions,
): TimeScale {
  const pts = [...new Set([start, end, ...times.filter((t) => t >= start && t <= end)])].sort((a, b) => a - b);
  const clusters: [number, number][] = [];
  for (const t of pts) {
    const last = clusters[clusters.length - 1];
    if (last && t - last[1] <= opts.maxGap) last[1] = t;
    else clusters.push([t, t]);
  }
  const merged: [number, number][] = [];
  for (const [a, b] of clusters) {
    const from = Math.max(start, a - opts.pad);
    const to = Math.min(end, b + opts.pad);
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + opts.pad) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  const nGaps = merged.length - 1;
  // Gaps never take more than a third of the width, however many there are.
  const gapPx = nGaps > 0 ? Math.min(opts.gapPx, (width / 3) / nGaps) : 0;
  const total = merged.reduce((sum, [a, b]) => sum + Math.max(1, b - a), 0);
  const k = (width - nGaps * gapPx) / total;

  const spans: Span[] = [];
  const gaps: Span[] = [];
  let x = 0;
  merged.forEach(([from, to], i) => {
    const w = Math.max(1, to - from) * k;
    spans.push({ from, to, x0: x, x1: x + w });
    x += w;
    const next = merged[i + 1];
    if (next) {
      gaps.push({ from: to, to: next[0], x0: x, x1: x + gapPx });
      x += gapPx;
    }
  });

  const scale = (t: number): number => {
    if (t <= start) return 0;
    if (t >= end) return width;
    for (const s of spans) {
      if (t >= s.from && t <= s.to) return s.x0 + ((t - s.from) / Math.max(1, s.to - s.from)) * (s.x1 - s.x0);
    }
    for (const g of gaps) {
      if (t > g.from && t < g.to) return g.x0 + ((t - g.from) / (g.to - g.from)) * (g.x1 - g.x0);
    }
    return width;
  };
  return { spans, gaps, start, end, width, x: scale };
}

export interface Step {
  from: number;
  to: number;
  v: number;
}

/**
 * A value that changes at points in time, as constant steps over [start, end]. The value before the
 * first point in range is the last one at or before `start`.
 */
export function steps(points: readonly { t: number; v: number }[], start: number, end: number): Step[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  let current: number | undefined;
  for (const p of sorted) if (p.t <= start) current = p.v;
  const out: Step[] = [];
  let from = start;
  for (const p of sorted) {
    if (p.t <= start || p.t > end) continue;
    if (current !== undefined && p.t > from) out.push({ from, to: p.t, v: current });
    from = p.t;
    current = p.v;
  }
  if (current !== undefined && end >= from) out.push({ from, to: end, v: current });
  return out;
}

/**
 * The vertical range: every band drawn in full with some air, plus the price wherever it went,
 * clamped so a swap that ran to the end of the curve does not flatten everything else.
 */
export function valueDomain(refs: readonly number[], band: number, prices: readonly number[]): [number, number] {
  if (refs.length === 0) return [-band * 1.4, band * 1.4];
  const lo = Math.min(...refs);
  const hi = Math.max(...refs);
  const air = band * 0.4;
  let min = lo - band - air;
  let max = hi + band + air;
  for (const p of prices) {
    const c = Math.min(Math.max(p, lo - band * 1.8), hi + band * 1.8);
    min = Math.min(min, c - air * 0.5);
    max = Math.max(max, c + air * 0.5);
  }
  return [min, max];
}

/** An SVG path for a stepped line through `steps`, mapped by `x` and `y`. */
export function stepPath(s: readonly Step[], x: (t: number) => number, y: (v: number) => number): string {
  let d = "";
  s.forEach((st, i) => {
    const x0 = x(st.from).toFixed(1);
    const x1 = x(st.to).toFixed(1);
    const yy = y(st.v).toFixed(1);
    d += i === 0 ? `M${x0} ${yy}H${x1}` : `V${yy}H${x1}`;
  });
  return d;
}

export interface ChannelSeries {
  /** The reference as it changed, in ticks. */
  refs: { t: number; v: number }[];
  /** The pool's tick at each swap, from the pool's start. */
  prices: { t: number; v: number }[];
  halts: { start: number; end: number; nonce: number; open: boolean }[];
}

interface SeriesLog {
  eventName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

/**
 * The channel's history from logs: the reference starts at the pool's opening tick and moves only
 * when the hook says so (rolled, re-anchored, or set by a closing halt); the price is the tick
 * after every swap; halts come from HaltClosed, plus the one in progress from the status read.
 */
export function channelSeries(input: {
  hookLogs: readonly SeriesLog[];
  swaps: readonly SeriesLog[];
  init?: { timestamp: number; tick: number };
  status?: { nonce: number; ref: number; tick: number; edgeSince: number; haltStart: number; reopensAt: number };
  now: number;
}): ChannelSeries {
  const n = (v: unknown) => Number(v as number | bigint);
  const refs: { t: number; v: number }[] = [];
  const prices: { t: number; v: number }[] = [];
  const halts: ChannelSeries["halts"] = [];
  if (input.init) {
    refs.push({ t: input.init.timestamp, v: input.init.tick });
    prices.push({ t: input.init.timestamp, v: input.init.tick });
  }
  for (const l of input.hookLogs) {
    const a = l.args;
    if (l.eventName === "ReferenceRolled" || l.eventName === "ReferenceReanchored") refs.push({ t: l.timestamp, v: n(a.ref) });
    else if (l.eventName === "HaltClosed") {
      refs.push({ t: l.timestamp, v: n(a.newRef) });
      halts.push({ start: n(a.haltStart), end: n(a.haltEnd), nonce: n(a.nonce), open: false });
    } else if (l.eventName === "LimitEntered" && refs.length === 0) refs.push({ t: l.timestamp, v: n(a.ref) });
  }
  for (const l of input.swaps) prices.push({ t: l.timestamp, v: n(l.args.tick) });
  const s = input.status;
  if (s) {
    if (refs.length === 0) refs.push({ t: input.now, v: s.ref });
    prices.push({ t: input.now, v: s.tick });
    const closed = halts.some((h) => h.nonce === s.nonce);
    if (s.edgeSince !== 0 && input.now >= s.haltStart && !closed) {
      halts.push({ start: s.haltStart, end: Math.min(input.now, s.reopensAt), nonce: s.nonce, open: input.now < s.reopensAt });
    }
  }
  const byT = (a: { t: number }, b: { t: number }) => a.t - b.t;
  return { refs: refs.sort(byT), prices: prices.sort(byT), halts };
}
