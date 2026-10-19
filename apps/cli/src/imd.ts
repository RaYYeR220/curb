/** The parts of IMD's HTTP API the CLI and the keeper use. `fetch` is injectable for tests. */
export const IMD_API = "https://api.imd.fun";

export interface IntakeEntry {
  state: string;
  requestId: string;
  action: string;
  admission?: { result?: { kind?: string; id?: string; jobId?: string } } | null;
  completion?: unknown;
}

export interface AttestationDoc {
  requestId: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  message: Record<string, string | number>;
  signature: `0x${string}`;
  signer: string;
}

export class Imd {
  constructor(
    private readonly base = IMD_API,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.http(`${this.base}${path}`, init);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  health() {
    return this.json<{ intake?: { chains?: { chainId: number; rpc?: { reachable?: boolean }; writer?: { address?: string } | null; lag?: number }[] } }>(
      "/health",
    );
  }

  check(action: string, input: unknown) {
    return this.json<{ blockers?: { code: string; detail?: string }[]; plan?: { title: string }[]; error?: string; detail?: string }>(
      "/requests/check",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, input }) },
    );
  }

  importRepo(url: string) {
    return this.json<{ ok: boolean; source?: { baseCommit: string }; problems?: { code: string; detail: string }[] }>(
      "/requests/import",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, kind: "contracts" }) },
    );
  }

  intake(chainId: number, txHash: string) {
    return this.json<{ entries?: IntakeEntry[] }>(`/intake/${chainId}/${txHash}`);
  }

  job(id: string) {
    return this.json<{ state?: string; blockedReason?: string | null; launch?: Record<string, unknown> | null }>(`/jobs/${id}`);
  }

  /** The signed answer, or null while the panel has not attested. */
  async attestation(oracleRequestId: string): Promise<AttestationDoc | null> {
    const res = await this.http(`${this.base}/oracle/requests/${oracleRequestId}/attestation`);
    if (res.status === 404) return null;
    return (await res.json()) as AttestationDoc;
  }
}
