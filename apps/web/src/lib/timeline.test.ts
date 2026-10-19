import { describe, expect, it } from "vitest";
import { CLOSE_TX, drillLogs, LIMIT_TX } from "./fixtures";
import { describe as describeLog, mergeLogs, timeline, type ChainLog } from "./timeline";

const ctx = { paired: { symbol: "ETH", decimals: 18 } };

describe("timeline", () => {
  it("groups events by transaction, newest first, in emit order", () => {
    const items = timeline(drillLogs, ctx);
    expect(items.map((i) => i.tx)).toEqual([CLOSE_TX, LIMIT_TX]);
    expect(items[0]!.lines.map((l) => l.event)).toEqual(["HaltClosed", "Trade"]);
    expect(items[1]!.lines.map((l) => l.event)).toEqual(["Trade", "LimitEntered"]);
    expect(items[1]!.timestamp).toBe(1792437689);
  });

  it("writes each event as a sentence", () => {
    const [close, trade] = timeline(drillLogs, ctx)[0]!.lines;
    expect(close!.text).toBe(
      "Halt 0 closed after 5m 00s (no verdict, full length); reference set to 230,129, cooldown until 19:31:39 UTC",
    );
    expect(trade!.text).toBe("0xE83b…042c traded 0.000000001 ETH");
    const limit = timeline(drillLogs, ctx)[1]!.lines[1]!;
    expect(limit.kind).toBe("limit");
    expect(limit.text).toBe("Entered the edge zone at tick 230,129; halts at 19:21:39 UTC if it stays");
  });

  it("describes rolls, re-anchors, clears and verdicts", () => {
    const at = (eventName: string, args: Record<string, unknown>): ChainLog => ({ ...drillLogs[0]!, eventName, args });
    expect(describeLog(at("ReferenceRolled", { nonce: 1, ref: 100, twap: 90, tick: 120 }), ctx)!.text).toBe(
      "Reference rolled to 100 (window average 90)",
    );
    expect(describeLog(at("ReferenceReanchored", { nonce: 1, ref: -60, boundary: -120, tick: -30 }), ctx)!.text).toBe(
      "Reference re-anchored to −60, beside liquidity that starts at −120",
    );
    expect(describeLog(at("LimitCleared", { nonce: 1, tick: 5 }), ctx)!.text).toBe("Left the edge zone at tick 5");
    expect(describeLog(at("Resolved", { nonce: 2, verdict: 1, reopensAt: 1792437800n }), ctx)!.text).toBe(
      "Verdict organic applied to halt 2; reopens by 19:23:20 UTC",
    );
    expect(describeLog(at("Unknown", {}), ctx)).toBeNull();
  });

  it("caps the number of items", () => {
    expect(timeline(drillLogs, ctx, 1)).toHaveLength(1);
  });

  it("merges a fresh page without duplicates", () => {
    const merged = mergeLogs(drillLogs.slice(0, 3), drillLogs.slice(2));
    expect(merged).toHaveLength(4);
    expect(merged.map((l) => l.logIndex)).toEqual([3, 4, 1, 3]);
  });
});
