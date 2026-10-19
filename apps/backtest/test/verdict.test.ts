import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { Verdict } from "@curb/sdk";
import { classify, rank } from "../src/verdict";

const a = "0x00000000000000000000000000000000000000a1" as Address;
const b = "0x00000000000000000000000000000000000000b2" as Address;
const c = "0x00000000000000000000000000000000000000c3" as Address;

describe("the desk's verdict rule", () => {
  it("draws the lines where CurbDesk.classify does", () => {
    expect(classify(30n, 100n)).toEqual({ verdict: Verdict.Organic, shareBps: 3000 });
    expect(classify(3001n, 10_000n)).toEqual({ verdict: Verdict.Inconclusive, shareBps: 3001 });
    expect(classify(5999n, 10_000n)).toEqual({ verdict: Verdict.Inconclusive, shareBps: 5999 });
    expect(classify(60n, 100n)).toEqual({ verdict: Verdict.Concentrated, shareBps: 6000 });
    expect(classify(1n, 3n)).toEqual({ verdict: Verdict.Inconclusive, shareBps: 3333 });
  });

  it("reads a leader with no volume, or more than the total, as no answer", () => {
    expect(classify(0n, 100n)).toEqual({ verdict: Verdict.Inconclusive, shareBps: 0 });
    expect(classify(5n, 0n)).toEqual({ verdict: Verdict.Inconclusive, shareBps: 0 });
    expect(classify(101n, 100n)).toEqual({ verdict: Verdict.Inconclusive, shareBps: 0 });
  });

  it("ranks the tape over the window's blocks, inclusive", () => {
    const tape = [
      { block: 9, trader: c, volume: 1000n },
      { block: 10, trader: a, volume: 40n },
      { block: 11, trader: b, volume: 30n },
      { block: 12, trader: b, volume: 30n },
      { block: 13, trader: c, volume: 1000n },
    ];
    expect(rank(tape, 10, 12)).toEqual({ leader: b, figure: 60n, total: 100n, traders: 2 });
  });

  it("breaks a tie toward the lower address", () => {
    const tape = [
      { block: 1, trader: c, volume: 5n },
      { block: 1, trader: a, volume: 5n },
    ];
    expect(rank(tape, 1, 1).leader).toBe(a);
  });
});
