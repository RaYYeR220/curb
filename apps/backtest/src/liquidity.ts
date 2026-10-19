/**
 * The pool's liquidity as CurbHook reads it, rebuilt from the PoolManager's events: in-range
 * liquidity (getLiquidity) and per-tick liquidityGross (getTickLiquidity), so the replay can tell
 * whether a price is a market and where liquidity begins for a swap that started without it.
 */
export class Liquidity {
  /** liquidityGross per initialised tick. */
  private readonly gross = new Map<number, bigint>();
  tick: number;
  inRange = 0n;

  constructor(
    private readonly spacing: number,
    private readonly floor: bigint,
    initTick: number,
  ) {
    this.tick = initTick;
  }

  /** A ModifyLiquidity: v4 moves in-range liquidity when lower <= tick < upper. */
  modify(tickLower: number, tickUpper: number, delta: bigint): void {
    for (const t of [tickLower, tickUpper]) {
      const g = (this.gross.get(t) ?? 0n) + delta;
      if (g === 0n) this.gross.delete(t);
      else this.gross.set(t, g);
    }
    if (tickLower <= this.tick && this.tick < tickUpper) this.inRange += delta;
  }

  /** A Swap reports the tick and in-range liquidity it left. */
  swapped(tick: number, liquidity: bigint): void {
    this.tick = tick;
    this.inRange = liquidity;
  }

  liquid(): boolean {
    return this.inRange >= this.floor;
  }

  /**
   * CurbHook._liquidityBoundary: the first initialised tick crossed from `from` toward `to` that
   * carries at least the floor of liquidityGross. Going up the search starts past `from`'s own
   * spacing slot; going down it includes it, as the bitmap walk does.
   */
  boundary(from: number, to: number): number | undefined {
    const up = to > from;
    const start = Math.floor(from / this.spacing) + (up ? 1 : 0);
    const startWord = start >> 8;
    let best: number | undefined;
    for (const [t, g] of this.gross) {
      if (g < this.floor) continue;
      const c = Math.floor(t / this.spacing);
      if (up ? c < start || t > to : c > start || t < to) continue;
      // The walk reads at most 64 bitmap words.
      if (Math.abs((c >> 8) - startWord) >= 64) continue;
      if (best === undefined || (up ? t < best : t > best)) best = t;
    }
    return best;
  }
}
