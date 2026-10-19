import type { Address, Hex } from "viem";
import { VERDICT_NAMES } from "@curb/sdk";
import { formatAmount, formatClock, formatDuration, formatTick, shortHex } from "./format";

/** One decoded log, flattened to what the site needs. */
export interface ChainLog {
  eventName: string;
  args: Record<string, unknown>;
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  /** Block time in seconds. */
  timestamp: number;
}

export type LineKind = "trade" | "limit" | "halt" | "reference" | "verdict";

export interface TimelineLine {
  kind: LineKind;
  event: string;
  text: string;
}

/** Every event one transaction emitted, newest transaction first. */
export interface TimelineItem {
  tx: Hex;
  block: bigint;
  timestamp: number;
  lines: TimelineLine[];
}

export interface TimelineContext {
  paired: { symbol: string; decimals: number };
}

const num = (v: unknown) => Number(v as number | bigint);

export function verdictName(v: unknown): string {
  return VERDICT_NAMES[num(v)] ?? String(v);
}

/** A hook event as one sentence, or null for events the timeline does not show. */
export function describe(log: ChainLog, ctx: TimelineContext): TimelineLine | null {
  const a = log.args;
  switch (log.eventName) {
    case "Trade":
      return {
        kind: "trade",
        event: "Trade",
        text: `${shortHex(String(a.trader))} traded ${formatAmount(a.volume as bigint, ctx.paired.decimals)} ${ctx.paired.symbol}`,
      };
    case "LimitEntered":
      return {
        kind: "limit",
        event: "LimitEntered",
        text: `Entered the edge zone at tick ${formatTick(num(a.tick))}; halts at ${formatClock(num(a.haltsAt))} if it stays`,
      };
    case "LimitCleared":
      return { kind: "limit", event: "LimitCleared", text: `Left the edge zone at tick ${formatTick(num(a.tick))}` };
    case "ReferenceRolled":
      return {
        kind: "reference",
        event: "ReferenceRolled",
        text: `Reference rolled to ${formatTick(num(a.ref))} (window average ${formatTick(num(a.twap))})`,
      };
    case "ReferenceReanchored":
      return {
        kind: "reference",
        event: "ReferenceReanchored",
        text: `Reference re-anchored to ${formatTick(num(a.ref))}, beside liquidity that starts at ${formatTick(num(a.boundary))}`,
      };
    case "Resolved":
      return {
        kind: "verdict",
        event: "Resolved",
        text: `Verdict ${verdictName(a.verdict)} applied to halt ${num(a.nonce)}; reopens by ${formatClock(num(a.reopensAt))}`,
      };
    case "HaltClosed": {
      const length = num(a.haltEnd) - num(a.haltStart);
      const how = num(a.verdict) === 0 ? "no verdict, full length" : `verdict ${verdictName(a.verdict)}`;
      return {
        kind: "halt",
        event: "HaltClosed",
        text:
          `Halt ${num(a.nonce)} closed after ${formatDuration(length)} (${how}); reference set to ` +
          `${formatTick(num(a.newRef))}, cooldown until ${formatClock(num(a.cooldownEnd))}`,
      };
    }
    default:
      return null;
  }
}

const order = (a: ChainLog, b: ChainLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

/** Groups the hook's logs by transaction, newest first, each transaction's events in emit order. */
export function timeline(logs: readonly ChainLog[], ctx: TimelineContext, limit = Infinity): TimelineItem[] {
  const byTx = new Map<Hex, TimelineItem>();
  for (const log of [...logs].sort(order)) {
    const line = describe(log, ctx);
    if (!line) continue;
    let item = byTx.get(log.transactionHash);
    if (!item) {
      item = { tx: log.transactionHash, block: log.blockNumber, timestamp: log.timestamp, lines: [] };
      byTx.set(log.transactionHash, item);
    }
    item.lines.push(line);
  }
  return [...byTx.values()].reverse().slice(0, limit);
}

/** Merges a fresh page of logs into what is held, dropping duplicates by (tx, logIndex). */
export function mergeLogs(held: readonly ChainLog[], fresh: readonly ChainLog[]): ChainLog[] {
  const seen = new Set(held.map((l) => `${l.transactionHash}:${l.logIndex}`));
  const out = [...held];
  for (const l of fresh) {
    const k = `${l.transactionHash}:${l.logIndex}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(l);
    }
  }
  return out.sort(order);
}
