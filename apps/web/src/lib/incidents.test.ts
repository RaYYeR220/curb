import { describe, expect, it } from "vitest";
import { Phase, Verdict, type Status } from "@curb/sdk";
import type { Hex } from "viem";
import { CLOSE_TX, DRILL_HOOK, drillLogs, drillParams, INIT_BLOCK, LIMIT_TX, SHORT_TX, STEWARD } from "./fixtures";
import { buildIncidents, classify, rebuildWindow, tapeOver, type FailedFiling } from "./incidents";
import type { ChainLog } from "./timeline";

const shortFiling: FailedFiling = { hash: SHORT_TX, hook: DRILL_HOOK, block: 92858060n, timestamp: 1792437715, error: "TreasuryShort" };

describe("classify", () => {
  it("applies the desk's rule at its edges", () => {
    expect(classify(30n, 100n)).toEqual({ verdict: Verdict.Organic, shareBps: 3000 });
    expect(classify(31n, 100n)).toEqual({ verdict: Verdict.Inconclusive, shareBps: 3100 });
    expect(classify(60n, 100n)).toEqual({ verdict: Verdict.Concentrated, shareBps: 6000 });
    expect(classify(0n, 100n).verdict).toBe(Verdict.Inconclusive);
    expect(classify(5n, 0n).verdict).toBe(Verdict.Inconclusive);
    expect(classify(101n, 100n).verdict).toBe(Verdict.Inconclusive);
  });
});

describe("incident window", () => {
  it("rebuilds the drill's window from initialisation to the last swap before the halt", () => {
    expect(rebuildWindow(drillLogs, INIT_BLOCK, 1792437699)).toEqual({
      fromBlock: INIT_BLOCK,
      toBlock: 92857808n,
      source: "rebuilt",
    });
  });

  it("starts from the previous reference window once windows have shifted", () => {
    const roll = (block: bigint, ts: number): ChainLog => ({
      ...drillLogs[0]!,
      eventName: "ReferenceRolled",
      args: { nonce: 1, ref: 1, twap: 1, tick: 1 },
      blockNumber: block,
      timestamp: ts,
    });
    const trade = (block: bigint, ts: number): ChainLog => ({ ...drillLogs[0]!, blockNumber: block, timestamp: ts });
    const logs = [...drillLogs, roll(92870000n, 1792440000), trade(92870000n, 1792440000), roll(92880000n, 1792441000), trade(92880000n, 1792441000)];
    expect(rebuildWindow(logs, INIT_BLOCK, 1792441100)).toEqual({ fromBlock: 92870000n, toBlock: 92880000n, source: "rebuilt" });
  });

  it("gives up without a swap or a start", () => {
    expect(rebuildWindow(drillLogs, INIT_BLOCK, 1792437000)).toBeNull();
    expect(rebuildWindow(drillLogs.slice(0, 2), undefined, 1792437699)).toBeNull();
  });

  it("ranks the tape the way the oracle is asked to", () => {
    const tape = tapeOver(drillLogs, { fromBlock: INIT_BLOCK, toBlock: 92857808n, source: "rebuilt" });
    expect(tape).toMatchObject({ trades: 1, traders: 1, total: 1065106246299n, figure: 1065106246299n, shareBps: 10000 });
    expect(tape.leader?.toLowerCase()).toBe(STEWARD.toLowerCase());
    expect(tape.verdict).toBe(Verdict.Concentrated);
  });
});

describe("buildIncidents", () => {
  it("tells the drill's halt honestly: unfunded desk, full length, default policy", () => {
    const [inc, ...rest] = buildIncidents({
      hook: DRILL_HOOK,
      params: drillParams,
      hookLogs: drillLogs,
      deskLogs: [],
      initBlock: INIT_BLOCK,
      now: 1792439000,
      failedFilings: [shortFiling],
    });
    expect(rest).toHaveLength(0);
    expect(inc).toMatchObject({
      nonce: 0,
      state: "closed",
      haltStart: 1792437699,
      haltEnd: 1792437999,
      ranFull: true,
      limit: { tx: LIMIT_TX, tick: 230129, ref: 230400 },
      closed: { tx: CLOSE_TX, newRef: 230129, cooldownEnd: 1792438299, verdict: Verdict.None },
      window: { fromBlock: INIT_BLOCK, toBlock: 92857808n, source: "rebuilt" },
    });
    expect(inc!.failedFilings).toEqual([shortFiling]);
    expect(inc!.decision.kind).toBe("default");
    expect(inc!.decision.label).toBe("Desk unfunded: not asked");
    expect(inc!.decision.sentence).toContain("TreasuryShort");
    expect(inc!.decision.sentence).toContain("full 5 min");
  });

  it("joins a filed incident with its verdict", () => {
    const requestId: Hex = `0x${"ab".repeat(32)}`;
    const desk = (eventName: string, args: Record<string, unknown>, ts: number): ChainLog => ({
      ...drillLogs[0]!,
      eventName,
      args: { hook: DRILL_HOOK, ...args },
      timestamp: ts,
    });
    const deskLogs = [
      desk("IncidentFiled", { nonce: 0, requestId, questionHash: `0x${"cd".repeat(32)}`, fromBlock: 10n, toBlock: 20n, total: 100n }, 1792437710),
      desk("VerdictReached", { nonce: 0, verdict: 1, shareBps: 2500, leader: STEWARD, figure: 25n, total: 100n, applied: true }, 1792437750),
    ];
    const [inc] = buildIncidents({ hook: DRILL_HOOK, params: drillParams, hookLogs: drillLogs, deskLogs, now: 1792439000 });
    expect(inc!.window).toEqual({ fromBlock: 10n, toBlock: 20n, source: "filed" });
    expect(inc!.answer).toMatchObject({ verdict: Verdict.Organic, shareBps: 2500, applied: true });
    expect(inc!.decision.kind).toBe("organic");
  });

  it("includes a halt still in progress from the status read", () => {
    const status: Status = {
      phase: Phase.Halted,
      phaseName: "halted",
      nonce: 1,
      ref: 230129,
      lower: 229829,
      upper: 230429,
      tick: 229850,
      edgeSince: 1792440000,
      haltStart: 1792440010,
      reopensAt: 1792440310,
      cooldownEnd: 1792438299,
      pinUntil: 0,
      verdict: Verdict.None,
      fromBlock: 0n,
      toBlock: 0n,
      windowVolume: 0n,
    };
    const list = buildIncidents({ hook: DRILL_HOOK, params: drillParams, hookLogs: drillLogs, deskLogs: [], status, now: 1792440100 });
    expect(list.map((i) => [i.nonce, i.state])).toEqual([
      [1, "halted"],
      [0, "closed"],
    ]);
    expect(list[0]!.decision.kind).toBe("pending");
  });
});
