import { formatUnits, parseUnits } from "viem";

const sigCache = new Map<number, Intl.NumberFormat>();

/** A number to `sig` significant digits, grouped, never in exponent notation. */
export function formatSig(x: number, sig = 4): string {
  if (!Number.isFinite(x)) return "—";
  let f = sigCache.get(sig);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { maximumSignificantDigits: sig });
    sigCache.set(sig, f);
  }
  return f.format(x);
}

/** A token amount in base units, as a short decimal: 1065106246299 wei -> "0.000001065". */
export function formatAmount(value: bigint, decimals: number, sig = 4): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = formatSig(Number(formatUnits(abs, decimals)), sig);
  return neg ? `−${s}` : s;
}

/** Parses what someone typed into an amount field. Null for anything that is not a positive amount. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const frac = s.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  const v = parseUnits(s, decimals);
  return v > 0n ? v : null;
}

/** An amount in base units back into the plain decimal a person would type. */
export function amountInput(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

export function formatInt(n: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** Ticks and other signed integers with a true minus sign. */
export function formatTick(n: number): string {
  return n < 0 ? `−${formatInt(-n)}` : formatInt(n);
}

export function shortHex(h: string, head = 6, tail = 4): string {
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "45s", "5m 00s", "1h 05m", "2d 04h". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${pad2(Math.floor((s % 86400) / 3600))}h`;
}

/** Plain words for a parameter: 300 -> "5 min", 15 -> "15 s", 3600 -> "1 h". */
export function formatSpan(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** "18:35:15 UTC". The chain keeps UTC, so the site does too. */
export function formatClock(ts: number): string {
  const d = new Date(ts * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 19, 18:35:15 UTC". */
export function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${formatClock(ts)}`;
}

/** "in 4m 12s", "3m 10s ago", "now". */
export function formatRelative(ts: number, now: number): string {
  const d = ts - now;
  if (Math.abs(d) < 1) return "now";
  return d > 0 ? `in ${formatDuration(d)}` : `${formatDuration(-d)} ago`;
}
