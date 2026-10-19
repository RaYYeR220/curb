import type { Context } from "./context";

export interface CheckResult {
  blockers: unknown[];
  suggestions: unknown[];
  plan: unknown[];
  facts: unknown[];
  kind?: string;
  judged?: boolean;
}

export interface ImportResult {
  ok: boolean;
  source?: { repoUrl?: string; baseCommit?: string; owner?: string; repo?: string; ref?: string; sizeKb?: number };
  problems?: unknown[];
}

async function post<T>(ctx: Context, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await ctx.fetch(`${ctx.imdApi}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} answered ${res.status} with non-JSON: ${text.slice(0, 200)}`);
  }
  // The import door answers 4xx with {ok:false, problems}; that is an answer, not a transport failure.
  if (!res.ok && !(json && typeof json === "object" && "problems" in json)) {
    throw new Error(`${path} answered ${res.status}: ${text.slice(0, 300)}`);
  }
  return json as T;
}

/** The free launch check: what a quote would say about this body, with nothing paid or held. */
export function checkLaunch(ctx: Context, input: unknown): Promise<CheckResult> {
  return post<CheckResult>(ctx, "/requests/check", { action: "launch.open", input }, ctx.checkTimeoutMs);
}

/** Resolves a public GitHub repository (optionally /commit/<sha>) to the commit a launch pins. */
export function importRepo(ctx: Context, url: string): Promise<ImportResult> {
  return post<ImportResult>(ctx, "/requests/import", { url, kind: "contracts" }, 60_000);
}
