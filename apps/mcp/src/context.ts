import { robinhood } from "@curb/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { DEPLOYMENTS, IMD_API, type Deployments } from "./known";

/** Everything a tool touches outside itself, so tests can hand in fakes. */
export interface Context {
  client: PublicClient;
  fetch: typeof fetch;
  imdApi: string;
  deployments: Deployments;
  /** IMD's free launch check reads the repository and plans the job; it can take minutes. */
  checkTimeoutMs: number;
}

/**
 * The public RPC rate-limits by HTTP request, and one tool call makes about ten reads, so reads made
 * together go out as one JSON-RPC batch and a 429 is retried with backoff.
 */
export function chainClient(rpc?: string): PublicClient {
  return createPublicClient({
    chain: robinhood,
    transport: http(rpc, { batch: { batchSize: 32, wait: 16 }, retryCount: 5, retryDelay: 600 }),
  }) as PublicClient;
}

export function defaultContext(opts: { rpc?: string; imdApi?: string } = {}): Context {
  return {
    client: chainClient(opts.rpc),
    fetch: globalThis.fetch.bind(globalThis),
    imdApi: (opts.imdApi ?? IMD_API).replace(/\/$/, ""),
    deployments: DEPLOYMENTS,
    checkTimeoutMs: 240_000,
  };
}
