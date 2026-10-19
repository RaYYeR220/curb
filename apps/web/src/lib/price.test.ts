import { describe, expect, it } from "vitest";
import {
  formatPercent,
  fromPriceAxis,
  isCurveEnd,
  movePercent,
  priceAxis,
  readablePrice,
  tickPercent,
  tokenPrice,
  type PairInfo,
} from "./price";

// The drill pool: native ETH is currency0, DRILL is currency1.
const drill: PairInfo = { token: { symbol: "DRILL", decimals: 18 }, paired: { symbol: "ETH", decimals: 18 }, tokenIs0: false };
const curbBelow: PairInfo = { token: { symbol: "CURB", decimals: 18 }, paired: { symbol: "IMD", decimals: 18 }, tokenIs0: true };

describe("price", () => {
  it("orients the axis so a buy of the token reads as up", () => {
    expect(priceAxis(230129, false)).toBe(-230129);
    expect(priceAxis(230129, true)).toBe(230129);
    expect(fromPriceAxis(priceAxis(-5, false), false)).toBe(-5);
    // A drill buy lowers the tick; on the price axis it rises.
    expect(priceAxis(229934, false)).toBeGreaterThan(priceAxis(230129, false));
  });

  it("prices the token in the paired currency", () => {
    expect(tokenPrice(230129, drill)).toBeCloseTo(Math.pow(1.0001, -230129), 20);
    expect(tokenPrice(0, curbBelow)).toBe(1);
    expect(tokenPrice(6932, curbBelow)).toBeCloseTo(2, 2);
  });

  it("states band widths as percentages", () => {
    expect(tickPercent(1000)).toBeCloseTo(10.517, 2);
    expect(tickPercent(300)).toBeCloseTo(3.045, 2);
    expect(movePercent(230129, 229934, false)).toBeCloseTo(tickPercent(195), 6);
    expect(formatPercent(10.517)).toBe("+10.5%");
    expect(formatPercent(-3.045)).toBe("−3.05%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("picks a lot that keeps the price readable", () => {
    const r = readablePrice(tokenPrice(230129, drill), drill);
    expect(r.lot).toBe(1e9);
    expect(r.text).toMatch(/^0\.10\d+ ETH per 1B DRILL$/);
    expect(readablePrice(2.5e-6, curbBelow).text).toBe("2.5 IMD per 1M CURB");
    expect(readablePrice(3.2, curbBelow).text).toBe("3.2 IMD per CURB");
  });

  it("recognises a swap that ran to the end of the curve", () => {
    expect(isCurveEnd(-887272)).toBe(true);
    expect(isCurveEnd(887271)).toBe(true);
    expect(isCurveEnd(230129)).toBe(false);
  });
});
