/**
 * A small JSON-RPC client for bulk reads. The public Robinhood endpoint meters calls one by one,
 * batch or not (a burst of about 175, then about 20 a second), so the client paces itself under
 * that and retries whatever is still turned away. getLogs ranges are split by the caller.
 */

export interface Call {
  method: string;
  params: unknown[];
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(`rpc ${code}: ${message}`);
  }
}

interface Reply {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (code: number) => code === 429 || code === -32005 || code >= 500;

export interface RpcOptions {
  batchSize?: number;
  /** Calls per second the client allows itself. */
  rate?: number;
  attempts?: number;
}

export class Rpc {
  requests = 0;
  calls = 0;
  private nextFree = 0;
  private readonly batchSize: number;
  private readonly rate: number;
  private readonly attempts: number;

  constructor(
    private readonly url: string,
    o: RpcOptions = {},
  ) {
    this.batchSize = o.batchSize ?? 25;
    this.rate = o.rate ?? 18;
    this.attempts = o.attempts ?? 12;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const [r] = await this.batch<T>([{ method, params }]);
    return r as T;
  }

  /** Every call answered, in order. Calls turned away are retried on their own with backoff. */
  async batch<T>(calls: Call[]): Promise<T[]> {
    const out = new Array<T>(calls.length);
    for (let i = 0; i < calls.length; i += this.batchSize) {
      const chunk = calls.slice(i, i + this.batchSize);
      const res = await this.send<T>(chunk);
      res.forEach((r, j) => (out[i + j] = r));
    }
    return out;
  }

  private async pace(n: number): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + (n * 1000) / this.rate;
    if (start > now) await sleep(start - now);
  }

  private async send<T>(calls: Call[]): Promise<T[]> {
    const out = new Array<T>(calls.length);
    let todo = calls.map((_, i) => i);
    for (let attempt = 0; todo.length > 0; attempt++) {
      if (attempt >= this.attempts) throw new RpcError(429, `still refused after ${this.attempts} attempts`);
      if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 30_000));
      await this.pace(todo.length);
      const replies = await this.post(todo.map((i) => ({ jsonrpc: "2.0", id: i, ...calls[i] })));
      const again: number[] = [];
      if (replies instanceof RpcError) {
        if (!retryable(replies.code)) throw replies;
        again.push(...todo);
      } else {
        const byId = new Map(replies.map((r) => [r.id, r]));
        for (const i of todo) {
          const r = byId.get(i);
          if (!r) again.push(i);
          else if (r.error) {
            if (!retryable(r.error.code)) throw new RpcError(r.error.code, r.error.message);
            again.push(i);
          } else out[i] = r.result as T;
        }
      }
      todo = again;
    }
    return out;
  }

  private async post(body: object[]): Promise<Reply[] | RpcError> {
    this.requests++;
    this.calls += body.length;
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return new RpcError(503, (e as Error).message);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return new RpcError(res.status >= 400 ? res.status : 502, text.slice(0, 200));
    }
    if (Array.isArray(json)) return json as Reply[];
    const single = json as Reply;
    // A batch turned away as a whole comes back as one error object.
    return new RpcError(single.error?.code ?? res.status, single.error?.message ?? text.slice(0, 200));
  }
}
