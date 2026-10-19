import { ADDRESSES, curbDeskAbi, curbHookAbi, Phase, VERDICT_NAMES } from "@curb/sdk";
import { erc20Abi, hexToString, parseAbi, type Hex } from "viem";
import type { Context } from "../context";
import { amount, iso } from "../format";
import { ACTIONS, FIRST_BLOCK, LOG_SPAN, resolveHook, txUrl } from "../known";
import { readHookStatus, readPool } from "../pool";

export interface IncidentsInput {
  hook?: string;
  limit?: number;
  fromBlock?: number;
}

const intakeAbi = parseAbi(["function priceOf(bytes32 action, address asset) view returns (uint256)"]);

const verdictName = (v: number) => VERDICT_NAMES[v] ?? String(v);
const ascii = (b: Hex) => hexToString(b).replace(/\0+$/, "");

interface Incident {
  nonce: number;
  state: "in progress" | "ended, closes on the next swap" | "closed" | "unknown";
  halt: { start: string | null; end: string | null; seconds: number | null } | null;
  close: { verdict: string; newReference: number; cooldownEnd: string | null; tx: string } | null;
  resolved: { verdict: string; reopensAt: string | null; tx: string } | null;
  filed: {
    requestId: Hex;
    questionHash: Hex;
    fromBlock: string;
    toBlock: string;
    windowVolume: string;
    tx: string;
  } | null;
  answer: {
    verdict: string;
    shareBps: number;
    leader: string;
    figure: string;
    total: string;
    applied: boolean;
    tx: string;
  } | null;
  failure: { status: number; reason: string; tx: string } | null;
  notes: string[];
}

/** Block ranges the RPC accepts, from `from` to `to` inclusive. */
export function spans(from: bigint, to: bigint, size: bigint = LOG_SPAN): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += size) out.push([a, a + size - 1n < to ? a + size - 1n : to]);
  return out;
}

