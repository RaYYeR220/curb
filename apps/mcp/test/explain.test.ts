import { curbDeskAbi, curbHookAbi, wrappedErrorAbi } from "@curb/sdk";
import { encodeAbiParameters, encodeErrorResult, parseAbi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { curbExplainRevert } from "../src/tools/explain";
import { DRILL_HOOK, fakeClient, fakeContext, revert } from "./fakes";

// v4's CustomRevert.WrappedError(target, selector, reason, details), with the hook's beforeSwap/afterSwap
// selector and HookCallFailed() as details, exactly as the PoolManager bubbles a hook's revert.
const AFTER_SWAP = "0xb47b2fb1";
const HOOK_CALL_FAILED = "0xa9e35b2f";

function outsideBandPayload(): Hex {
  const reason = encodeErrorResult({ abi: curbHookAbi, errorName: "OutsideBand", args: [230129, -887272, 229829, true] });
  return encodeErrorResult({ abi: wrappedErrorAbi, errorName: "WrappedError", args: [DRILL_HOOK, AFTER_SWAP, reason, HOOK_CALL_FAILED] });
}

describe("curb_explain_revert", () => {
  it("unwraps WrappedError(OutsideBand) into a sentence", async () => {
    const data = outsideBandPayload();
    // Built field by field as a cross-check on the encoder: selector, then the ABI-encoded tuple.
    const manual = ("0x90bfb865" +
      encodeAbiParameters(
        [{ type: "address" }, { type: "bytes4" }, { type: "bytes" }, { type: "bytes" }],
        [DRILL_HOOK, AFTER_SWAP, encodeErrorResult({ abi: curbHookAbi, errorName: "OutsideBand", args: [230129, -887272, 229829, true] }), HOOK_CALL_FAILED],
      ).slice(2)) as Hex;
    expect(data).toBe(manual);

    const out = await curbExplainRevert(fakeContext(fakeClient()), { data });
    expect(out).toMatchObject({
      decoded: true,
      name: "OutsideBand",
      args: { ref: 230129, tickAfter: -887272, limit: 229829, zeroForOne: true },
      hook: DRILL_HOOK,
      source: "data",
    });
    expect(out.summary).toBe(
      "Refused: the swap would end at tick -887272, past the band's lower limit 229829 (reference 230129). Split the order or set a price limit inside the band.",
    );
  });

  it("names the desk's own errors", async () => {
    const data = encodeErrorResult({ abi: curbDeskAbi, errorName: "WindowTooFresh", args: [92861075n, 92861080n] });
    const out = await curbExplainRevert(fakeContext(fakeClient()), { data });
    expect(out).toMatchObject({ decoded: true, name: "WindowTooFresh", hook: null });
    expect(out.summary).toContain("too recent for the oracle");
  });

  it("falls back to the PoolManager's errors", async () => {
    const abi = parseAbi(["error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)"]);
    const data = encodeErrorResult({ abi, errorName: "PriceLimitAlreadyExceeded", args: [5n, 6n] });
    const out = await curbExplainRevert(fakeContext(fakeClient()), { data });
    expect(out).toMatchObject({ decoded: true, name: "PriceLimitAlreadyExceeded", args: { sqrtPriceCurrentX96: 5n, sqrtPriceLimitX96: 6n } });
  });

  it("says when it cannot name the data, keeping the hook that reverted", async () => {
    const unknown = await curbExplainRevert(fakeContext(fakeClient()), { data: "0xdeadbeef" });
    expect(unknown).toMatchObject({ decoded: false, selector: "0xdeadbeef" });
    const wrappedUnknown = encodeErrorResult({ abi: wrappedErrorAbi, errorName: "WrappedError", args: [DRILL_HOOK, AFTER_SWAP, "0x12345678", HOOK_CALL_FAILED] });
    const out = await curbExplainRevert(fakeContext(fakeClient()), { data: wrappedUnknown });
    expect(out).toMatchObject({ decoded: false, hook: DRILL_HOOK, summary: `The hook at ${DRILL_HOOK} reverted.` });
    await expect(curbExplainRevert(fakeContext(fakeClient()), { data: "nope" })).rejects.toThrow(/hex/);
    await expect(curbExplainRevert(fakeContext(fakeClient()), {})).rejects.toThrow(/Pass the revert data/);
  });

  it("replays a failed transaction, and today's state when the RPC has no history", async () => {
    const client = fakeClient();
    const hash = `0x${"ab".repeat(32)}` as const;
    client.getTransaction.mockResolvedValue({ from: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000002", input: "0x01", value: 0n });
    client.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 100n });
    client.call
      .mockRejectedValueOnce(Object.assign(new Error("Missing or invalid parameters."), { details: "historical state abc is not available" }))
      .mockRejectedValueOnce(revert(outsideBandPayload()));
    const out = await curbExplainRevert(fakeContext(client), { txHash: hash });
    expect(client.call.mock.calls[0]![0]).toMatchObject({ blockNumber: 99n });
    expect(client.call.mock.calls[1]![0]).not.toHaveProperty("blockNumber");
    expect(out).toMatchObject({ decoded: true, name: "OutsideBand" });
    expect((out as { source: string }).source).toContain("against the latest state");

    client.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 100n });
    const ok = await curbExplainRevert(fakeContext(client), { txHash: hash });
    expect(ok).toMatchObject({ decoded: false, summary: "The transaction succeeded; there is no revert to explain." });
  });
});
