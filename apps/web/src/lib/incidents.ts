import type { Address, Hex } from "viem";
import { Verdict, type Status } from "@curb/sdk";
import type { HookParams } from "./phase";
import type { ChainLog } from "./timeline";
import { formatSpan } from "./format";

/** The desk's rule, as CurbDesk.classify states it. */
export const ORGANIC_MAX_BPS = 3000;
export const CONCENTRATED_MIN_BPS = 6000;

export function classify(figure: bigint, total: bigint): { verdict: Verdict; shareBps: number } {
  if (total === 0n || figure === 0n || figure > total) return { verdict: Verdict.Inconclusive, shareBps: 0 };
  const shareBps = Number((figure * 10_000n) / total);
  if (shareBps <= ORGANIC_MAX_BPS) return { verdict: Verdict.Organic, shareBps };
  if (shareBps >= CONCENTRATED_MIN_BPS) return { verdict: Verdict.Concentrated, shareBps };
  return { verdict: Verdict.Inconclusive, shareBps };
}

/** A `fileIncident` call that was mined and reverted; logs never show these, so they come from the proofs. */
export interface FailedFiling {
  hash: Hex;
  hook: Address;
  block: bigint;
  timestamp: number;
  error: string;
}

export interface IncidentWindow {
  fromBlock: bigint;
  toBlock: bigint;
  /** Read from the desk's IncidentFiled, or rebuilt from the hook's own logs when nothing was filed. */
  source: "filed" | "rebuilt";
}

/** The Trade tape over a window, ranked the way the oracle is asked to rank it. */
export interface Tape {
  trades: number;
  traders: number;
  total: bigint;
  leader: Address | null;
  figure: bigint;
  verdict: Verdict;
  shareBps: number;
}

export type DecisionKind = "organic" | "concentrated" | "inconclusive" | "default" | "pending";

export interface Incident {
  hook: Address;
  nonce: number;
  state: "halted" | "ended" | "closed";
  haltStart: number;
  haltEnd: number;
  /** Whether the halt ran to its maximum. */
  ranFull: boolean;
  limit?: { tx: Hex; timestamp: number; tick: number; ref: number };
  closed?: { tx: Hex; timestamp: number; newRef: number; cooldownEnd: number; verdict: Verdict };
  resolved?: { tx: Hex; timestamp: number; verdict: Verdict; reopensAt: number };
  filed?: { tx: Hex; timestamp: number; requestId: Hex; questionHash: Hex; total: bigint };
  answer?: {
    tx: Hex;
    timestamp: number;
    verdict: Verdict;
    shareBps: number;
    leader: Address;
    figure: bigint;
    total: bigint;
    applied: boolean;
  };
  requestFailed?: { tx: Hex; timestamp: number; status: number; reason: Hex };
  postMortem?: { tx: Hex; requestId: Hex; delivered?: { tx: Hex; uri: string } };
  failedFilings: FailedFiling[];
  window: IncidentWindow | null;
  tape: Tape | null;
  decision: { kind: DecisionKind; label: string; sentence: string };
}

export interface IncidentInput {
  hook: Address;
  params: HookParams;
  hookLogs: readonly ChainLog[];
  deskLogs: readonly ChainLog[];
  /** The block the pool was initialised in: the hook's first incident window starts there. */
  initBlock?: bigint;
  status?: Status;
  now: number;
  failedFilings?: readonly FailedFiling[];
}

const num = (v: unknown) => Number(v as number | bigint);
const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();

/**
 * The block window a filing would have asked about, rebuilt from logs: the hook's `incidentWindow()`
 * runs from the start of the previous reference window to the last successful swap. Windows start
 * at initialisation and at every HaltClosed, ReferenceRolled and ReferenceReanchored.
 */
export function rebuildWindow(
  hookLogs: readonly ChainLog[],
  initBlock: bigint | undefined,
  haltStart: number,
): IncidentWindow | null {
  const trades = hookLogs.filter((l) => l.eventName === "Trade" && l.timestamp < haltStart);
  const last = trades[trades.length - 1];
  if (!last) return null;
  const toBlock = last.blockNumber;
  const shifts: bigint[] = initBlock !== undefined ? [initBlock] : [];
  for (const l of hookLogs) {
    if (l.blockNumber > toBlock) break;
    if (l.eventName === "HaltClosed" || l.eventName === "ReferenceRolled" || l.eventName === "ReferenceReanchored") {
      shifts.push(l.blockNumber);
    }
  }
  if (shifts.length === 0) return null;
  const fromBlock = shifts.length >= 2 ? shifts[shifts.length - 2]! : shifts[0]!;
  return { fromBlock, toBlock, source: "rebuilt" };
}

