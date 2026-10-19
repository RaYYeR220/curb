import { describe, expect, it } from "vitest";
import { encodeErrorResult, type Hex } from "viem";
import { curbDeskAbi, curbHookAbi, wrappedErrorAbi } from "../src/abis";
import { decodeCurbError } from "../src/errors";

const HOOK = "0xeE60C95711F5650bbBBee421426820feC6e060c0";
const HOOK_CALL_FAILED = "0xa9e35b2f";

function wrapped(selector: Hex, reason: Hex): Hex {
  return encodeErrorResult({
    abi: wrappedErrorAbi,
    errorName: "WrappedError",
    args: [HOOK, selector, reason, HOOK_CALL_FAILED],
  });
}

describe("decodeCurbError", () => {
  it("unwraps an OutsideBand refusal from v4's WrappedError", () => {
    const reason = encodeErrorResult({
      abi: curbHookAbi,
      errorName: "OutsideBand",
      args: [0, 1001, 1000, false],
    });
    const decoded = decodeCurbError(wrapped("0xb47b2fb1", reason));
    expect(decoded?.name).toBe("OutsideBand");
    expect(decoded?.args).toEqual({ ref: 0, tickAfter: 1001, limit: 1000, zeroForOne: false });
    expect(decoded?.human).toContain("upper limit 1000");
    expect(decoded?.hook).toBe(HOOK);
  });

  it("unwraps a halt nested twice", () => {
    const reason = encodeErrorResult({ abi: curbHookAbi, errorName: "Halted", args: [3, 1792430321n] });
    const decoded = decodeCurbError(wrapped("0x575e24b4", wrapped("0x575e24b4", reason)));
    expect(decoded?.name).toBe("Halted");
    expect(decoded?.args).toEqual({ nonce: 3, reopensAt: 1792430321n });
    expect(decoded?.human).toContain("2026-10-19");
  });

  it("names the desk's treasury shortfall", () => {
    const data = encodeErrorResult({
      abi: curbDeskAbi,
      errorName: "TreasuryShort",
      args: [0n, 500000000000000000n],
    });
    const decoded = decodeCurbError(data);
    expect(decoded?.name).toBe("TreasuryShort");
    expect(decoded?.human).toContain("0.5 IMD");
  });

  it("returns null for data it does not know", () => {
    expect(decodeCurbError("0xdeadbeef")).toBeNull();
    expect(decodeCurbError("0x")).toBeNull();
  });
});
