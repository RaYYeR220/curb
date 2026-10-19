import { formatUnits } from "viem";

/** Unix seconds as an ISO time; the hook writes 0 for "not set". */
export function iso(seconds: number | bigint): string | null {
  const s = Number(seconds);
  if (!s) return null;
  return new Date(s * 1000).toISOString().replace(".000Z", "Z");
}

export function amount(raw: bigint, decimals: number, symbol: string): string {
  return `${trim(formatUnits(raw < 0n ? -raw : raw, decimals))} ${symbol}`;
}

function trim(x: string): string {
  return x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x;
}

/** "in 4m 10s" / "2m ago", for summaries an agent reads once. */
export function relative(target: number, now: number): string {
  const d = target - now;
  const span = Math.abs(d);
  const text = span >= 3600 ? `${Math.floor(span / 3600)}h ${Math.floor((span % 3600) / 60)}m` : span >= 60 ? `${Math.floor(span / 60)}m ${span % 60}s` : `${span}s`;
  return d >= 0 ? `in ${text}` : `${text} ago`;
}

/** 300 -> "5 minutes", 15 -> "15 seconds". */
export function duration(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/** How far a tick distance moves the price, as a percentage. */
export function tickPercent(ticks: number): string {
  return `${((1.0001 ** ticks - 1) * 100).toFixed(1)}%`;
}

/** The launched token's price in the paired currency at `tick`, to six significant figures. */
export function tokenPrice(tick: number, tokenIs0: boolean, decimals0: number, decimals1: number): number {
  const oneIn0 = 1.0001 ** tick * 10 ** (decimals0 - decimals1);
  return Number((tokenIs0 ? oneIn0 : 1 / oneIn0).toPrecision(6));
}

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
