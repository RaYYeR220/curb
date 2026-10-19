import { decodeCurbError, revertData } from "@curb/sdk";
import { decodeErrorResult, parseAbi, type Hex } from "viem";
import type { Context } from "../context";
import { txUrl } from "../known";

export interface ExplainInput {
  data?: string;
  txHash?: string;
}

// Errors a swap can meet in the PoolManager itself, before or around the hook.
const v4Errors = parseAbi([
  "error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)",
  "error SwapAmountCannotBeZero()",
  "error PoolNotInitialized()",
  "error CurrencyNotSettled()",
  "error ManagerLocked()",
]);

const v4Sentences: Record<string, string> = {
  PriceLimitAlreadyExceeded: "The price limit is already behind the pool's price: for this direction it must lie beyond the current price.",
  PriceLimitOutOfBounds: "The price limit is outside v4's valid sqrt-price range.",
  SwapAmountCannotBeZero: "The swap amount is zero.",
  PoolNotInitialized: "No pool exists for this key: check the currencies, fee 12500, tick spacing 60 and the hook address.",
  CurrencyNotSettled: "The router did not pay what the swap owed: check the balance, the approval and, for ETH, the value sent.",
  ManagerLocked: "The PoolManager was called outside an unlock.",
};

export async function curbExplainRevert(ctx: Context, input: ExplainInput) {
  let data: Hex | undefined;
  let source: string;
  if (input.data) {
    if (!/^0x[0-9a-fA-F]*$/.test(input.data)) throw new Error("data must be 0x-prefixed hex.");
    data = input.data as Hex;
    source = "data";
  } else if (input.txHash) {
    const replay = await replayRevert(ctx, input.txHash as Hex);
    if (!replay.reverted) {
      return { decoded: false, summary: replay.summary, tx: txUrl(input.txHash) };
    }
    data = replay.data;
    source = replay.source;
  } else {
    throw new Error("Pass the revert data (data) or a failed transaction's hash (txHash).");
  }

  if (!data || data.length < 10) {
    return { decoded: false, summary: "The call reverted with no error selector (out of gas, or a bare revert).", source, raw: data ?? null };
  }
  const curb = decodeCurbError(data);
  if (curb && curb.name !== "WrappedError") {
    return { decoded: true, summary: curb.human, name: curb.name, args: curb.args, hook: curb.hook ?? null, source, raw: data };
  }
  // A hook revert Curb does not name, or a PoolManager error with no hook involved.
  const v4 = decodeV4(curb ? (curb.args.reason as Hex) : data);
  if (v4) {
    return { decoded: true, summary: v4.human, name: v4.name, args: v4.args, hook: curb?.hook ?? null, source, raw: data };
  }
  return {
    decoded: false,
    summary: curb ? curb.human : "The revert data matches no Curb, router or PoolManager error.",
    selector: data.slice(0, 10),
    hook: curb?.hook ?? null,
    source,
    raw: data,
  };
}

function decodeV4(data: Hex) {
  try {
    const d = decodeErrorResult({ abi: v4Errors, data });
    const names = (v4Errors.find((e) => e.name === d.errorName)?.inputs ?? []).map((i) => i.name ?? "");
    const args = Object.fromEntries(names.map((n, i) => [n, (d.args as readonly unknown[] | undefined)?.[i]]));
    return { name: d.errorName, args, human: v4Sentences[d.errorName] ?? d.errorName };
  } catch {
    return null;
  }
}

type Replay = { reverted: true; data: Hex | undefined; source: string } | { reverted: false; summary: string };

async function replayRevert(ctx: Context, hash: Hex): Promise<Replay> {
  const [tx, receipt] = await Promise.all([ctx.client.getTransaction({ hash }), ctx.client.getTransactionReceipt({ hash })]);
  if (receipt.status === "success") return { reverted: false, summary: "The transaction succeeded; there is no revert to explain." };
  if (!tx.to) return { reverted: false, summary: "A failed contract creation; Curb's errors come from calls." };
  const call = { account: tx.from, to: tx.to, data: tx.input, value: tx.value };
  const before = receipt.blockNumber - 1n;
  try {
    await ctx.client.call({ ...call, blockNumber: before });
  } catch (e) {
    const data = revertData(e);
    if (data) return { reverted: true, data, source: `replay of ${hash} against the state before its block` };
    if (!/historical state|missing trie node|state.*not available/i.test(errorText(e))) throw e;
    // Public RPCs keep recent state only; the same call against today's state still names the rule it meets now.
    try {
      await ctx.client.call(call);
    } catch (e2) {
      return {
        reverted: true,
        data: revertData(e2),
        source: `replay of ${hash} against the latest state, because the RPC keeps no state for block ${before}; the pool may have changed since, so pass the original revert data or an archive RPC for the exact answer`,
      };
    }
    return {
      reverted: false,
      summary: `The RPC keeps no state for block ${before}, and the same call passes against today's state. Pass the original revert data, or run with an archive RPC.`,
    };
  }
  return {
    reverted: false,
    summary: "Replayed against the state before its block the call passes, so it failed on gas or on something earlier in its block.",
  };
}

function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const c = cur as { message?: string; details?: string; cause?: unknown };
    parts.push(c.message ?? "", c.details ?? "");
    cur = c.cause;
  }
  return parts.join(" ");
}
