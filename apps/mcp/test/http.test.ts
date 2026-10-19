import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle, handlePost } from "../src/http";
import { fakeClient, fakeContext } from "./fakes";

const ctx = fakeContext(fakeClient());
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};
const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("Streamable HTTP", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => void handle(ctx, req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("initializes over POST /mcp", async () => {
    const res = await post(`${base}/mcp`, initialize);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("curb");
  });

  it("refuses GET on /mcp, answers /health, and rejects a body that is not JSON", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect(((await (await fetch(`${base}/health`)).json()) as { mcp: string }).mcp).toBe("/mcp");
    expect((await post(`${base}/mcp`, "{not json")).status).toBe(400);
  });
});

describe("a host that has already parsed the body", () => {
  it("serves the request from the parsed body, whatever the path", async () => {
    const server = createServer((req, res) => void handlePost(ctx, req, res, initialize));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: number }).id).toBe(1);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
