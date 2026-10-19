import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { channelSeries, stepPath, steps, timeScale, valueDomain, type Step } from "../lib/channel";
import { formatClock, formatDateTime, formatDuration, formatTick } from "../lib/format";
import type { HookParams } from "../lib/phase";
import { formatPercent, fromPriceAxis, priceAxis, readablePrice, tickPercent, tokenPrice, type PairInfo } from "../lib/price";
import type { ChainLog } from "../lib/timeline";
import { useWidth } from "../state/hooks";

export interface Attempt {
  tickAfter: number;
  outcome: "pass" | "refused";
}

interface Props {
  pair: PairInfo;
  params: HookParams;
  status: { nonce: number; ref: number; tick: number; edgeSince: number; haltStart: number; reopensAt: number };
  hookLogs: readonly ChainLog[];
  swaps: readonly ChainLog[];
  init?: { timestamp: number; tick: number };
  now: number;
  height?: number;
  /** A swap being previewed, drawn at the right end from the current price. */
  attempt?: Attempt;
  title: string;
}

const TOP = 26;
const BOTTOM = 30;

/**
 * The band as a channel over time: the reference (dashed), the two limits (the only colour on the
 * page), the hatched edge zones, halts as shaded spans, and the price stepping inside. Quiet hours
 * are folded so bursts of activity keep their real proportions.
 */
