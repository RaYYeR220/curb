import { describe, expect, it } from "vitest";
import { Breaker, Phase, Verdict, type Config } from "../src/model";

// The same cases as test/Breaker.t.sol: CURB/IMD parameters, pool opened at tick 0 at t = 1000.
const config: Config = { band: 1000, edge: 100, refWindow: 300, limitSeconds: 15, haltSeconds: 900, cooldownSeconds: 1800 };

function fresh(): Breaker {
  return new Breaker(config, 0, 1000);
}

describe("the breaker model", () => {
  it("starts the limit clock at the edge and halts after limitSeconds", () => {
    const b = fresh();
    const after = b.swap(1010, 950, true);
    expect(after.limitEntered).toBe(true);
    expect(after.haltsAt).toBe(1025);
    expect(b.phase(1010)).toBe(Phase.Limit);
    expect(() => b.swap(1025, 900, true)).toThrow(/Halted\(0, 1925\)/);
    expect(b.phase(1025)).toBe(Phase.Halted);
  });

  it("refuses past the band and changes nothing", () => {
    const b = fresh();
    const before = { ...b.state };
    expect(() => b.swap(1010, 1001, true)).toThrow(/OutsideBand\(0, 1001, 1000/);
    expect(b.state).toEqual(before);
  });

  it("closes a halt at its maximum and re-centres", () => {
    const b = fresh();
    b.swap(1010, 950, true);
    const r = b.swap(1925, 950, true);
    expect(r.closed).toEqual({ nonce: 0, haltStart: 1025, haltEnd: 1925, verdict: Verdict.None, newRef: 950, cooldownEnd: 3725 });
    expect(b.state.nonce).toBe(1);
  });

  it("pins the pre-move reference, leaving the edge zone, on a concentrated verdict", () => {
    const b = fresh();
    b.swap(1010, 950, true);
    expect(b.resolve(1100, 0, Verdict.Concentrated)).toBe(1925);
    const r = b.swap(1925, 950, true);
    expect(r.closed?.newRef).toBe(51);
    expect(b.state.pinUntil).toBe(3725);
  });

  it("rolls with the time-weighted mean of post-close samples only", () => {
    const b = fresh();
    b.swap(1010, 950, true);
    b.resolve(1100, 0, Verdict.Concentrated);
    b.swap(1925, 950, true);
    b.swap(2000, 400, true);
    b.swap(2600, 400, true);
    b.swap(3600, 380, true);
    const r = b.swap(3730, 380, true);
    expect(r.rolled).toBe(true);
    expect(r.twap).toBe(421);
    expect(b.state.ref).toBe(421);
  });

  it("admits a swap from an empty range judged from the liquidity it reached", () => {
    const b = fresh();
    b.swapFull(1010, -900, true, false);
    const r = b.swapFull(1020, 1200, false, true, 300);
    expect(r.reanchored).toBe(true);
    expect(b.state.ref).toBe(301);
  });

  it("floors negative mean ticks", () => {
    const b = new Breaker(config, -1, 1000);
    b.swap(1001, -2, true);
    const r = b.swap(1300, -2, true);
    // -1 for 1 s, -2 for 299 s: -599 / 300 = -1.996... -> -2
    expect(r.twap).toBe(-2);
  });
});
