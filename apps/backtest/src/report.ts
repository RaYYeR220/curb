import { VERDICT_NAMES, Verdict, type Config } from "@curb/sdk";
import type { Collected } from "./collect";
import { ETH, IMD } from "./config";
import type { Halt, PoolReplay } from "./replay";
import type { PoolData } from "./types";
import { CONCENTRATED_MIN_BPS, ORGANIC_MAX_BPS } from "./verdict";

export interface RunParams {
  config: Config;
  floorBps: bigint;
  verdictLatency: number;
  days: number;
}

export interface Totals {
  pools: number;
  poolsTraded: number;
  swaps: number;
  traders: number;
  passed: number;
  reanchored: number;
  refused: number;
  refusedUp: number;
  refusedDown: number;
  refusedIntoVoid: number;
  refusedStreaks: number;
  refusedTraders: number;
  inHalt: number;
  halts: number;
  silentHalts: number;
  haltedSeconds: number;
  observedSeconds: number;
  haltedFirstDay: number;
  observedFirstDay: number;
  verdicts: { organic: number; concentrated: number; inconclusive: number };
  applied: number;
}

const DAY = 86_400;
const pairName = (paired: string) => (paired === IMD ? "IMD" : paired === ETH ? "ETH" : paired);
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export function totals(pools: PoolData[], replays: PoolReplay[]): Totals {
  const all = replays.flatMap((r) => r.halts);
  const traders = new Set(pools.flatMap((p) => p.events.flatMap((e) => (e.kind === "swap" ? [e.trader] : []))));
  const refusedTraders = new Set(replays.flatMap((r) => r.refusals.map((x) => x.trader)));
  const sum = (f: (r: PoolReplay) => number) => replays.reduce((s, r) => s + f(r), 0);
  return {
    pools: pools.length,
    poolsTraded: replays.filter((r) => r.swaps > 0).length,
    swaps: sum((r) => r.swaps),
    traders: traders.size,
    passed: sum((r) => r.passed),
    reanchored: sum((r) => r.reanchored),
    refused: sum((r) => r.refused.total),
    refusedUp: sum((r) => r.refused.up),
    refusedDown: sum((r) => r.refused.down),
    refusedIntoVoid: sum((r) => r.refused.intoVoid),
    refusedStreaks: sum((r) => r.refused.streaks),
    refusedTraders: refusedTraders.size,
    inHalt: sum((r) => r.inHalt),
    halts: all.length,
    silentHalts: all.filter((h) => h.swapsInside === 0).length,
    haltedSeconds: sum((r) => r.haltedSeconds),
    observedSeconds: sum((r) => r.observedSeconds),
    haltedFirstDay: sum((r) => r.haltedFirstDay),
    observedFirstDay: sum((r) => Math.min(r.observedSeconds, DAY)),
    verdicts: verdictMix(all),
    applied: all.filter((h) => h.applied).length,
  };
}

function verdictMix(halts: Halt[]) {
  return {
    organic: halts.filter((h) => h.verdict === Verdict.Organic).length,
    concentrated: halts.filter((h) => h.verdict === Verdict.Concentrated).length,
    inconclusive: halts.filter((h) => h.verdict === Verdict.Inconclusive).length,
  };
}

const firstHourSwing = (r: PoolReplay) => Math.max(r.firstHour.maxUpPct, -r.firstHour.maxDownPct);

