import { stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { spans, curbIncidents } from "../src/tools/incidents";
import { DESK, DRILL_HOOK, NOW, drillStatus, fakeClient, fakeContext, log } from "./fakes";

const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const CLOSE_TX = "0x9de3edbec3a9433a18919fac13b2344760c04e1adcb166967fc20e7bbe15a9dd";
const REQ_A = `0x${"aa".repeat(32)}` as const;
const REQ_B = `0x${"bb".repeat(32)}` as const;
const LEADER = "0x00000000000000000000000000000000000000Ad";

describe("spans", () => {
  it("cuts a scan into ranges the RPC accepts", () => {
    expect(spans(10n, 25n, 10n)).toEqual([
      [10n, 19n],
      [20n, 25n],
    ]);
    expect(spans(5n, 5n, 10n)).toEqual([[5n, 5n]]);
  });
});

describe("curb_incidents", () => {
  it("notes that the drill's halt ran unfunded, with links", async () => {
    const client = fakeClient({
      events: {
        HaltClosed: [
          log("HaltClosed", { nonce: 0, haltStart: 1792437699n, haltEnd: 1792437999n, verdict: 0, newRef: 230129, cooldownEnd: 1792438299n }, CLOSE_TX),
        ],
      },
    });
    const out = await curbIncidents(fakeContext(client), {});
    expect(out.incidents).toHaveLength(1);
    const [i] = out.incidents;
    expect(i).toMatchObject({
      nonce: 0,
      state: "closed",
      halt: { start: "2026-10-19T19:21:39Z", end: "2026-10-19T19:26:39Z", seconds: 300 },
      close: { verdict: "none", newReference: 230129, cooldownEnd: "2026-10-19T19:31:39Z", tx: `https://robin.etherscan.io/tx/${CLOSE_TX}` },
      filed: null,
      answer: null,
    });
    expect(i!.notes[0]).toContain("ran unfunded: fileIncident reverted TreasuryShort");
    expect(i!.notes[0]).toContain("https://robin.etherscan.io/tx/0xb5e739198e9868f42f2510264755d495e42f1ff8202eadc889d3fac1cfe79ab7");
    expect(out.desk).toMatchObject({ address: DESK, treasury: "0 IMD", questionPrice: "0.5 IMD", canPayForQuestion: false });
    expect(out.summary).toContain("would revert TreasuryShort");
    expect(out.drillProofs?.treasuryShort).toBe("https://robin.etherscan.io/tx/0xb5e739198e9868f42f2510264755d495e42f1ff8202eadc889d3fac1cfe79ab7");
  });

  it("joins halts, filings, verdicts and failures by incident, newest first", async () => {
    const client = fakeClient({
      treasury: 2n * 10n ** 18n,
      status: drillStatus({ nonce: 3 }),
      events: {
        HaltClosed: [
          log("HaltClosed", { nonce: 1, haltStart: 1000n, haltEnd: 1200n, verdict: 1, newRef: 230000, cooldownEnd: 1000n + 300n + 300n }, TX(1)),
          log("HaltClosed", { nonce: 2, haltStart: 5000n, haltEnd: 5300n, verdict: 0, newRef: 230050, cooldownEnd: 5600n }, TX(2)),
        ],
        Resolved: [log("Resolved", { nonce: 1, verdict: 1, reopensAt: 1200n }, TX(3))],
        IncidentFiled: [
          log("IncidentFiled", { hook: DRILL_HOOK, nonce: 1, requestId: REQ_A, questionHash: `0x${"11".repeat(32)}`, fromBlock: 100n, toBlock: 200n, total: 4n * 10n ** 18n }, TX(4)),
          log("IncidentFiled", { hook: DRILL_HOOK, nonce: 2, requestId: REQ_B, questionHash: `0x${"22".repeat(32)}`, fromBlock: 300n, toBlock: 400n, total: 10n ** 18n }, TX(5)),
        ],
        VerdictReached: [
          log("VerdictReached", { hook: DRILL_HOOK, nonce: 1, verdict: 1, shareBps: 2500, leader: LEADER, figure: 10n ** 18n, total: 4n * 10n ** 18n, applied: true }, TX(6)),
        ],
        RequestFailed: [
          log("RequestFailed", { requestId: REQ_B, status: 2, reason: stringToHex("disagreed", { size: 32 }) }, TX(7)),
          log("RequestFailed", { requestId: `0x${"cc".repeat(32)}`, status: 1, reason: stringToHex("body_invalid", { size: 32 }) }, TX(8)),
        ],
      },
    });
    const out = await curbIncidents(fakeContext(client), { limit: 5 });
    expect(out.incidents.map((i) => i.nonce)).toEqual([2, 1]);
    const [two, one] = out.incidents;
    expect(one).toMatchObject({
      state: "closed",
      close: { verdict: "organic" },
      resolved: { verdict: "organic", reopensAt: "1970-01-01T00:20:00Z" },
      filed: { requestId: REQ_A, fromBlock: "100", toBlock: "200", windowVolume: "4 ETH" },
      answer: { verdict: "organic", shareBps: 2500, leader: LEADER, figure: "1 ETH", total: "4 ETH", applied: true },
      failure: null,
      notes: [],
    });
    expect(two).toMatchObject({ filed: { requestId: REQ_B }, answer: null, failure: { status: 2, reason: "disagreed", tx: `https://robin.etherscan.io/tx/${TX(7)}` } });
    expect(out.desk.canPayForQuestion).toBe(true);
    expect(out.summary).toContain("2 incidents on DRILL/ETH (drill pool)");
    expect(out.summary).toContain("would be paid");

    const filedCall = client.getContractEvents.mock.calls.find(([a]) => a.eventName === "IncidentFiled")![0];
    expect(filedCall).toMatchObject({ address: DESK, args: { hook: DRILL_HOOK }, fromBlock: 92_855_471n });
  });

  it("shows a halt in progress and how to file it", async () => {
    const status = drillStatus({ phase: 2, nonce: 5, edgeSince: BigInt(NOW - 20), haltStart: BigInt(NOW - 10), reopensAt: BigInt(NOW + 290) });
    const out = await curbIncidents(fakeContext(fakeClient({ status })), { limit: 1 });
    expect(out.phase).toBe("halted");
    expect(out.incidents[0]).toMatchObject({ nonce: 5, state: "in progress", halt: { seconds: 300 } });
    expect(out.incidents[0]!.notes[0]).toContain(`fileIncident(${DRILL_HOOK})`);
  });
});
