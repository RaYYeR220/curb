import { formatSig } from "./format";

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** What a pool trades: the launched token and the currency it is paired with. */
export interface PairInfo {
  token: { symbol: string; decimals: number };
  paired: { symbol: string; decimals: number };
  /** Whether the launched token is currency0, which decides which way the tick runs. */
  tokenIs0: boolean;
}

/**
 * A tick on an axis where up means the launched token got dearer. v4 ticks price currency0 in
 * currency1, so when the token is currency1 a buy lowers the tick; flipping the sign keeps every
 * chart and sentence reading the way a trader expects.
 */
export function priceAxis(tick: number, tokenIs0: boolean): number {
  return tokenIs0 ? tick : -tick;
}

/** The tick behind a value on the price axis. */
export function fromPriceAxis(v: number, tokenIs0: boolean): number {
  return tokenIs0 ? v : -v;
}

/** One launched token in units of the paired currency, at `tick`. */
export function tokenPrice(tick: number, pair: PairInfo): number {
  const t = priceAxis(tick, pair.tokenIs0);
  return Math.pow(1.0001, t) * 10 ** (pair.token.decimals - pair.paired.decimals);
}

/** How far `ticks` moves a price, in percent: 1,000 ticks is about 10.5%. */
export function tickPercent(ticks: number): number {
  return (Math.pow(1.0001, ticks) - 1) * 100;
}

/** The token's price change from one tick to another, in percent (positive = dearer). */
export function movePercent(fromTick: number, toTick: number, tokenIs0: boolean): number {
  return tickPercent(priceAxis(toTick, tokenIs0) - priceAxis(fromTick, tokenIs0));
}

export function formatPercent(p: number, sig = 3): string {
  const sign = p > 0 ? "+" : p < 0 ? "−" : "";
  return `${sign}${formatSig(Math.abs(p), sig)}%`;
}

const LOTS: readonly [number, string][] = [
  [1, ""],
  [1e3, "1K "],
  [1e6, "1M "],
  [1e9, "1B "],
  [1e12, "1T "],
];

export interface ReadablePrice {
  value: number;
  lot: number;
  text: string;
}

/**
 * A price a person can read without counting zeros: a memecoin at 1e-10 ETH reads as
 * "0.1002 ETH per 1B DRILL". The lot is the smallest round size that lifts the price past 0.01.
 */
export function readablePrice(price: number, pair: PairInfo, sig = 4): ReadablePrice {
  let chosen = LOTS[LOTS.length - 1]!;
  for (const lot of LOTS) {
    if (price * lot[0] >= 0.01) {
      chosen = lot;
      break;
    }
  }
  const value = price * chosen[0];
  return { value, lot: chosen[0], text: `${formatSig(value, sig)} ${pair.paired.symbol} per ${chosen[1]}${pair.token.symbol}` };
}

/** Whether a tick sits at the end of the curve, where a swap ran out of liquidity. */
export function isCurveEnd(tick: number): boolean {
  return tick <= MIN_TICK + 1 || tick >= MAX_TICK - 1;
}
