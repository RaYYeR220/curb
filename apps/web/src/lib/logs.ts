/** Robinhood's RPC refuses log queries wider than 10,000,000 blocks. */
export const MAX_LOG_RANGE = 9_000_000n;

/** Splits [from, to] into inclusive ranges no wider than `max` blocks. */
export function blockRanges(from: bigint, to: bigint, max: bigint = MAX_LOG_RANGE): [bigint, bigint][] {
  if (to < from || max <= 0n) return [];
  const out: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += max) {
    const b = a + max - 1n;
    out.push([a, b < to ? b : to]);
  }
  return out;
}