export function ChannelChart({ pair, params, status, hookLogs, swaps, init, now, height = 320, attempt, title }: Props) {
  const [setBox, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/:/g, "");
  const [active, setActive] = useState<number | null>(null);
  const narrow = width < 560;
  const labelW = narrow ? 78 : 150;
  const attemptW = attempt ? (narrow ? 44 : 64) : 14;
  const plotW = Math.max(120, width - labelW);
  const timeW = plotW - attemptW;
  const H = height;
  const plotH = H - TOP - BOTTOM;

  const model = useMemo(() => {
    const series = channelSeries({ hookLogs, swaps, init, status, now });
    const t0 = Math.min(...series.refs.map((r) => r.t), ...series.prices.map((p) => p.t), now);
    const start = t0 - Math.max(30, params.refWindow / 4);
    const marks = [...series.prices.map((p) => p.t), ...series.halts.flatMap((h) => [h.start, h.end])];
    const scale = timeScale(marks, start, now, Math.max(60, timeW), {
      maxGap: Math.max(params.haltSeconds, params.refWindow) * 2,
      gapPx: 34,
      pad: Math.max(30, params.refWindow / 2),
    });
    const ax = (tick: number) => priceAxis(tick, pair.tokenIs0);
    const refSteps: Step[] = steps(
      series.refs.map((r) => ({ t: r.t, v: ax(r.v) })),
      start,
      now,
    );
    const priceSteps: Step[] = steps(
      series.prices.map((p) => ({ t: p.t, v: ax(p.v) })),
      start,
      now,
    );
    const attemptAxis = attempt ? [ax(attempt.tickAfter)] : [];
    const [lo, hi] = valueDomain(
      refSteps.map((s) => s.v),
      params.bandTicks,
      [...priceSteps.map((s) => s.v), ...attemptAxis],
    );
    return { series, scale, refSteps, priceSteps, lo, hi, start };
  }, [hookLogs, swaps, init, status, now, params, pair.tokenIs0, timeW, attempt]);

  if (width === 0) return <div ref={setBox} className="chart" style={{ height: H }} />;

  const { series, scale, refSteps, priceSteps, lo, hi } = model;
  const x = (t: number) => scale.x(t);
  const y = (v: number) => TOP + (1 - (v - lo) / (hi - lo)) * plotH;
  const clampY = (v: number) => Math.min(TOP + plotH + 6, Math.max(TOP - 6, y(v)));
  const band = params.bandTicks;
  const edge = params.edgeTicks;
  const current = refSteps[refSteps.length - 1];
  const refNow = current?.v ?? priceAxis(status.ref, pair.tokenIs0);
  const priceNow = priceAxis(status.tick, pair.tokenIs0);
  const upper = refSteps.map((s) => ({ ...s, v: s.v + band }));
  const lower = refSteps.map((s) => ({ ...s, v: s.v - band }));
  const hatch = `hatch-${uid}`;
  const clip = `clip-${uid}`;

  // Hover and keyboard both walk the swaps.
  const points = series.prices.filter((p) => p.t >= model.start);
  const activePoint = active !== null ? points[active] : undefined;
  const nearest = (px: number) => {
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(x(p.t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return points.length ? best : null;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setActive(nearest(e.clientX - r.left));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!points.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setActive((a) => Math.min(points.length - 1, Math.max(0, (a ?? (d > 0 ? -1 : points.length)) + d)));
    } else if (e.key === "Escape") setActive(null);
  };
  const refAt = (t: number) => {
    let v = refSteps[0]?.v ?? refNow;
    for (const s of refSteps) if (s.from <= t) v = s.v;
    return fromPriceAxis(v, pair.tokenIs0);
  };

  // Axis labels: the start of each active stretch, each fold's length, and now. Widths are
  // estimated from the mono face (about 6.4px a character) and later labels yield, except "now".
  type AxisLabel = { x: number; text: string; anchor: "start" | "middle" | "end"; quiet?: boolean };
  const raw: AxisLabel[] = [];
  scale.spans.forEach((sp, i) => {
    raw.push({ x: i === 0 ? 0 : sp.x0 + 4, text: formatClock(sp.from).slice(0, 5), anchor: "start" });
    const g = scale.gaps[i];
    if (g) raw.push({ x: (g.x0 + g.x1) / 2, text: formatDuration(g.to - g.from).split(" ")[0]!, anchor: "middle", quiet: true });
  });
  const nowLabel: AxisLabel = { x: timeW, text: "now", anchor: "end" };
  const extent = (l: AxisLabel): [number, number] => {
    const w = l.text.length * 6.4;
    return l.anchor === "start" ? [l.x, l.x + w] : l.anchor === "end" ? [l.x - w, l.x] : [l.x - w / 2, l.x + w / 2];
  };
  const placed: AxisLabel[] = [];
  for (const l of [...raw, nowLabel].sort((a, b) => a.x - b.x)) {
    const [a] = extent(l);
    const last = placed[placed.length - 1];
    if (last && a < extent(last)[1] + 8) {
      if (l === nowLabel) placed[placed.length - 1] = l;
      continue;
    }
    placed.push(l);
  }

  const wallLabel = (axisValue: number, sign: 1 | -1) => {
    const tick = fromPriceAxis(axisValue, pair.tokenIs0);
    return { pct: formatPercent(sign * tickPercent(band)), tick: formatTick(tick) };
  };
  const up = wallLabel(refNow + band, 1);
  const down = wallLabel(refNow - band, -1);
  const priceText = readablePrice(tokenPrice(status.tick, pair), pair).text;
  const lx = plotW + 12;

  const attemptX = timeW + attemptW / 2;
  let attemptEl = null;
  if (attempt) {
    const target = priceAxis(attempt.tickAfter, pair.tokenIs0);
    const wallV = target > refNow ? refNow + band : refNow - band;
    const y0 = y(priceNow);
    const yT = clampY(target);
    if (attempt.outcome === "refused") {
      const yW = y(wallV);
      attemptEl = (
        <g className="chart__attempt">
          <line x1={attemptX} y1={y0} x2={attemptX} y2={yW} className="chart__attempt-path" />
          <line x1={attemptX} y1={yW} x2={attemptX} y2={yT} className="chart__attempt-beyond" />
          <path d={`M${attemptX - 7} ${yW}h14`} className="chart__stop" />
          <circle cx={attemptX} cy={yT} r={4.6} className="chart__target chart__target--refused" />
          <text x={attemptX - 10} y={yT + 4} textAnchor="end" className="chart__label chart__label--strong">
            tickAfter {formatTick(attempt.tickAfter)}
          </text>
        </g>
      );
    } else {
      attemptEl = (
        <g className="chart__attempt">
          <line x1={attemptX} y1={y0} x2={attemptX} y2={yT} className="chart__attempt-path" />
          <circle cx={attemptX} cy={yT} r={4.2} className="chart__target" />
          <text x={attemptX - 10} y={yT + 4} textAnchor="end" className="chart__label chart__label--strong">
            ends at {formatTick(attempt.tickAfter)}
          </text>
        </g>
      );
    }
  }

  const summary =
    `${title}. Reference tick ${formatTick(fromPriceAxis(refNow, pair.tokenIs0))}, price tick ${formatTick(status.tick)}, ` +
    `band ±${band} ticks. ${series.halts.length} halt${series.halts.length === 1 ? "" : "s"} shown.`;

  return (
    <div ref={setBox} className="chart" tabIndex={0} role="group" aria-label={summary} onKeyDown={onKey} onBlur={() => setActive(null)}>
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} onPointerMove={onMove} onPointerLeave={() => setActive(null)} aria-hidden="true">
        <defs>
          <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" className="chart__hatch-line" />
          </pattern>
          <clipPath id={clip}>
            <rect x={0} y={TOP - 8} width={plotW} height={plotH + 16} />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clip})`}>
          {series.halts.map((h) => (
            <g key={`h${h.nonce}`}>
              <rect x={x(h.start)} y={TOP} width={Math.max(2, x(h.end) - x(h.start))} height={plotH} className="chart__halt" />
              <text x={x(h.start) + 6} y={TOP + 13} className="chart__halt-label">
                halted {formatDuration(h.end - h.start)}
                {h.open ? ", so far" : ""}
              </text>
            </g>
          ))}
          {refSteps.map((s, i) => (
            <g key={`b${i}`}>
              <rect x={x(s.from)} y={y(s.v + band)} width={x(s.to) - x(s.from)} height={y(s.v - band) - y(s.v + band)} className="chart__body" />
              <rect x={x(s.from)} y={y(s.v + band)} width={x(s.to) - x(s.from)} height={y(s.v + band - edge) - y(s.v + band)} fill={`url(#${hatch})`} />
              <rect x={x(s.from)} y={y(s.v - band + edge)} width={x(s.to) - x(s.from)} height={y(s.v - band) - y(s.v - band + edge)} fill={`url(#${hatch})`} />
            </g>
          ))}
          {attempt && (
            <g>
              <rect x={timeW} y={y(refNow + band)} width={plotW - timeW} height={y(refNow - band) - y(refNow + band)} className="chart__body" />
              <rect x={timeW} y={y(refNow + band)} width={plotW - timeW} height={y(refNow + band - edge) - y(refNow + band)} fill={`url(#${hatch})`} />
              <rect x={timeW} y={y(refNow - band + edge)} width={plotW - timeW} height={y(refNow - band) - y(refNow - band + edge)} fill={`url(#${hatch})`} />
              <path d={`M${timeW} ${y(refNow + band)}H${plotW}M${timeW} ${y(refNow - band)}H${plotW}`} className="chart__wall" />
              <path d={`M${timeW} ${y(refNow)}H${plotW}`} className="chart__ref" />
            </g>
          )}
          <path d={stepPath(upper, x, y)} className="chart__wall" />
          <path d={stepPath(lower, x, y)} className="chart__wall" />
          <path d={stepPath(refSteps, x, y)} className="chart__ref" />
          {scale.gaps.map((g, i) => (
            <rect key={`g${i}`} x={g.x0} y={TOP - 8} width={g.x1 - g.x0} height={plotH + 16} className="chart__fold" />
          ))}
          <path d={stepPath(priceSteps, x, (v) => clampY(v))} className="chart__price" />
          {points.map((p, i) => (
            <circle key={`p${i}`} cx={x(p.t)} cy={clampY(priceAxis(p.v, pair.tokenIs0))} r={2.6} className="chart__dot" />
          ))}
        </g>

        {attemptEl}
        <circle cx={timeW} cy={clampY(priceNow)} r={4.5} className="chart__needle" />

        <line x1={0} y1={TOP + plotH + 8} x2={plotW} y2={TOP + plotH + 8} className="chart__axis" />
        {scale.gaps.map((g, i) => {
          const cx = (g.x0 + g.x1) / 2;
          const ay = TOP + plotH + 8;
          return <path key={`gb${i}`} d={`M${cx - 6} ${ay + 5}l4 -10M${cx + 1} ${ay + 5}l4 -10`} className="chart__break" />;
        })}
        {placed.map((l, i) => (
          <text
            key={`t${i}`}
            x={l.x}
            y={TOP + plotH + 26}
            textAnchor={l.anchor}
            className={l.quiet ? "chart__tick chart__tick--quiet" : "chart__tick"}
          >
            {l.text}
          </text>
        ))}

        <g className="chart__labels">
          <text x={lx} y={y(refNow + band) - 4} className="chart__label">
            {narrow ? up.pct : `limit ${up.pct}`}
          </text>
          <text x={lx} y={y(refNow + band) + 9} className="chart__label chart__label--sub">
            {up.tick}
          </text>
          <text x={lx} y={y(refNow) + 4} className="chart__label">
            {narrow ? "ref" : `ref ${formatTick(fromPriceAxis(refNow, pair.tokenIs0))}`}
          </text>
          <text x={lx} y={y(refNow - band) - 4} className="chart__label">
            {narrow ? down.pct : `limit ${down.pct}`}
          </text>
          <text x={lx} y={y(refNow - band) + 9} className="chart__label chart__label--sub">
            {down.tick}
          </text>
          {!narrow && (
            <text x={lx} y={TOP - 10} className="chart__label chart__label--sub">
              {pair.token.symbol} price ↑
            </text>
          )}
        </g>

        {activePoint && (
          <line x1={x(activePoint.t)} y1={TOP - 6} x2={x(activePoint.t)} y2={TOP + plotH + 8} className="chart__cross" />
        )}
      </svg>
      {activePoint && (
        <div
          className="chart__tip"
          style={{ left: Math.min(Math.max(8, x(activePoint.t) + 12), width - 228), top: TOP }}
          role="status"
        >
          <strong>{readablePrice(tokenPrice(activePoint.v, pair), pair).text}</strong>
          <span>tick {formatTick(activePoint.v)} · ref {formatTick(refAt(activePoint.t))}</span>
          <span>{formatDateTime(activePoint.t)}</span>
        </div>
      )}
      <p className="sr-only">Current price {priceText}.</p>
    </div>
  );
}
