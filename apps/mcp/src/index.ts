#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { defaultContext, type Context } from "./context";
import { createCurbServer, SERVER_NAME, SERVER_VERSION } from "./server";

const USAGE = `curb MCP server

  tsx src/index.ts                      stdio, for local MCP clients
  tsx src/index.ts --http 8787          Streamable HTTP at http://127.0.0.1:8787/mcp

Options:
  --http <port>    serve Streamable HTTP instead of stdio
  --host <host>    interface to bind in HTTP mode (default 127.0.0.1)
  --rpc <url>      Robinhood Chain RPC (default: CURB_RPC, else the public endpoint)
  --imd-api <url>  Identity MD API (default: IMD_API, else https://api.imd.fun)
`;

async function main() {
  const { values } = parseArgs({
    options: {
      http: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      rpc: { type: "string" },
      "imd-api": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const ctx = defaultContext({ rpc: values.rpc ?? process.env.CURB_RPC, imdApi: values["imd-api"] ?? process.env.IMD_API });

  if (values.http === undefined) {
    // stdout carries the protocol in stdio mode; anything human goes to stderr.
    await createCurbServer(ctx).connect(new StdioServerTransport());
    console.error(`${SERVER_NAME} ${SERVER_VERSION} on stdio`);
    return;
  }

  const port = Number(values.http);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--http needs a port, got "${values.http}"`);
  const http = createServer((req, res) => {
    handle(ctx, req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) reply(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    });
  });
  http.listen(port, values.host, () => console.error(`${SERVER_NAME} ${SERVER_VERSION} on http://${values.host}:${port}/mcp`));
}

/** Stateless Streamable HTTP: every POST gets its own server and transport, since no tool keeps session state. */
async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/" || path === "/health") {
    return reply(res, 200, { name: SERVER_NAME, version: SERVER_VERSION, mcp: "/mcp" });
  }
  if (path !== "/mcp") return reply(res, 404, { error: "not found" });
  if (req.method !== "POST") {
    return reply(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, POST only." }, id: null });
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return reply(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  const server = createCurbServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
