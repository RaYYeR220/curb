import { describe, expect, it } from "vitest";
import { resolveHook } from "../src/known";
import { curbStatus } from "../src/tools/status";
import { DRILL_HOOK, LAUNCH_HOOK, NOW, deployments, drillStatus, fakeClient, fakeContext } from "./fakes";

describe("resolveHook", () => {
  it("defaults to the drill pool until the launch hook is recorded", () => {
    expect(resolveHook(undefined, deployments)).toBe(DRILL_HOOK);
    expect(resolveHook(undefined, { ...deployments, launch: { hook: LAUNCH_HOOK } })).toBe(LAUNCH_HOOK);
  });

  it("takes names and addresses, and refuses anything else", () => {
    expect(resolveHook("drill", deployments)).toBe(DRILL_HOOK);
    expect(resolveHook("0x0000000000000000000000000000000000000abc", deployments)).toBe("0x0000000000000000000000000000000000000abc");
    expect(() => resolveHook("launch", deployments)).toThrow(/neither a hook address/);
  });
});

describe("curb_status", () => {
  it("reads an open pool: ticks, edge thresholds, times and a summary", async () => {
    const ctx = fakeContext(fakeClient());
    const out = await curbStatus(ctx, {});
    expect(out.hook).toBe(DRILL_HOOK);
    expect(out.pool).toBe("DRILL/ETH");
    expect(out.label).toBe("drill");
    expect(out.deskBinding).toBe("drill");
    expect(out.phase).toBe("open");
    expect(out.ticks).toEqual({
      current: 230129,
      reference: 230129,
      bandLower: 229829,
      bandUpper: 230429,
      edgeZoneLower: 229889,
      edgeZoneUpper: 230369,
    });
    expect(out.times.cooldownEnd).toBe("2026-10-19T19:31:39Z");
    expect(out.times.haltStart).toBeNull();
    expect(out.pin).toBeNull();
    expect(out.incidentWindow).toEqual({ fromBlock: "92857518", toBlock: "92861075", volume: "0.000001066106246299 ETH" });
    expect(out.params.maxHalt).toBe("5 minutes");
    expect(out.price).toMatch(/^1 DRILL = 1\.0\d+e-10 ETH$/);
    expect(out.summary).toBe(
      "DRILL/ETH is OPEN at tick 230129, band 229829..230429 (±3.0%) around reference 230129: swaps that end inside the band, or move toward the reference, pass.",
    );
    expect(out).not.toHaveProperty("knownPools");
  });

  it("names a halt, its incident and when it ends", async () => {
    const status = drillStatus({
      phase: 2,
      nonce: 0,
      ref: 230400,
      lower: 230100,
      upper: 230700,
      tick: 230129,
      edgeSince: 1792437689n,
      haltStart: 1792437699n,
      reopensAt: 1792437999n,
      cooldownEnd: 0n,
    });
    const out = await curbStatus(fakeContext(fakeClient({ status, now: 1792437800 })), { hook: "drill" });
    expect(out.phase).toBe("halted");
    expect(out.times.haltStart).toBe("2026-10-19T19:21:39Z");
    expect(out.times.reopensAt).toBe("2026-10-19T19:26:39Z");
    expect(out.summary).toContain("HALTED (incident 0)");
    expect(out.summary).toContain("until 2026-10-19T19:26:39Z at the latest (in 3m 19s)");
  });

  it("warns of a halt to come in the limit state", async () => {
    const status = drillStatus({ phase: 1, tick: 229880, edgeSince: BigInt(NOW - 4), haltStart: BigInt(NOW + 6), reopensAt: BigInt(NOW + 306) });
    const out = await curbStatus(fakeContext(fakeClient({ status })), {});
    expect(out.phase).toBe("limit");
    expect(out.summary).toContain("LIMIT state: tick 229880");
    expect(out.summary).toContain("halts both ways at");
    expect(out.summary).toContain("(in 6s)");
  });

  it("reports a pin and a halt that has ended but not closed", async () => {
    const status = drillStatus({
      phase: 3,
      nonce: 4,
      edgeSince: BigInt(NOW - 400),
      haltStart: BigInt(NOW - 390),
      reopensAt: BigInt(NOW - 90),
      cooldownEnd: BigInt(NOW + 210),
      pinUntil: BigInt(NOW + 210),
      verdict: 2,
    });
    const out = await curbStatus(fakeContext(fakeClient({ status })), {});
    expect(out.phase).toBe("cooldown");
    expect(out.verdict).toBe("concentrated");
    expect(out.pin).toEqual({ reference: 230129, until: new Date((NOW + 210) * 1000).toISOString().replace(".000Z", "Z") });
    expect(out.haltEndedUnclosed).toBe(true);
    expect(out.summary).toContain("cooldown until");
    expect(out.summary).toContain("pinned at 230129");
    expect(out.summary).toContain("Halt 4 ended at");
  });

  it("lists named pools and every hook the desk has bound, once each", async () => {
    const client = fakeClient({ deskHooks: [DRILL_HOOK, LAUNCH_HOOK] });
    const out = await curbStatus(fakeContext(client), { listPools: true });
    expect(out.knownPools?.map((p) => p.hook)).toEqual([DRILL_HOOK, LAUNCH_HOOK]);
    expect(out.knownPools?.[0]?.label).toBe("drill");
    expect(out.knownPools?.[1]?.label).toBeNull();
  });

  it("says plainly when an address is not a Curb hook", async () => {
    const client = fakeClient();
    client.readContract.mockImplementation(async () => {
      throw new Error("execution reverted\nmore");
    });
    await expect(curbStatus(fakeContext(client), { hook: "0x0000000000000000000000000000000000000abc" })).rejects.toThrow(
      /does not answer as a Curb hook/,
    );
  });
});
