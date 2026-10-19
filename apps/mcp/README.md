# @curb/mcp

An MCP server for Curb pools on Robinhood Chain. Every tool reads the chain or IMD's free endpoints;
none signs or sends anything.

| Tool | Does |
| --- | --- |
| `curb_status` | Phase, ticks, band and edge zone, halt / reopen / cooldown / pin times, incident window, a one-line summary. `listPools` lists every known Curb pool. |
| `curb_preflight` | Simulates an exact-input buy or sell through `CurbRouter.simulate` with `eth_call`. Returns the fill, or the decoded refusal with the largest fill that passes now and the `limitTick` that gets it. |
| `curb_incidents` | Halts, filings, oracle verdicts and failed requests, newest first, with explorer links; the desk's treasury against the price of a question. |
| `curb_explain_revert` | Decodes revert data, or replays a failed transaction, unwrapping v4's `WrappedError`. |
| `curb_launch_manifest` | Builds `launch.json` and the IMD `launch.open` body for your own token; with `check: true`, runs IMD's free import and launch check. |

`hook` arguments take an address, `"launch"` or `"drill"`; left out, the CURB/IMD pool once its hook
is recorded in `deployments`, else the drill pool.

## Stdio

After `pnpm install` at the repository root:

```json
{
  "mcpServers": {
    "curb": { "command": "npx", "args": ["-y", "tsx", "/path/to/curb/apps/mcp/src/index.ts"] }
  }
}
```

Claude Code: `claude mcp add curb -- npx -y tsx /path/to/curb/apps/mcp/src/index.ts`.

## Streamable HTTP

Hosted: `https://curb-bay.vercel.app/mcp` (`claude mcp add --transport http curb https://curb-bay.vercel.app/mcp`).
It is `src/vercel.ts`, bundled by `script/site.sh`. To run your own:

```sh
npx tsx apps/mcp/src/index.ts --http 8787     # http://127.0.0.1:8787/mcp
```

Stateless: each POST to `/mcp` is answered on its own, and GET returns 405. `--host 0.0.0.0` binds
every interface; `GET /health` answers for load balancers.

## Options

| Flag | Environment | Default |
| --- | --- | --- |
| `--rpc <url>` | `CURB_RPC` | `https://rpc.mainnet.chain.robinhood.com` |
| `--imd-api <url>` | `IMD_API` | `https://api.imd.fun` |

Reads made together go out as one JSON-RPC batch, since the public RPC rate-limits by request.

## Development

```sh
pnpm --filter @curb/mcp test
pnpm --filter @curb/mcp typecheck
```
