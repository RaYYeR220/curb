import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { Verdict } from "@curb/sdk";
import { CURB, IMD } from "../src/config";
import { replay, type ReplayOptions } from "../src/replay";
import type { PoolData, PoolEvent, SwapEvent } from "../src/types";

const L = 10n ** 24n;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [A, B, C, D, E, F, G, H, I, J, K, M, N] = Array.from({ length: 13 }, (_, i) => addr(0xa0 + i)) as [
  Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address,
];

/** The token is currency0, so its price is the tick and the tape counts |amount1|. */
function swap(block: number, time: number, trader: Address, tick: number, volume: number, liquidity = L): SwapEvent {
  const tx = `0x${block.toString(16).padStart(64, "0")}` as Hex;
  return { kind: "swap", block, index: 1, time, tx, trader, amount0: -1n, amount1: BigInt(volume), liquidity, tick };
}

function pool(events: PoolEvent[], initTick = 0): PoolData {
  return {
    launchNumber: 1,
    token: addr(1),
    symbol: "SYN",
    hook: addr(2),
    requester: addr(3),
    paired: IMD,
    pairedIs0: false,
    poolId: `0x${"11".repeat(32)}`,
    fee: 12500,
    tickSpacing: 60,
    launchBlock: 100,
    launchTime: 1000,
    initTick,
    seeded: L,
    seedLower: -6000,
    seedUpper: 6000,
    events,
  };
}

const seed = { kind: "liquidity", block: 100, index: 0, tickLower: -6000, tickUpper: 6000, delta: L } as const;

// Four incidents on one pool, opened at tick 0 at t = 1000 with the CURB/IMD parameters.
const synthetic = pool([
  seed,
  swap(101, 1010, A, 500, 100),
  swap(102, 1020, A, 1200, 300), // past the band: refused; the limit clock starts at 1020
  swap(103, 1030, B, 1150, 100), // back toward the reference: passes
  swap(104, 1040, C, 1300, 100), // halt 0 began at 1035: A did 80% of the window, concentrated
  swap(105, 2000, C, 1250, 100), // the halt closed at 1935 and pinned the reference at 401
  swap(106, 2100, D, 1500, 50), // past the pinned band: refused
  swap(107, 4000, D, 1450, 50), // pin over, the reference rolls to 1500
  swap(108, 4100, E, 2450, 100), // into the edge zone; halt 1 at 4115
  swap(109, 4120, F, 2400, 100), // inside halt 1: C, D and E a third each, inconclusive
  swap(110, 5100, F, 2400, 100), // halt 1 ran its full 900 s
  swap(111, 6900, G, 2500, 100), // after the cooldown, the reference rolls to 2400
  swap(112, 6910, H, 2600, 100),
  swap(113, 6920, I, 2700, 100),
  swap(114, 6930, J, 2800, 100),
  swap(115, 6940, K, 3320, 100), // edge again; halt 2 at 6955
  swap(116, 7000, M, 3300, 100), // inside halt 2: six senders a sixth each, organic, reopens at 7045
  swap(117, 7100, M, 3250, 100),
  swap(118, 10000, N, 4250, 300), // edge after the cooldown; halt 3 at 10015, never traded into
]);

const withVerdicts: ReplayOptions = { config: CURB, floorBps: 700n, verdictLatency: 90, endTime: 10_500 };
const oracleDown: ReplayOptions = { ...withVerdicts, verdictLatency: null };

