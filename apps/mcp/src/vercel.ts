import type { IncomingMessage, ServerResponse } from "node:http";
import { defaultContext } from "./context";
import { handlePost, reply } from "./http";

const ctx = defaultContext({ rpc: process.env.CURB_RPC, imdApi: process.env.IMD_API });

/** The hosted `/mcp` endpoint as a Vercel function. The platform has already read the body. */
export default async function mcp(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  if (req.method !== "POST") {
    return reply(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, POST only." }, id: null });
  }
  let body: unknown;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    body = undefined;
  }
  if (body === undefined || body === null) {
    return reply(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  await handlePost(ctx, req, res, body);
}
