import { MAX_SQRT_PRICE_MINUS_ONE, MIN_SQRT_PRICE_PLUS_ONE } from "@curb/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createCurbServer } from "../src/server";
import { getSqrtPriceAtTick, MAX_TICK, MIN_TICK } from "../src/tickmath";
import { fakeClient, fakeContext, outsideBand, simulated } from "./fakes";

async function connect(ctx = fakeContext(fakeClient())) {
  const server = createCurbServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function text(r: Awaited<ReturnType<Client["callTool"]>>): string {
  return (r.content as { type: string; text: string }[])[0]!.text;
}

describe("the MCP server", () => {
  it("lists the five tools with their inputs", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "curb_explain_revert",
      "curb_incidents",
      "curb_launch_manifest",
      "curb_preflight",
      "curb_status",
    ]);
    const preflight = tools.find((t) => t.name === "curb_preflight")!;
    expect(preflight.inputSchema.required).toEqual(["side", "amount"]);
    expect(preflight.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain("call curb_preflight");
  });

  it("answers a tool call with JSON text", async () => {
    const ctx = fakeContext(
      fakeClient({
        simulate: (args) => ((args[3] as bigint) === MIN_SQRT_PRICE_PLUS_ONE ? outsideBand(230129, -887272, 229829, true) : simulated(-1n, 1n, 229830)),
      }),
    );
    const client = await connect(ctx);
    const r = await client.callTool({ name: "curb_preflight", arguments: { side: "buy", amount: "0.0001" } });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(text(r));
    expect(out.reason).toBe("OutsideBand");
    expect(out.args.zeroForOne).toBe(true);
  });

  it("rejects bad input before any tool runs, and reports tool errors as errors", async () => {
    const client = await connect();
    const bad = await client.callTool({ name: "curb_preflight", arguments: { side: "short", amount: "1" } });
    expect(bad.isError).toBe(true);
    const badSymbol = await client.callTool({ name: "curb_launch_manifest", arguments: { name: "Garden", symbol: "g rd", owner: "0x0000000000000000000000000000000000000001" } });
    expect(badSymbol.isError).toBe(true);
    const failing = await client.callTool({ name: "curb_status", arguments: { hook: "launch" } });
    expect(failing.isError).toBe(true);
    expect(text(failing)).toContain("neither a hook address");
  });
});

describe("getSqrtPriceAtTick", () => {
  it("matches v4's TickMath at its fixed points", () => {
    expect(getSqrtPriceAtTick(0)).toBe(2n ** 96n);
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE_PLUS_ONE - 1n);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE_MINUS_ONE + 1n);
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow(RangeError);
  });

  it("tracks sqrt(1.0001^tick) * 2^96", () => {
    for (const t of [1, -1, 60, 229830, -230129, 500000]) {
      const want = Math.sqrt(1.0001 ** t) * 2 ** 96;
      expect(Math.abs(Number(getSqrtPriceAtTick(t)) / want - 1)).toBeLessThan(1e-9);
    }
  });
});
