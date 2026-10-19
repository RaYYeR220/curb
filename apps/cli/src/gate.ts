/**
 * The pre-payment gate. IMD's processor on a chain can be down (on 2026-10-19 every Intake RPC hit its
 * provider's monthly cap for hours); a payment sent then is spent with nobody to act on it. Pay only
 * when IMD reports the chain reachable, a writer present and little lag.
 */
export const MAX_LAG = 600;

export interface ChainHealth {
  chainId: number;
  rpc?: { reachable?: boolean };
  writer?: { address?: string } | null;
  lag?: number;
}

export function healthGate(health: { intake?: { chains?: ChainHealth[] } }, chainId = 4663) {
  const chain = health.intake?.chains?.find((c) => c.chainId === chainId);
  const reasons: string[] = [];
  if (!chain) reasons.push(`IMD reports no Intake on chain ${chainId}`);
  else {
    if (!chain.rpc?.reachable) reasons.push(`IMD cannot reach chain ${chainId}`);
    if (!chain.writer?.address) reasons.push("IMD's writer is missing");
    if (chain.lag === undefined || chain.lag > MAX_LAG) reasons.push(`IMD is ${chain.lag ?? "?"} blocks behind`);
  }
  return { ok: reasons.length === 0, reasons };
}