/** The machine-readable result: everything the tables are built from, with bigints as strings. */
export function buildReport(c: Collected, p: RunParams, pools: PoolData[], replays: PoolReplay[], fallback: PoolReplay[]) {
  const violent = pools
    .map((pool, i) => ({ pool, r: replays[i]! }))
    .filter((x) => x.r.swaps > 0)
    .sort((a, b) => firstHourSwing(b.r) - firstHourSwing(a.r))
    .map((x) => x.pool.launchNumber);
  return {
    chainId: 4663,
    generatedAt: new Date().toISOString(),
    head: { block: c.head.block, time: c.head.time, iso: iso(c.head.time) },
    since: { block: c.since.block, time: c.since.time, iso: iso(c.since.time) },
    method: "shadow",
    params: {
      ...p.config,
      floorBpsOfSeeded: Number(p.floorBps),
      verdictLatencySeconds: p.verdictLatency,
      organicMaxBps: ORGANIC_MAX_BPS,
      concentratedMinBps: CONCENTRATED_MIN_BPS,
      lookbackDays: p.days,
    },
    totals: totals(pools, replays),
    totalsWithoutVerdicts: totals(pools, fallback),
    violentFirstHour: violent,
    pools: pools.map((pool, i) => {
      const r = replays[i]!;
      const fb = fallback[i]!;
      return {
        launchNumber: pool.launchNumber,
        token: pool.token,
        symbol: pool.symbol,
        pair: pairName(pool.paired),
        poolId: pool.poolId,
        hook: pool.hook,
        fee: pool.fee,
        launchBlock: pool.launchBlock,
        launchTime: pool.launchTime,
        launchIso: iso(pool.launchTime),
        initTick: pool.initTick,
        seededLiquidity: pool.seeded,
        minLiquidity: r.minLiquidity,
        swaps: r.swaps,
        traders: r.traders,
        passed: r.passed,
        reanchored: r.reanchored,
        refused: r.refused,
        inHalt: r.inHalt,
        rolls: r.rolls,
        halts: r.halts.length,
        verdicts: verdictMix(r.halts),
        pairedVolume: r.pairedVolume,
        refusedVolume: r.refusedVolume,
        haltedSeconds: r.haltedSeconds,
        observedSeconds: r.observedSeconds,
        timeHaltedPct: r.observedSeconds > 0 ? (100 * r.haltedSeconds) / r.observedSeconds : 0,
        haltedFirstDay: r.haltedFirstDay,
        firstDayHaltedPct: (100 * r.haltedFirstDay) / Math.max(1, Math.min(r.observedSeconds, DAY)),
        peakUpPct: r.peakUpPct,
        peakDownPct: r.peakDownPct,
        biggestSwapPct: r.biggestSwapPct,
        firstHour: r.firstHour,
        withoutVerdicts: {
          refused: fb.refused.total,
          inHalt: fb.inHalt,
          halts: fb.halts.length,
          haltedSeconds: fb.haltedSeconds,
        },
        haltList: r.halts.map((h) => ({
          ...h,
          verdict: VERDICT_NAMES[h.verdict],
          startIso: iso(h.start),
          seconds: Math.min(h.end, c.head.time) - h.start,
        })),
        refusalList: r.refusals,
      };
    }),
  };
}

export type Report = ReturnType<typeof buildReport>;