/** Sums the Trade tape per trader over a block window. */
export function tapeOver(hookLogs: readonly ChainLog[], w: IncidentWindow): Tape {
  const per = new Map<string, bigint>();
  let total = 0n;
  let trades = 0;
  for (const l of hookLogs) {
    if (l.eventName !== "Trade" || l.blockNumber < w.fromBlock || l.blockNumber > w.toBlock) continue;
    const v = l.args.volume as bigint;
    const who = String(l.args.trader).toLowerCase();
    per.set(who, (per.get(who) ?? 0n) + v);
    total += v;
    trades++;
  }
  let leader: string | null = null;
  let figure = 0n;
  for (const [who, v] of per) {
    if (v > figure) {
      leader = who;
      figure = v;
    }
  }
  const c = classify(figure, total);
  return { trades, traders: per.size, total, leader: leader as Address | null, figure, ...c };
}

function decide(inc: Omit<Incident, "decision">, p: HookParams): Incident["decision"] {
  const full = formatSpan(p.haltSeconds);
  const a = inc.answer;
  if (a?.applied && a.verdict === Verdict.Organic) {
    return {
      kind: "organic",
      label: "Organic: reopened early",
      sentence: `The top trader did ${(a.shareBps / 100).toFixed(2)}% of the window's volume, at most 30%, so the move reads as organic and the halt ended early.`,
    };
  }
  if (a?.applied && a.verdict === Verdict.Concentrated) {
    return {
      kind: "concentrated",
      label: "Concentrated: pinned",
      sentence: `One trader did ${(a.shareBps / 100).toFixed(2)}% of the window's volume, at least 60%, so the pool sat out the full halt and reopens on the reference from before the move, pinned through the cooldown.`,
    };
  }
  if (a) {
    return {
      kind: "inconclusive",
      label: a.verdict === Verdict.Inconclusive ? "Inconclusive: no change" : "Answered late: not applied",
      sentence:
        a.verdict === Verdict.Inconclusive
          ? `The top trader's share (${(a.shareBps / 100).toFixed(2)}%) is between 30% and 60%, so the verdict changes nothing and the halt runs its course.`
          : "The answer landed after this halt was over. It is recorded against the incident and never applied to another one.",
    };
  }
  if (inc.requestFailed) {
    return {
      kind: "default",
      label: "Oracle request failed",
      sentence: `The oracle request failed, the desk does not pay twice for one incident, and the halt ran its full ${full}.`,
    };
  }
  if (inc.filed) {
    return inc.state === "closed"
      ? { kind: "default", label: "No answer in time", sentence: `No answer arrived during the halt, so it ran its full ${full}.` }
      : { kind: "pending", label: "Asked; waiting for the oracle", sentence: "The desk has paid for the question and the panel is answering." };
  }
  if (inc.failedFilings.length > 0) {
    const reason = inc.failedFilings[0]!.error;
    return {
      kind: "default",
      label: reason === "TreasuryShort" ? "Desk unfunded: not asked" : "Filing reverted: not asked",
      sentence:
        reason === "TreasuryShort"
          ? `fileIncident reverted with TreasuryShort: the desk had no IMD to pay for the question. With no verdict the halt ran its full ${full} and the pool re-centred on its last price.`
          : `fileIncident reverted with ${reason}. With no verdict the halt ran its full ${full}.`,
    };
  }
  if (inc.state === "closed") {
    return {
      kind: "default",
      label: "Not asked: default policy",
      sentence: `Nobody filed this halt with the oracle, so it ran its full ${full} and the pool re-centred on its last price.`,
    };
  }
  return {
    kind: "pending",
    label: "Not filed yet",
    sentence: "Anyone can call fileIncident on the desk while the pool is halted; the desk pays for the question.",
  };
}

