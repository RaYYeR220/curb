import { describe, expect, it } from "vitest";
import { Liquidity } from "../src/liquidity";

const floor = 100n;

function book(initTick: number): Liquidity {
  const l = new Liquidity(60, floor, initTick);
  l.modify(-6000, 0, 1000n);
  l.modify(600, 1200, 50n); // dust: initialised, below the floor
  l.modify(1800, 2400, 500n);
  return l;
}

describe("liquidity as the hook reads it", () => {
  it("moves in-range liquidity only for positions holding the current tick", () => {
    const l = book(0);
    // [lower, upper): at tick 0 the [-6000, 0) seed is out of range.
    expect(l.inRange).toBe(0n);
    expect(l.liquid()).toBe(false);
    l.swapped(-60, 1000n);
    l.modify(-120, 120, 40n);
    expect(l.inRange).toBe(1040n);
    l.modify(-120, 120, -40n);
    expect(l.liquid()).toBe(true);
  });

  it("finds the first tick crossed that carries the floor, skipping dust", () => {
    const l = book(0);
    expect(l.boundary(300, 3000)).toBe(1800);
    expect(l.boundary(3000, -500)).toBe(2400);
    expect(l.boundary(1500, -500)).toBe(0);
    expect(l.boundary(1500, 1700)).toBeUndefined();
  });

  it("starts an upward search past the start's own slot and a downward one on it", () => {
    const l = book(0);
    expect(l.boundary(1800, 3000)).toBe(2400);
    expect(l.boundary(1830, 1000)).toBe(1800);
    expect(l.boundary(0, -100)).toBe(0);
  });

  it("forgets a tick once its positions are gone", () => {
    const l = book(0);
    l.modify(1800, 2400, -500n);
    expect(l.boundary(300, 3000)).toBeUndefined();
  });
});
