import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Context } from "./context";
import { toJson } from "./format";
import { curbExplainRevert } from "./tools/explain";
import { curbIncidents } from "./tools/incidents";
import { curbLaunchManifest } from "./tools/manifest";
import { curbPreflight } from "./tools/preflight";
import { curbStatus } from "./tools/status";

export const SERVER_NAME = "curb";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS =
  "Curb pools are Uniswap v4 pools on Robinhood Chain (4663) whose hook refuses any swap that would end outside a band " +
  "around a time-weighted reference price, and halts the pool both ways for a bounded time when the price holds at the " +
  "band's edge. Before sending a swap to a Curb pool, call curb_preflight: it asks the pool itself, free, and tells you " +
  "whether the swap passes, or why not and what to do. curb_status reads the pool's phase and limits; curb_incidents " +
  "lists its halts and the desk's oracle verdicts; curb_explain_revert decodes a refusal; curb_launch_manifest prepares " +
  "a launch of your own token with Curb through Identity MD.";

const hookArg = z
  .string()
  .optional()
  .describe(
    'The pool\'s hook address, or "launch" / "drill". Omitted: the CURB/IMD launch pool once it is live, otherwise the DRILL/ETH drill pool.',
  );

function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: toJson(value) }] };
}

function failure(e: unknown): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await fn());
  } catch (e) {
    return failure(e);
  }
}

export function createCurbServer(ctx: Context): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool(
    "curb_status",
    {
      title: "Curb pool status",
      description:
        "Reads a Curb pool's breaker right now, without a swap: phase (open, limit, halted, cooldown), incident nonce, " +
        "the current tick, the reference tick, the band's limits and edge-zone thresholds, halt start / reopen / cooldown " +
        "/ pin times as ISO dates, the incident window the desk would ask the oracle about, and a one-line summary. " +
        "Set listPools to also list every Curb pool this server knows.",
      inputSchema: {
        hook: hookArg,
        listPools: z.boolean().optional().describe("Also list the known Curb pools (named deployments and every hook the desk has bound)."),
      },
      annotations: readOnly,
    },
    (args) => run(() => curbStatus(ctx, args)),
  );

  server.registerTool(
    "curb_preflight",
    {
      title: "Preflight a swap on a Curb pool",
      description:
        "Asks the pool what it would do with an exact-input swap, by simulating it through Curb's router with eth_call: " +
        "no wallet, balance or approval needed, nothing is sent. Returns the amounts and end tick when it would pass, or " +
        "the decoded refusal (OutsideBand or Halted) with what to do: the largest fill that passes now and the limitTick " +
        "that gets it, the cap that stays out of the edge zone, or the time the halt ends. Call this before every swap.",
      inputSchema: {
        hook: hookArg,
        side: z.enum(["buy", "sell"]).describe("buy: pay the paired currency (IMD or ETH) for the pool's token. sell: pay the token."),
        amount: z
          .string()
          .regex(/^\d+(\.\d+)?$/, "a plain decimal number")
          .describe('Exact input, as a decimal string in the input token\'s units, e.g. "250" or "0.0001".'),
        limitTick: z
          .number()
          .int()
          .optional()
          .describe(
            "Stop the swap at this tick instead of crossing it (a partial fill). It must lie in the swap's direction from the current tick; the preflight's refusal names a usable one.",
          ),
      },
      annotations: readOnly,
    },
    (args) => run(() => curbPreflight(ctx, args)),
  );

  server.registerTool(
    "curb_incidents",
    {
      title: "Curb pool incidents",
      description:
        "Lists a pool's halts, newest first, from chain events: when each halt started and ended, how it closed " +
        "(HaltClosed), any verdict applied early (Resolved), whether the desk filed it with the IMD oracle " +
        "(IncidentFiled), the oracle's answer and verdict (VerdictReached) or the request's failure (RequestFailed), each " +
        "with an explorer link. Also reports the desk's treasury against the price of one oracle question.",
      inputSchema: {
        hook: hookArg,
        limit: z.number().int().min(1).max(100).optional().describe("How many incidents to return, newest first. Default 10."),
        fromBlock: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("First L2 block to scan. Default: the block Curb's contracts were deployed in."),
      },
      annotations: readOnly,
    },
    (args) => run(() => curbIncidents(ctx, args)),
  );

  server.registerTool(
    "curb_explain_revert",
    {
      title: "Explain a Curb revert",
      description:
        "Decodes a revert from a Curb pool, the Curb desk, or Curb's router into its error name, arguments and one plain " +
        "sentence, unwrapping Uniswap v4's WrappedError around a hook's error. Pass the raw revert data, or the hash of a " +
        "failed transaction to replay it.",
      inputSchema: {
        data: z.string().optional().describe("Raw revert data, 0x-prefixed hex."),
        txHash: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/, "a 32-byte transaction hash")
          .optional()
          .describe("A failed transaction on Robinhood Chain; it is replayed with eth_call to recover the revert data."),
      },
      annotations: readOnly,
    },
    (args) => run(() => curbExplainRevert(ctx, args)),
  );

  server.registerTool(
    "curb_launch_manifest",
    {
      title: "Launch a token with Curb through Identity MD",
      description:
        "Builds the launch.json manifest and the IMD launch.open request body for launching your own token on Robinhood " +
        "Chain with a Curb hook on its pool, paired with IMD. With check: true it also resolves the repository's commit " +
        "(POST /requests/import) and runs IMD's free launch check (POST /requests/check), returning blockers and the " +
        "planned steps; the check can take 1 to 3 minutes. Nothing is paid; the result says how to pay.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9 .-]{0,39}$/, "letters, digits, spaces, dots or dashes, at most 40")
          .describe("Token name, e.g. Garden."),
        symbol: z.string().regex(/^[A-Z0-9]{1,11}$/, "1-11 capital letters or digits").describe("Token symbol, e.g. GRDN."),
        owner: z
          .string()
          .describe("The hook's owner ($owner), whose one power is resolve(nonce, verdict); also receives the supply not seeded in the pool. Use a CurbDesk to have the IMD oracle decide verdicts."),
        params: z
          .object({
            bandTicks: z.number().int().optional(),
            edgeTicks: z.number().int().optional(),
            refWindow: z.number().int().optional(),
            limitSeconds: z.number().int().optional(),
            haltSeconds: z.number().int().optional(),
            cooldownSeconds: z.number().int().optional(),
            minLiquidityE18: z.number().int().optional(),
          })
          .optional()
          .describe("Breaker settings; each omitted one takes CURB/IMD's: band 1000, edge 100, refWindow 300 s, limit 15 s, halt 900 s, cooldown 1800 s, minLiquidityE18 100000."),
        repoUrl: z.string().optional().describe("Your public GitHub fork of the Curb repository, https://github.com/<owner>/<repo>."),
        baseCommit: z.string().optional().describe("The 40-hex commit to launch. Omitted with check: true, IMD's import resolves the default branch's head."),
        check: z.boolean().optional().describe("Run IMD's free import and launch check (1-3 minutes). Needs repoUrl."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => run(() => curbLaunchManifest(ctx, args)),
  );

  return server;
}