export async function curbIncidents(ctx: Context, input: IncidentsInput) {
  const hook = resolveHook(input.hook, ctx.deployments);
  const desk = ctx.deployments.desk;
  const c = ctx.client;
  const head = await c.getBlockNumber();
  const ranges = spans(input.fromBlock !== undefined ? BigInt(input.fromBlock) : FIRST_BLOCK, head);
  const over = async <T>(fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>) =>
    (await Promise.all(ranges.map(([a, b]) => fetch(a, b)))).flat();

  const [pool, s, block, closed, resolved, filed, verdicts, failures, treasury, price] = await Promise.all([
    readPool(ctx, hook),
    readHookStatus(ctx, hook),
    c.getBlock(),
    over((fromBlock, toBlock) => c.getContractEvents({ address: hook, abi: curbHookAbi, eventName: "HaltClosed", fromBlock, toBlock })),
    over((fromBlock, toBlock) => c.getContractEvents({ address: hook, abi: curbHookAbi, eventName: "Resolved", fromBlock, toBlock })),
    over((fromBlock, toBlock) =>
      c.getContractEvents({ address: desk, abi: curbDeskAbi, eventName: "IncidentFiled", args: { hook }, fromBlock, toBlock }),
    ),
    over((fromBlock, toBlock) =>
      c.getContractEvents({ address: desk, abi: curbDeskAbi, eventName: "VerdictReached", args: { hook }, fromBlock, toBlock }),
    ),
    over((fromBlock, toBlock) => c.getContractEvents({ address: desk, abi: curbDeskAbi, eventName: "RequestFailed", fromBlock, toBlock })),
    c.readContract({ address: ADDRESSES.imd, abi: erc20Abi, functionName: "balanceOf", args: [desk] }),
    c.readContract({ address: ADDRESSES.intake, abi: intakeAbi, functionName: "priceOf", args: [ACTIONS.oracleRequest, ADDRESSES.imd] }),
  ]);
  const now = Number(block.timestamp);
  const vol = (x: bigint) => amount(x, pool.paired.decimals, pool.paired.symbol);

  const byNonce = new Map<number, Incident>();
  const at = (nonce: number): Incident => {
    let i = byNonce.get(nonce);
    if (!i) {
      i = { nonce, state: "unknown", halt: null, close: null, resolved: null, filed: null, answer: null, failure: null, notes: [] };
      byNonce.set(nonce, i);
    }
    return i;
  };

  for (const l of closed) {
    const a = l.args;
    const i = at(Number(a.nonce));
    i.state = "closed";
    i.halt = { start: iso(a.haltStart!), end: iso(a.haltEnd!), seconds: Number(a.haltEnd! - a.haltStart!) };
    i.close = { verdict: verdictName(a.verdict!), newReference: a.newRef!, cooldownEnd: iso(a.cooldownEnd!), tx: txUrl(l.transactionHash) };
  }
  for (const l of resolved) {
    const a = l.args;
    at(Number(a.nonce)).resolved = { verdict: verdictName(a.verdict!), reopensAt: iso(a.reopensAt!), tx: txUrl(l.transactionHash) };
  }
  const byRequest = new Map<string, Incident>();
  for (const l of filed) {
    const a = l.args;
    const i = at(Number(a.nonce));
    i.filed = {
      requestId: a.requestId!,
      questionHash: a.questionHash!,
      fromBlock: a.fromBlock!.toString(),
      toBlock: a.toBlock!.toString(),
      windowVolume: vol(a.total!),
      tx: txUrl(l.transactionHash),
    };
    byRequest.set(a.requestId!.toLowerCase(), i);
  }
  for (const l of verdicts) {
    const a = l.args;
    at(Number(a.nonce)).answer = {
      verdict: verdictName(a.verdict!),
      shareBps: a.shareBps!,
      leader: a.leader!,
      figure: vol(a.figure!),
      total: vol(a.total!),
      applied: a.applied!,
      tx: txUrl(l.transactionHash),
    };
  }
  for (const l of failures) {
    const i = byRequest.get(l.args.requestId!.toLowerCase());
    if (i) i.failure = { status: l.args.status!, reason: ascii(l.args.reason!), tx: txUrl(l.transactionHash) };
  }

  const ended = s.edgeSince !== 0 && s.reopensAt !== 0 && now >= s.reopensAt;
  if (s.phase === Phase.Halted || ended) {
    const i = at(s.nonce);
    i.state = s.phase === Phase.Halted ? "in progress" : "ended, closes on the next swap";
    i.halt = { start: iso(s.haltStart), end: iso(s.reopensAt), seconds: s.reopensAt - s.haltStart };
    if (s.phase === Phase.Halted && !i.filed) {
      i.notes.push(
        `Not filed yet. Anyone may call fileIncident(${hook}) on the desk ${desk}; it pays the oracle question from its treasury, ` +
          `once the window's last block (${s.toBlock}) is 8 L2 blocks deep.`,
      );
    }
  }

  const proofs = pool.label === "drill" ? ctx.deployments.proofs?.drill : undefined;
  for (const i of byNonce.values()) {
    if (i.state !== "closed" || i.filed) continue;
    const unfunded = proofs?.treasuryShort && proofs.haltClosed && i.close?.tx === txUrl(proofs.haltClosed);
    if (unfunded) {
      i.notes.push(
        `This halt ran unfunded: fileIncident reverted TreasuryShort because the desk's treasury could not pay for the ` +
          `oracle question (${txUrl(proofs.treasuryShort!)}). No verdict was asked for, so the halt ran its full length ` +
          `and the pool re-centred on close.`,
      );
    } else if (i.close?.verdict === "none") {
      i.notes.push("No incident was filed for this halt; it ran its full length and the pool re-centred on close.");
    }
  }

  const all = [...byNonce.values()].sort((a, b) => b.nonce - a.nonce);
  const incidents = all.slice(0, input.limit ?? 10);
  const canPay = treasury >= price;
  const summary =
    `${all.length} incident${all.length === 1 ? "" : "s"} on ${pool.name}${pool.label ? ` (${pool.label} pool)` : ""}. ` +
    `The desk holds ${amount(treasury, 18, "IMD")} and an oracle question costs ${amount(price, 18, "IMD")}, so a filing now ` +
    (canPay ? "would be paid." : "would revert TreasuryShort until someone funds the desk (CurbDesk.fund).");

  return {
    summary,
    hook,
    pool: pool.name,
    phase: s.phaseName,
    desk: {
      address: desk,
      binding: pool.deskBinding,
      treasury: amount(treasury, 18, "IMD"),
      questionPrice: amount(price, 18, "IMD"),
      canPayForQuestion: canPay,
    },
    incidents,
    ...(proofs ? { drillProofs: Object.fromEntries(Object.entries(proofs).map(([k, h]) => [k, txUrl(h!)])) } : {}),
    scanned: { fromBlock: ranges[0]?.[0].toString() ?? null, toBlock: head.toString() },
  };
}
