import { describe, expect, it } from "vitest";
import { decodeCurbError, type Preview } from "@curb/sdk";
import { encodeErrorResult, parseAbi } from "viem";
import {
  exactInput,
  formatRevert,
  largestFit,
  previewView,
  roundDownSig,
  zeroForOneFor,
} from "./preview";
import type { PairInfo } from "./price";

const drill: PairInfo = { token: { symbol: "DRILL", decimals: 18 }, paired: { symbol: "ETH", decimals: 18 }, tokenIs0: false };
const ctx = { side: "buy" as const, pair: drill, tick: 230129, ref: 230129 };

const outsideBand = (ref: number, tickAfter: number, limit: number, zeroForOne: boolean) =>
  decodeCurbError(
    encodeErrorResult({
      abi: parseAbi(["error OutsideBand(int24 ref, int24 tickAfter, int24 limit, bool zeroForOne)"]),
      errorName: "OutsideBand",
      args: [ref, tickAfter, limit, zeroForOne],
    }),
  );

describe("swap direction", () => {
  it("buys the drill's DRILL with ETH in: zeroForOne", () => {
    expect(zeroForOneFor("buy", false)).toBe(true);
    expect(zeroForOneFor("sell", false)).toBe(false);
    expect(zeroForOneFor("buy", true)).toBe(false);
    expect(exactInput(100n)).toBe(-100n);
  });
});

describe("previewView", () => {
  it("reads a pass from the router's Simulated answer", () => {
    const p: Preview = { ok: true, amount0: -1000000000000n, amount1: 9642948757067656730759n, tickAfter: 229934 };
    const v = previewView(p, ctx);
    expect(v.outcome).toBe("pass");
    expect(v.sentence).toBe("Would pass, ending at tick 229,934 and receiving 9,643 DRILL.");
    expect(v.detail).toBe("DRILL would end +1.97% from the reference, inside the band.");
  });

  it("reads a sell's proceeds from the other side", () => {
    const p: Preview = { ok: true, amount0: 991582607848n, amount1: -(10n ** 22n), tickAfter: 230327 };
    expect(previewView(p, { ...ctx, side: "sell" }).received).toBe("0.0000009916 ETH");
  });

  it("shows the hook's sentence and the decoded call for a refusal", () => {
    const error = outsideBand(230129, -887272, 229829, true);
    const v = previewView({ ok: false, error, raw: "0x" }, ctx);
    expect(v.outcome).toBe("refused");
    expect(v.sentence).toBe(error!.human);
    expect(v.revert).toBe("OutsideBand(ref: 230129, tickAfter: -887272, limit: 229829, zeroForOne: true)");
    expect(v.detail).toContain("end of the curve");
    expect(v.detail).toContain("+3.05%");
  });

  it("says how far past the limit a refused swap would go", () => {
    const v = previewView({ ok: false, error: outsideBand(230129, 229729, 229829, true), raw: "0x" }, ctx);
    expect(v.detail).toContain("DRILL +1% past the band's limit");
  });

  it("tells a dead RPC from an unknown revert", () => {
    expect(previewView({ ok: false, error: null, raw: undefined }, ctx).sentence).toMatch(/No answer/);
    expect(previewView({ ok: false, error: null, raw: "0xdeadbeef" }, ctx).sentence).toMatch(/does not recognise/);
  });

  it("formats any decoded error as a call", () => {
    expect(formatRevert({ name: "Halted", args: { nonce: 1, reopensAt: 1792437999n } })).toBe("Halted(nonce: 1, reopensAt: 1792437999)");
  });
});

describe("largestFit", () => {
  it("finds the largest passing size within a few eth_calls", async () => {
    let calls = 0;
    const threshold = 3_141_592_653_589n;
    const fits = async (a: bigint) => {
      calls++;
      return a <= threshold;
    };
    const best = await largestFit(fits, 100_000_000_000_000n);
    expect(best).not.toBeNull();
    expect(best!).toBeLessThanOrEqual(threshold);
    expect(best!).toBeGreaterThan((threshold * 9n) / 10n);
    expect(calls).toBeLessThanOrEqual(22);
  });

  it("returns null when nothing fits or when cancelled", async () => {
    expect(await largestFit(async () => false, 10n ** 18n)).toBeNull();
    expect(await largestFit(async () => true, 10n ** 18n, { cancelled: () => true })).toBeNull();
  });

  it("rounds suggestions to three significant digits, down", () => {
    expect(roundDownSig(3141592653589n)).toBe(3140000000000n);
    expect(roundDownSig(999n)).toBe(999n);
  });
});