const n0 = (x: number) => x.toLocaleString("en-US");
const p1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const share = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const dur = (s: number) => (s >= 5400 ? `${(s / 3600).toFixed(1)} h` : s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`);
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const of = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0);

/** The results section of backtest/README.md. */
export function renderMarkdown(rep: Report): string {
  const t = rep.totals;
  const f = rep.totalsWithoutVerdicts;
  const out: string[] = [];
  out.push(
    `Run at L2 block ${n0(rep.head.block)} (${rep.head.iso}) over every launch since ${rep.since.iso}.`,
    "",
    `- **${t.pools} launch pools**, ${t.poolsTraded} of them traded: **${n0(t.swaps)} swaps** from ${n0(t.traders)} distinct senders.`,
    `- **Refused (OutsideBand): ${n0(t.refused)} swaps** (${of(t.refused, t.swaps).toFixed(1)}%) from ${t.refusedTraders} senders, in ${t.refusedStreaks} breakouts (runs of consecutive refusals on one side). ${t.refusedUp} pushed the token up, ${t.refusedDown} down; ${t.refusedIntoVoid} were swaps larger than all the liquidity on their side, ending where nothing trades.`,
    `- **Halts: ${t.halts}**, in ${rep.pools.filter((p) => p.halts > 0).length} pools. ${n0(t.inHalt)} swaps arrived during one; ${t.silentHalts} halt${t.silentHalts === 1 ? "" : "s"} saw none.`,
    `- **Verdicts:** ${t.verdicts.organic} organic, ${t.verdicts.concentrated} concentrated, ${t.verdicts.inconclusive} inconclusive. ${t.applied} applied (organic reopens after ${rep.params.verdictLatencySeconds} s, concentrated pins); inconclusive halts run their full 15 minutes.`,
    `- **Time halted:** ${dur(t.haltedFirstDay)} within the pools' first 24 hours, ${of(t.haltedFirstDay, t.observedFirstDay).toFixed(2)}% of those ${t.pools} pool-days; ${dur(t.haltedSeconds)} over their whole lives, ${of(t.haltedSeconds, t.observedSeconds).toFixed(3)}%.`,
    `- **If no verdict ever landed** (oracle down, every halt runs 15 minutes): ${n0(f.refused)} refused, ${f.halts} halts, ${n0(f.inHalt)} swaps during halts, ${dur(f.haltedSeconds)} halted.`,
    "",
    "| Launch | Token | Pair | Swaps | Senders | Refused (up / down) | Breakouts | Halts | Swaps in halts | Halted, first 24 h | Halted, % of life | Verdicts O / C / I | First-hour high |",
    "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const p of rep.pools) {
    if (p.swaps === 0) continue;
    out.push(
      `| ${p.launchNumber} | ${p.symbol} | ${p.pair} | ${n0(p.swaps)} | ${n0(p.traders)} | ${p.refused.total} (${p.refused.up} / ${p.refused.down}) | ${p.refused.streaks} | ${p.halts} | ${p.inHalt} | ${p.haltedFirstDay > 0 ? `${dur(p.haltedFirstDay)} (${p.firstDayHaltedPct.toFixed(1)}%)` : "—"} | ${p.halts > 0 ? `${p.timeHaltedPct.toFixed(2)}%` : "—"} | ${p.halts > 0 ? `${p.verdicts.organic} / ${p.verdicts.concentrated} / ${p.verdicts.inconclusive}` : "—"} | ${p1(p.firstHour.maxUpPct)} |`,
    );
  }
  out.push(
    `| **All** | | | **${n0(t.swaps)}** | **${n0(t.traders)}** | **${t.refused} (${t.refusedUp} / ${t.refusedDown})** | **${t.refusedStreaks}** | **${t.halts}** | **${t.inHalt}** | **${dur(t.haltedFirstDay)}** | **${of(t.haltedSeconds, t.observedSeconds).toFixed(3)}%** | **${t.verdicts.organic} / ${t.verdicts.concentrated} / ${t.verdicts.inconclusive}** | |`,
  );
  const idle = rep.pools.filter((p) => p.swaps === 0);
  if (idle.length > 0) {
    out.push("", `Never traded: ${idle.map((p) => `${p.launchNumber} ${p.symbol}/${p.pair}`).join(", ")}.`);
  }

  out.push("", "### The most violent launches", "");
  for (const n of rep.violentFirstHour.slice(0, 5)) {
    const p = rep.pools.find((x) => x.launchNumber === n)!;
    const hourHalts = p.haltList.filter((h) => h.start < p.launchTime + 3600);
    const verdicts = hourHalts.map((h) => `${h.verdict}, top sender ${share(h.shareBps)} of ${h.traders}`).join("; ");
    out.push(
      `- **${p.launchNumber} ${p.symbol}/${p.pair}:** ${p1(p.firstHour.maxUpPct)} at the first hour's high over ${p.firstHour.swaps} swaps; its biggest single swap moved the price ${p1(p.firstHour.biggestSwapPct)}. ` +
        `Curb would have refused ${p.firstHour.refused} of those swaps and ${p.firstHour.halts === 0 ? "never halted" : `halted ${times(p.firstHour.halts)} (${verdicts})`}. ` +
        `Over its life: ${p.refused.total} refused in ${p.refused.streaks} breakouts, ${p.halts} halts, ${dur(p.haltedSeconds)} halted.`,
    );
  }

  out.push(
    "",
    "### Every halt",
    "",
    "| Launch | Incident | Halt start (UTC) | Lasted | Token vs reference | Window (L2 blocks) | Senders | Top sender | Top share | Verdict | Swaps during |",
    "|---:|---:|---|---:|---:|---|---:|---|---:|---|---:|",
  );
  for (const p of rep.pools) {
    for (const h of p.haltList) {
      out.push(
        `| ${p.launchNumber} ${p.symbol} | ${h.nonce} | ${h.startIso.replace("T", " ").replace("Z", "")} | ${dur(h.seconds)} | ${p1(h.movePct)} | ${n0(h.window.fromBlock)}–${n0(h.window.toBlock)} | ${h.traders} | ${h.leader ? `\`${short(h.leader)}\`` : "—"} | ${share(h.shareBps)} | ${h.verdict} | ${h.swapsInside} |`,
      );
    }
  }
  out.push(
    "",
    "*Token vs reference* is the token's price when the halt began, against the reference in force when its limit state began. Beyond ±10.5% the run there was made of swaps Curb would have refused.",
  );
  return out.join("\n");
}
