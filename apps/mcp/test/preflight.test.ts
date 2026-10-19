import { ADDRESSES, MIN_SQRT_PRICE_PLUS_ONE, MAX_SQRT_PRICE_MINUS_ONE, curbHookAbi } from "@curb/sdk";
import { encodeErrorResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { getSqrtPriceAtTick } from "../src/tickmath";
import { curbPreflight } from "../src/tools/preflight";
import { CURB, DRILL_HOOK, LAUNCH_HOOK, ROUTER, drillStatus, fakeClient, fakeContext, outsideBand, simulated, wrapped } from "./fakes";

const ONE_GWEI = 1_000_000_000n;

describe("curb_preflight", () => {
  it("passes a small buy and reads the amounts the right way round", async () => {
    const client = fakeClient({ simulate: () => simulated(-ONE_GWEI, 9737412151251333467n, 230129) });
    const out = await curbPreflight(fakeContext(client), { side: "buy", amount: "0.000000001" });
    const call = client.simulateContract.mock.calls[0]![0] as { address: string; functionName: string; args: readonly unknown[] };
    expect(call.address).toBe(ROUTER);
    expect(call.functionName).toBe("simulate");
    // ETH is currency0 on the drill pool, so buying DRILL sells currency0: zeroForOne, exact input negative.
    expect(call.args.slice(1)).toEqual([true, -ONE_GWEI, MIN_SQRT_PRICE_PLUS_ONE]);
    expect(out.wouldPass).toBe(true);
    expect(out).toMatchObject({
      pay: "0.000000001 ETH",
      receive: "9.737412151251333467 DRILL",
      tickBefore: 230129,
      tickAfter: 230129,
      direction: "down",
      partialFill: false,
      endsInEdgeZone: false,
    });
    expect(out.summary).toBe(
      "Would pass: pay 0.000000001 ETH, receive 9.737412151251333467 DRILL; tick 230129 -> 230129 (band 229829..230429).",
    );
  });

  it("flags a fill that ends in the edge zone and one cut short by its limit", async () => {
    const client = fakeClient({ simulate: () => simulated(-1_200_000_000_000n, 11_000n * 10n ** 18n, 229880) });
    const out = await curbPreflight(fakeContext(client), { side: "buy", amount: "0.0001", limitTick: 229880 });
    const call = client.simulateContract.mock.calls[0]![0] as { args: readonly unknown[] };
    expect(call.args[3]).toBe(getSqrtPriceAtTick(229880));
    expect(out).toMatchObject({ wouldPass: true, partialFill: true, endsInEdgeZone: true });
    const notes = (out as { notes: string[] }).notes;
    expect(notes[0]).toContain("takes 0.0000012 ETH of the 0.0001 ETH asked");
    expect(notes[1]).toContain("halts both ways for up to 300s");
  });

  it("decodes an OutsideBand refusal and finds the largest fill that passes", async () => {
    const toBand = getSqrtPriceAtTick(229830);
    const toEdge = getSqrtPriceAtTick(229890);
    const client = fakeClient({
      simulate: (args) => {
        const limit = args[3] as bigint;
        if (limit === toBand) return simulated(-1540111089555n, 14773725534577499192135n, 229830);
        if (limit === toEdge) return simulated(-1230036862611n, 11834745514966295694319n, 229890);
        return outsideBand(230129, -887272, 229829, true);
      },
    });
    const out = await curbPreflight(fakeContext(client), { side: "buy", amount: "0.0001" });
    expect(out.wouldPass).toBe(false);
    expect(out).toMatchObject({
      reason: "OutsideBand",
      args: { ref: 230129, tickAfter: -887272, limit: 229829, zeroForOne: true },
      largestFill: { limitTick: 229830, pay: "0.000001540111089555 ETH", tickAfter: 229830 },
      largestWithoutLimitState: { limitTick: 229890, pay: "0.000001230036862611 ETH", tickAfter: 229890 },
    });
    expect(out.summary).toContain("past the band's lower limit 229829");
    const todo = (out as { whatToDo: string[] }).whatToDo;
    expect(todo[0]).toContain("Set limitTick 229830");
    expect(todo[1]).toContain("limitTick 229890");
    expect(todo[2]).toContain("every 120s by up to 239 ticks");
    expect(todo[3]).toBe("Any swap toward the reference always passes.");
    expect(client.simulateContract).toHaveBeenCalledTimes(3);
  });

  it("skips the edge-zone cap when the price already sits past it", async () => {
    const client = fakeClient({
      status: drillStatus({ tick: 229880 }),
      simulate: (args) =>
        (args[3] as bigint) === getSqrtPriceAtTick(229830)
          ? simulated(-1n, 1n, 229830)
          : outsideBand(230129, -887272, 229829, true),
    });
    const out = await curbPreflight(fakeContext(client), { side: "buy", amount: "1" });
    expect(out).toMatchObject({ reason: "OutsideBand", largestWithoutLimitState: null });
    expect(client.simulateContract).toHaveBeenCalledTimes(2);
  });

  it("decodes a halt and says when it ends", async () => {
    const halted = encodeErrorResult({ abi: curbHookAbi, errorName: "Halted", args: [0, 1792437999n] });
    const client = fakeClient({ simulate: () => wrapped(DRILL_HOOK, halted) });
    const out = await curbPreflight(fakeContext(client), { side: "sell", amount: "5" });
    expect(out).toMatchObject({ wouldPass: false, reason: "Halted", reopensAt: "2026-10-19T19:26:39Z" });
    expect(out.summary).toBe("Halted: incident 0 is in progress. Trading reopens by 2026-10-19T19:26:39Z at the latest.");
    expect((out as { whatToDo: string[] }).whatToDo[0]).toContain("Wait until 2026-10-19T19:26:39Z");
  });

  it("buys up when the token is currency0", async () => {
    const client = fakeClient({
      key: { currency0: CURB, currency1: ADDRESSES.imd, fee: 12500, tickSpacing: 60, hooks: LAUNCH_HOOK },
      token: CURB,
      status: drillStatus({ ref: 0, lower: -1000, upper: 1000, tick: 0 }),
      simulate: () => simulated(99n * 10n ** 18n, -100n * 10n ** 18n, 20),
    });
    const out = await curbPreflight(fakeContext(client), { hook: LAUNCH_HOOK, side: "buy", amount: "100" });
    const call = client.simulateContract.mock.calls[0]![0] as { args: readonly unknown[] };
    expect(call.args.slice(1)).toEqual([false, -100n * 10n ** 18n, MAX_SQRT_PRICE_MINUS_ONE]);
    expect(out).toMatchObject({ pool: "CURB/IMD", direction: "up", pay: "100 IMD", receive: "99 CURB", tickAfter: 20 });
  });

  it("refuses a limit tick behind the price, and a zero amount", async () => {
    const ctx = fakeContext(fakeClient({ simulate: () => "0x" as Hex }));
    await expect(curbPreflight(ctx, { side: "buy", amount: "1", limitTick: 230200 })).rejects.toThrow(/must be below it/);
    await expect(curbPreflight(ctx, { side: "sell", amount: "1", limitTick: 230000 })).rejects.toThrow(/must be above it/);
    await expect(curbPreflight(ctx, { side: "buy", amount: "0" })).rejects.toThrow(/greater than zero/);
  });

  it("passes on revert data it cannot name", async () => {
    const out = await curbPreflight(fakeContext(fakeClient({ simulate: () => "0xdeadbeef" })), { side: "buy", amount: "1" });
    expect(out).toMatchObject({ wouldPass: false, reason: "unknown", raw: "0xdeadbeef" });
  });
});
