import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Context } from "./context";
import { createCurbServer, SERVER_NAME, SERVER_VERSION } from "./server";

/** Stateless Streamable HTTP: every POST gets its own server and transport, since no tool keeps session state. */
export async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse) {
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
  return handlePost(ctx, req, res, body);
}

/** Serves one JSON-RPC POST whose body is already parsed, for hosts that parse it themselves. */
export async function handlePost(ctx: Context, req: IncomingMessage, res: ServerResponse, body: unknown) {
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

export function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
