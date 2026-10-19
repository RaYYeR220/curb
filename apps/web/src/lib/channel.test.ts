import { describe, expect, it } from "vitest";
import { stepPath, steps, timeScale, valueDomain } from "./channel";

describe("timeScale", () => {
  const opts = { maxGap: 600, gapPx: 30, pad: 60 };

  it("is linear when nothing is folded", () => {
    const s = timeScale([100, 200, 600], 0, 1000, 1000, opts);
    expect(s.gaps).toHaveLength(0);
    expect(s.x(0)).toBe(0);
    expect(s.x(500)).toBeCloseTo(500);
    expect(s.x(1000)).toBe(1000);
  });

  it("folds a long quiet stretch and keeps one scale for the rest", () => {
    // Two bursts a day apart: [0, 300] and [86400, 86700], ending at 86700.
    const s = timeScale([0, 300, 86400, 86700], 0, 86700, 1000, opts);
    expect(s.gaps).toHaveLength(1);
    const g = s.gaps[0]!;
    expect(g.x1 - g.x0).toBeCloseTo(30, 6);
    const [a, b] = s.spans;
    // Each burst spans its activity plus 60 s of air either side, clipped to the range.
    expect([a!.from, a!.to, b!.from, b!.to]).toEqual([0, 360, 86340, 86700]);
    // Same seconds-to-pixels inside both spans.
    expect((a!.x1 - a!.x0) / (a!.to - a!.from)).toBeCloseTo((b!.x1 - b!.x0) / (b!.to - b!.from), 6);
    expect(b!.x1).toBeCloseTo(1000);
    // Monotonic through the fold.
    expect(s.x(360)).toBeLessThan(s.x(40000));
    expect(s.x(40000)).toBeLessThan(s.x(86340));
  });

  it("never lets gaps take more than a third of the width", () => {
    const times = Array.from({ length: 20 }, (_, i) => i * 10000);
    const s = timeScale(times, 0, 190000, 600, opts);
    const folded = s.gaps.reduce((sum, g) => sum + (g.x1 - g.x0), 0);
    expect(folded).toBeLessThanOrEqual(200 + 1e-9);
  });
});

describe("steps", () => {
  it("holds each value until the next change, from the value in force at the start", () => {
    const st = steps(
      [
        { t: 0, v: 230400 },
        { t: 500, v: 230129 },
        { t: 2000, v: 1 },
      ],
      100,
      1000,
    );
    expect(st).toEqual([
      { from: 100, to: 500, v: 230400 },
      { from: 500, to: 1000, v: 230129 },
    ]);
  });

  it("starts at the first point when nothing precedes the range", () => {
    expect(steps([{ t: 300, v: 7 }], 100, 400)).toEqual([{ from: 300, to: 400, v: 7 }]);
    expect(steps([], 0, 10)).toEqual([]);
  });

  it("draws a stepped path", () => {
    const d = stepPath(
      [
        { from: 0, to: 10, v: 1 },
        { from: 10, to: 20, v: 2 },
      ],
      (t) => t * 2,
      (v) => v * 10,
    );
    expect(d).toBe("M0.0 10.0H20.0V20.0H40.0");
  });
});

describe("valueDomain", () => {
  it("shows every band with air, and clamps runaway prices", () => {
    const [lo, hi] = valueDomain([-230129], 300, [-230129, 887272]);
    expect(lo).toBeLessThan(-230129 - 300);
    expect(hi).toBeGreaterThan(-230129 + 300);
    expect(hi).toBeLessThan(-230129 + 300 * 2.5);
  });
});

describe("channelSeries", () => {
  it("rebuilds the drill's channel from its logs", async () => {
    const { drillLogs } = await import("./fixtures");
    const { channelSeries } = await import("./channel");
    const swaps = [
      { eventName: "Swap", args: { tick: 230129 }, timestamp: 1792437689 },
      { eventName: "Swap", args: { tick: 230129 }, timestamp: 1792438019 },
    ];
    const s = channelSeries({
      hookLogs: drillLogs,
      swaps,
      init: { timestamp: 1792437660, tick: 230400 },
      status: { nonce: 1, ref: 230129, tick: 230129, edgeSince: 0, haltStart: 0, reopensAt: 0 },
      now: 1792440000,
    });
    expect(s.refs).toEqual([
      { t: 1792437660, v: 230400 },
      { t: 1792438019, v: 230129 },
    ]);
    expect(s.prices.map((p) => p.v)).toEqual([230400, 230129, 230129, 230129]);
    expect(s.halts).toEqual([{ start: 1792437699, end: 1792437999, nonce: 0, open: false }]);
  });

  it("adds a halt in progress and falls back to the status reference", async () => {
    const { channelSeries } = await import("./channel");
    const s = channelSeries({
      hookLogs: [],
      swaps: [],
      status: { nonce: 2, ref: 10, tick: 280, edgeSince: 100, haltStart: 110, reopensAt: 410 },
      now: 200,
    });
    expect(s.refs).toEqual([{ t: 200, v: 10 }]);
    expect(s.halts).toEqual([{ start: 110, end: 200, nonce: 2, open: true }]);
  });
});
