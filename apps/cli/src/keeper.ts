import { Phase } from "@curb/sdk";
import type { AttestationDoc } from "./imd";

/** What the keeper knows about one bound pool at one moment. */
export interface PoolView {
  hook: `0x${string}`;
  kind: "launch" | "drill";
  phase: Phase;
  nonce: number;
  /** The desk's record of this nonce: 0 none, 1 filed, 2 answered, 3 failed. */
  incidentState: number;
  treasury: bigint;
  questionPrice: bigint;
  /** The filed request still waiting on the desk, with the oracle's answer if IMD has it. */
  pending?: { requestId: `0x${string}`; attestation: AttestationDoc | null };
  /** Seconds since fees were last swept (launch pool only). */
  sinceClaim: number;
  /** Unix seconds now. */
  now: number;
  /** File drill halts too. Off by default: a drill question is paid from the launch pool's fees. */
  fileDrill?: boolean;
}

export type Action =
  | { kind: "file"; hook: `0x${string}`; nonce: number }
  | { kind: "push"; hook: `0x${string}`; requestId: `0x${string}`; attestation: AttestationDoc }
  | { kind: "claim" }
  | { kind: "wait"; why: string };

export const CLAIM_EVERY = 3600;
/** The desk's floors for an answer (`CurbDesk.PANEL_SIZE`, `CurbDesk.QUORUM`). */
const PANEL_SIZE = 7;
const QUORUM = 5;

/**
 * One tick of the keeper for one pool. It never pays for more than the desk would: filing happens
 * only while the halt is live, the incident is unfiled and the treasury covers the question
 * (a launch pool's fees are swept by the filing itself, so it files whenever halted and unfiled).
 */
export function decide(v: PoolView): Action[] {
  const out: Action[] = [];
  if (v.phase === Phase.Halted && v.incidentState === 0) {
    if (v.kind === "drill" && !v.fileDrill) out.push({ kind: "wait", why: "drill halt: not filed without --file-drill" });
    else if (v.kind === "launch" || v.treasury >= v.questionPrice) out.push({ kind: "file", hook: v.hook, nonce: v.nonce });
    else out.push({ kind: "wait", why: "halted, but the desk cannot pay for a question" });
  }
  if (v.pending?.attestation) {
    const why = rejection(v.pending.attestation, v.now);
    if (why) out.push({ kind: "wait", why });
    else out.push({ kind: "push", hook: v.hook, requestId: v.pending.requestId, attestation: v.pending.attestation });
  }
  if (v.kind === "launch" && v.sinceClaim >= CLAIM_EVERY) out.push({ kind: "claim" });
  if (out.length === 0) out.push({ kind: "wait", why: `phase ${Phase[v.phase].toLowerCase()}` });
  return out;
}

/** Why the desk would refuse this answer, or null if it would take it. Pushing a refused answer
 * only burns gas, and the incident stays filed, so the next tick would try again. */
function rejection(doc: AttestationDoc, now: number): string | null {
  const n = (k: string) => Number(doc.message[k]);
  if (now >= n("expiresAt")) return `the answer expired at ${n("expiresAt")}`;
  if (n("panelSize") < PANEL_SIZE) return `the desk needs a panel of ${PANEL_SIZE}, got ${n("panelSize")}`;
  if (n("quorum") < QUORUM) return `the desk needs a quorum of ${QUORUM}, got ${n("quorum")}`;
  if (n("agreed") < n("quorum")) return `${n("agreed")} agreed, short of the quorum of ${n("quorum")}`;
  return null;
}

/** Runs one tick's actions in order. A failed one is logged and the rest still run, so a single
 * refusal (a desk short of IMD, an answer that went stale) never stops the keeper. */
export async function runActions(actions: Action[], send: (a: Action) => Promise<void>, log: (line: string) => void) {
  for (const a of actions) {
    try {
      await send(a);
    } catch (e) {
      log(`${a.kind} failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
}

const ANSWER_TYPES: Record<string, number> = {
  bool: 0,
  address: 1,
  bytes32: 2,
  uint256: 3,
  "address[]": 4,
  "bytes32[]": 5,
};

/** IMD's EIP-712 attestation document as the tuple `submitAttestation` takes. */
export function attestationTuple(doc: AttestationDoc) {
  const field = (k: string): string | number => {
    const v = doc.message[k];
    if (v === undefined) throw new Error(`attestation is missing ${k}`);
    return v;
  };
  const raw = field("answerType");
  const answerType = typeof raw === "number" ? raw : ANSWER_TYPES[raw];
  if (answerType === undefined) throw new Error(`unknown answer type ${raw}`);
  return {
    requestId: field("requestId") as `0x${string}`,
    chainId: BigInt(field("chainId")),
    questionHash: field("questionHash") as `0x${string}`,
    answerType,
    answer: field("answer") as `0x${string}`,
    figure: BigInt(field("figure")),
    fromBlock: BigInt(field("fromBlock")),
    toBlock: BigInt(field("toBlock")),
    blockHash: field("blockHash") as `0x${string}`,
    panelJobId: field("panelJobId") as `0x${string}`,
    panelSize: Number(field("panelSize")),
    quorum: Number(field("quorum")),
    agreed: Number(field("agreed")),
    issuedAt: BigInt(field("issuedAt")),
    expiresAt: BigInt(field("expiresAt")),
  };
}
