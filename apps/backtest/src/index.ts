import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Cache } from "./cache";
import { Collector } from "./collect";
import { CURB, FLOOR_BPS, LOOKBACK_DAYS, RPC_URL, VERDICT_LATENCY } from "./config";
import { buildReport, renderMarkdown } from "./report";
import { replay } from "./replay";
import { Rpc } from "./rpc";

const { values } = parseArgs({
  // pnpm hands a separating `--` through to the script.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    days: { type: "string", default: String(LOOKBACK_DAYS) },
    "to-block": { type: "string" },
    latency: { type: "string", default: String(VERDICT_LATENCY) },
    rpc: { type: "string", default: RPC_URL },
  },
});

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = join(root, "backtest");
const started = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

const days = Number(values.days);
const latency = Number(values.latency);
const rpc = new Rpc(values.rpc!);
const collected = await new Collector(rpc, new Cache(join(dir, ".cache")), log).collect(
  days,
  values["to-block"] ? Number(values["to-block"]) : undefined,
);

const pools = collected.pools;
const endTime = collected.head.time;
const replays = pools.map((p) => replay(p, { config: CURB, floorBps: FLOOR_BPS, verdictLatency: latency, endTime }));
const fallback = pools.map((p) => replay(p, { config: CURB, floorBps: FLOOR_BPS, verdictLatency: null, endTime }));
const report = buildReport(collected, { config: CURB, floorBps: FLOOR_BPS, verdictLatency: latency, days }, pools, replays, fallback);

const date = report.head.iso.slice(0, 10);
mkdirSync(join(dir, "results"), { recursive: true });
const jsonPath = join(dir, "results", `${date}.json`);
writeFileSync(jsonPath, `${JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);

// The README keeps its method text; only the block between the markers is regenerated.
const readme = join(dir, "README.md");
const start = "<!-- results:start -->";
const end = "<!-- results:end -->";
const md = renderMarkdown(report);
if (existsSync(readme)) {
  const text = readFileSync(readme, "utf8");
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a >= 0 && b > a) writeFileSync(readme, `${text.slice(0, a + start.length)}\n${md}\n${text.slice(b)}`);
}

const t = report.totals;
log(`wrote ${jsonPath}`);
log(
  `${t.pools} pools, ${t.swaps} swaps, ${t.refused} refused, ${t.halts} halts ` +
    `(${t.verdicts.organic} organic / ${t.verdicts.concentrated} concentrated / ${t.verdicts.inconclusive} inconclusive), ` +
    `${t.inHalt} swaps in halts, ${rpc.requests} RPC requests`,
);