/** Every halt a hook has had, joined with what the desk did about it, newest first. */
export function buildIncidents(input: IncidentInput): Incident[] {
  const { hook, params: p, hookLogs, now } = input;
  const deskLogs = input.deskLogs.filter((l) => l.args.hook === undefined || same(l.args.hook, hook));
  const nonces = new Set<number>();
  for (const l of hookLogs) if (l.eventName === "HaltClosed" || l.eventName === "Resolved") nonces.add(num(l.args.nonce));
  for (const l of deskLogs) if (l.args.nonce !== undefined) nonces.add(num(l.args.nonce));
  const s = input.status;
  const current = s && s.edgeSince !== 0 && now >= s.haltStart ? s.nonce : undefined;
  if (current !== undefined) nonces.add(current);

  const out: Incident[] = [];
  for (const nonce of nonces) {
    const close = hookLogs.find((l) => l.eventName === "HaltClosed" && num(l.args.nonce) === nonce);
    let haltStart: number;
    let haltEnd: number;
    let state: Incident["state"];
    if (close) {
      haltStart = num(close.args.haltStart);
      haltEnd = num(close.args.haltEnd);
      state = "closed";
    } else if (nonce === current && s) {
      haltStart = s.haltStart;
      haltEnd = s.reopensAt;
      state = now < s.reopensAt ? "halted" : "ended";
    } else {
      continue;
    }

    const limitLog = [...hookLogs]
      .reverse()
      .find((l) => l.eventName === "LimitEntered" && num(l.args.nonce) === nonce && num(l.args.haltsAt) === haltStart);
    const resolvedLog = hookLogs.find((l) => l.eventName === "Resolved" && num(l.args.nonce) === nonce);
    const filedLog = deskLogs.find((l) => l.eventName === "IncidentFiled" && num(l.args.nonce) === nonce);
    const verdictLog = deskLogs.find((l) => l.eventName === "VerdictReached" && num(l.args.nonce) === nonce);
    const requestId = filedLog?.args.requestId as Hex | undefined;
    const failedLog = requestId
      ? input.deskLogs.find((l) => l.eventName === "RequestFailed" && same(l.args.requestId, requestId))
      : undefined;
    const pmLog = deskLogs.find((l) => l.eventName === "PostMortemCommissioned" && num(l.args.nonce) === nonce);
    const pmDone = deskLogs.find((l) => l.eventName === "PostMortemDelivered" && num(l.args.nonce) === nonce);

    const window: IncidentWindow | null = filedLog
      ? { fromBlock: BigInt(filedLog.args.fromBlock as bigint), toBlock: BigInt(filedLog.args.toBlock as bigint), source: "filed" }
      : rebuildWindow(hookLogs, input.initBlock, haltStart);

    const base: Omit<Incident, "decision"> = {
      hook,
      nonce,
      state,
      haltStart,
      haltEnd,
      ranFull: haltEnd >= haltStart + p.haltSeconds,
      limit: limitLog && {
        tx: limitLog.transactionHash,
        timestamp: limitLog.timestamp,
        tick: num(limitLog.args.tick),
        ref: num(limitLog.args.ref),
      },
      closed: close && {
        tx: close.transactionHash,
        timestamp: close.timestamp,
        newRef: num(close.args.newRef),
        cooldownEnd: num(close.args.cooldownEnd),
        verdict: num(close.args.verdict) as Verdict,
      },
      resolved: resolvedLog && {
        tx: resolvedLog.transactionHash,
        timestamp: resolvedLog.timestamp,
        verdict: num(resolvedLog.args.verdict) as Verdict,
        reopensAt: num(resolvedLog.args.reopensAt),
      },
      filed: filedLog && {
        tx: filedLog.transactionHash,
        timestamp: filedLog.timestamp,
        requestId: filedLog.args.requestId as Hex,
        questionHash: filedLog.args.questionHash as Hex,
        total: filedLog.args.total as bigint,
      },
      answer: verdictLog && {
        tx: verdictLog.transactionHash,
        timestamp: verdictLog.timestamp,
        verdict: num(verdictLog.args.verdict) as Verdict,
        shareBps: num(verdictLog.args.shareBps),
        leader: verdictLog.args.leader as Address,
        figure: verdictLog.args.figure as bigint,
        total: verdictLog.args.total as bigint,
        applied: Boolean(verdictLog.args.applied),
      },
      requestFailed: failedLog && {
        tx: failedLog.transactionHash,
        timestamp: failedLog.timestamp,
        status: num(failedLog.args.status),
        reason: failedLog.args.reason as Hex,
      },
      postMortem: pmLog && {
        tx: pmLog.transactionHash,
        requestId: pmLog.args.requestId as Hex,
        delivered: pmDone && { tx: pmDone.transactionHash, uri: String(pmDone.args.uri) },
      },
      failedFilings: (input.failedFilings ?? []).filter(
        (f) => same(f.hook, hook) && f.timestamp >= haltStart && f.timestamp < haltEnd,
      ),
      window,
      tape: window ? tapeOver(hookLogs, window) : null,
    };
    out.push({ ...base, decision: decide(base, p) });
  }
  return out.sort((a, b) => b.haltStart - a.haltStart);
}