describe("shadow replay", () => {
  it("counts refusals, halts and swaps inside halts, and classifies each halt", () => {
    const r = replay(synthetic, withVerdicts);
    expect(r.swaps).toBe(18);
    expect(r.traders).toBe(13);
    expect(r.passed).toBe(13);
    expect(r.refused).toEqual({ total: 2, up: 2, down: 0, intoVoid: 0, streaks: 2, traders: 2 });
    expect(r.inHalt).toBe(3);
    expect(r.rolls).toBe(3);
    expect(r.outcomes.slice(0, 7)).toEqual(["passed", "refused", "passed", "halted", "passed", "refused", "passed"]);

    expect(r.halts.map((h) => h.verdict)).toEqual([Verdict.Concentrated, Verdict.Inconclusive, Verdict.Organic, Verdict.Concentrated]);
    expect(r.halts.map((h) => h.shareBps)).toEqual([8000, 3333, 1666, 7500]);
    expect(r.halts.map((h) => h.applied)).toEqual([true, false, true, true]);
    expect(r.halts.map((h) => [h.start, h.end])).toEqual([
      [1035, 1935],
      [4115, 5015],
      [6955, 7045],
      [10015, 10915],
    ]);
    expect(r.halts.map((h) => h.window)).toEqual([
      { fromBlock: 100, toBlock: 103 },
      { fromBlock: 105, toBlock: 108 },
      { fromBlock: 110, toBlock: 115 },
      { fromBlock: 117, toBlock: 118 },
    ]);
    expect(r.halts.map((h) => h.leader)).toEqual([A, C, F, N]);
    expect(r.halts.map((h) => h.swapsInside)).toEqual([1, 1, 1, 0]);
    expect(r.halts[0]!.newRef).toBe(401);
    expect(r.halts[3]!.closed).toBe(false);
    expect(r.haltedSeconds).toBe(900 + 900 + 90 + 485);
    expect(r.haltedFirstDay).toBe(r.haltedSeconds);
  });

  it("records what each refusal asked for", () => {
    const [first, second] = replay(synthetic, withVerdicts).refusals;
    expect(first).toMatchObject({ block: 102, trader: A, side: "up", tickBefore: 500, tickAfter: 1200, ref: 0, limit: 1000 });
    expect(second).toMatchObject({ block: 106, trader: D, tickBefore: 1250, tickAfter: 1500, ref: 401, limit: 1401 });
  });

  it("runs every halt to its end when no verdict lands", () => {
    const r = replay(synthetic, oracleDown);
    // No pin after halt 0, so swap 106 fits the re-centred band; the unshortened halt 2 catches 117.
    expect(r.refused.total).toBe(1);
    expect(r.inHalt).toBe(4);
    expect(r.passed).toBe(13);
    expect(r.halts.map((h) => h.verdict)).toEqual([Verdict.Concentrated, Verdict.Inconclusive, Verdict.Organic, Verdict.Inconclusive]);
    expect(r.halts.every((h) => !h.applied)).toBe(true);
    expect(r.halts[3]!.window).toEqual({ fromBlock: 111, toBlock: 118 });
    expect(r.haltedSeconds).toBe(900 + 900 + 900 + 485);
  });

  it("judges a swap from an empty range by where liquidity begins", () => {
    // Liquidity only below tick 0; the pool opens at 3000, where nothing trades.
    const p = pool(
      [
        { kind: "liquidity", block: 100, index: 0, tickLower: -6000, tickUpper: 0, delta: L },
        swap(101, 1010, A, -500, 100),
        swap(102, 1020, B, -1500, 100),
      ],
      3000,
    );
    const r = replay(p, withVerdicts);
    // 3000 -> -500 is 3,500 ticks from the reference but 500 from the liquidity at 0: admitted,
    // and the reference re-anchors at 399. The next swap is judged from there as usual.
    expect(r.outcomes).toEqual(["reanchored", "refused"]);
    expect(r.refusals[0]).toMatchObject({ ref: 399, limit: -601 });
  });

  it("never starts the limit clock below the liquidity floor", () => {
    const thin = L / 100n;
    const p = pool([seed, swap(101, 1010, A, 950, 100, thin), swap(102, 1100, B, 960, 100, thin)]);
    const r = replay(p, withVerdicts);
    expect(r.halts).toHaveLength(0);
    expect(r.outcomes).toEqual(["passed", "passed"]);
  });
});
