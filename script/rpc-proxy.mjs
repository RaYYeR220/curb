// The hosted site's RPC, served from its own origin as a Vercel function at /rpc. The public
// Robinhood endpoint sometimes sends its CORS header twice ("*,*"), which browsers refuse; a
// same-origin request needs no CORS header at all. Read methods only.
const UPSTREAM = process.env.CURB_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const READS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getCode",
  "eth_getBalance",
  "eth_getStorageAt",
]);

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export default async function rpc(req, res) {
  if (req.method !== "POST") return reply(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "POST only" }, id: null });
  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
  } catch {
    body = undefined;
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > 100 || calls.some((c) => !c || !READS.has(c.method))) {
    return reply(res, 400, { jsonrpc: "2.0", error: { code: -32601, message: "read methods only" }, id: null });
  }
  const upstream = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  res.writeHead(upstream.status, { "content-type": "application/json" }).end(await upstream.text());
}
