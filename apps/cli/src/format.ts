import { formatUnits } from "viem";
import { PHASE_NAMES, VERDICT_NAMES, type Preview, type Status } from "@curb/sdk";

const at = (t: number) => (t ? new Date(t * 1000).toISOString().replace(".000Z", "Z") : "-");

export function formatStatus(hook: string, s: Status, now = Math.floor(Date.now() / 1000)): string {
  const lines = [
    `hook      ${hook}`,
    `phase     ${PHASE_NAMES[s.phase] ?? s.phase}   incident ${s.nonce}`,
    `price     tick ${s.tick}   reference ${s.ref}   band [${s.lower}, ${s.upper}]`,
  ];
  if (s.edgeSince) lines.push(`limit     since ${at(s.edgeSince)}, halts at ${at(s.haltStart)}`);
  if (s.reopensAt && now < s.reopensAt) lines.push(`halt      ${at(s.haltStart)} -> reopens by ${at(s.reopensAt)}`);
  if (s.cooldownEnd && now < s.cooldownEnd) lines.push(`cooldown  until ${at(s.cooldownEnd)}`);
  if (s.pinUntil && now < s.pinUntil) lines.push(`pinned    until ${at(s.pinUntil)}`);
  if (s.verdict) lines.push(`verdict   ${VERDICT_NAMES[s.verdict]}`);
  lines.push(`window    L2 blocks ${s.fromBlock}..${s.toBlock}, volume ${s.windowVolume}`);
  return lines.join("\n");
}

export function formatPreview(p: Preview, decimals0 = 18, decimals1 = 18): string {
  if (p.ok) {
    return (
      `would pass: amount0 ${formatUnits(p.amount0, decimals0)}, amount1 ${formatUnits(p.amount1, decimals1)}, ` +
      `ending at tick ${p.tickAfter}`
    );
  }
  if (p.error) return `${p.error.name}: ${p.error.human}`;
  return `reverted without a reason Curb knows${p.raw ? `: ${p.raw}` : ""}`;
}
