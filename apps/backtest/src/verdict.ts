import type { Address } from "viem";
import { Verdict } from "@curb/sdk";

/** One entry of CurbHook's tape: Trade(tx.origin, |paired delta|). */
export interface Trade {
  block: number;
  trader: Address;
  volume: bigint;
}

export const ORGANIC_MAX_BPS = 3000;
export const CONCENTRATED_MIN_BPS = 6000;

/** CurbDesk.classify: the top trader's share of the window's paired volume, and the verdict. */
export function classify(figure: bigint, total: bigint): { verdict: Verdict; shareBps: number } {
  if (total === 0n || figure === 0n || figure > total) return { verdict: Verdict.Inconclusive, shareBps: 0 };
  const shareBps = Number((figure * 10_000n) / total);
  if (shareBps <= ORGANIC_MAX_BPS) return { verdict: Verdict.Organic, shareBps };
  if (shareBps >= CONCENTRATED_MIN_BPS) return { verdict: Verdict.Concentrated, shareBps };
  return { verdict: Verdict.Inconclusive, shareBps };
}

export interface Ranking {
  leader?: Address;
  figure: bigint;
  total: bigint;
  traders: number;
}

/**
 * What the desk's oracle question asks: rank the tape's traders by summed volume over the
 * incident window's blocks, inclusive. A tie goes to the lower address so reruns agree.
 */
export function rank(tape: readonly Trade[], fromBlock: number, toBlock: number): Ranking {
  const sums = new Map<Address, bigint>();
  let total = 0n;
  for (const t of tape) {
    if (t.block < fromBlock || t.block > toBlock) continue;
    sums.set(t.trader, (sums.get(t.trader) ?? 0n) + t.volume);
    total += t.volume;
  }
  let leader: Address | undefined;
  let figure = 0n;
  for (const [trader, v] of sums) {
    if (v > figure || (v === figure && leader !== undefined && trader < leader)) {
      leader = trader;
      figure = v;
    }
  }
  return { leader, figure, total, traders: sums.size };
}
