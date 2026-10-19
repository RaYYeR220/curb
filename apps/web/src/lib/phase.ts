import { Phase, type Status } from "@curb/sdk";
import { formatClock, formatSpan } from "./format";

/** The hook's `params()`, with numbers where the ABI gives bigints that always fit. */
export interface HookParams {
  bandTicks: number;
  edgeTicks: number;
  refWindow: number;
  limitSeconds: number;
  haltSeconds: number;
  cooldownSeconds: number;
  minLiquidity: bigint;
  arbBlocks: boolean;
}

export type PhaseName = "open" | "limit" | "halted" | "cooldown";

const NAMES: Record<Phase, PhaseName> = {
  [Phase.Open]: "open",
  [Phase.Limit]: "limit",
  [Phase.Halted]: "halted",
  [Phase.Cooldown]: "cooldown",
};

const TITLES: Record<PhaseName, string> = { open: "Open", limit: "Limit", halted: "Halted", cooldown: "Cooldown" };

/**
 * The phase at `now` from a status read a few seconds earlier. Halts are a function of stored
 * state and the clock, so between polls the board can move from Limit to Halted on its own,
 * exactly as the hook would.
 */
export function phaseAt(s: Status, p: HookParams, now: number): Phase {
  if (s.edgeSince !== 0) {
    if (now < s.haltStart) return Phase.Limit;
    if (now < s.reopensAt) return Phase.Halted;
    return now < s.haltStart + p.haltSeconds + p.cooldownSeconds ? Phase.Cooldown : Phase.Open;
  }
  return now < s.cooldownEnd ? Phase.Cooldown : Phase.Open;
}

export interface Countdown {
  key: "halt" | "reopen" | "cooldown" | "pin";
  label: string;
  at: number;
}

export interface StatusView {
  phase: Phase;
  name: PhaseName;
  title: string;
  sentence: string;
  countdowns: Countdown[];
  /** Ticks between the price and the reference. */
  distance: number;
  /** Whether the price sits in the edge zone right now. */
  inEdge: boolean;
}

export function statusView(s: Status, p: HookParams, now: number): StatusView {
  const phase = phaseAt(s, p, now);
  const name = NAMES[phase];
  const distance = Math.abs(s.tick - s.ref);
  const inEdge = distance >= p.bandTicks - p.edgeTicks;
  const cooldownEnd = s.edgeSince !== 0 ? s.haltStart + p.haltSeconds + p.cooldownSeconds : s.cooldownEnd;
  const countdowns: Countdown[] = [];
  let sentence: string;

  switch (name) {
    case "limit":
      sentence =
        `The price is in the edge zone. If it is still there at ${formatClock(s.haltStart)}, ` +
        `the pool halts both ways for up to ${formatSpan(p.haltSeconds)}.`;
      countdowns.push({ key: "halt", label: "Halts", at: s.haltStart });
      break;
    case "halted":
      sentence =
        `Halted both ways after ${formatSpan(p.limitSeconds)} at the edge. Trading reopens by ` +
        `${formatClock(s.reopensAt)} at the latest, sooner if the oracle finds the move organic.`;
      countdowns.push({ key: "reopen", label: "Reopens by", at: s.reopensAt });
      countdowns.push({ key: "cooldown", label: "Cooldown ends", at: cooldownEnd });
      break;
    case "cooldown":
      sentence =
        `Trading again inside the band. No new halt can begin before ` +
        `${formatClock(cooldownEnd + p.limitSeconds)}.`;
      countdowns.push({ key: "cooldown", label: "Cooldown ends", at: cooldownEnd });
      break;
    default:
      sentence = "Trading normally. A swap that ends inside the band passes; one that would leave it is refused.";
      if (cooldownEnd > 0) countdowns.push({ key: "cooldown", label: "Last cooldown ended", at: cooldownEnd });
  }

  if (s.pinUntil > now) {
    sentence += ` The reference is pinned to its pre-move level until ${formatClock(s.pinUntil)}.`;
    countdowns.push({ key: "pin", label: "Pin lifts", at: s.pinUntil });
  }

  return { phase, name, title: TITLES[name], sentence, countdowns, distance, inEdge };
}
