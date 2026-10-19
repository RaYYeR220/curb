import type { Address, Hex } from "viem";
import type { HookParams } from "./phase";
import type { ChainLog } from "./timeline";

/** The drill pool's real logs on Robinhood Chain, as the RPC returned them on 2026-10-19. */
export const DRILL_HOOK: Address = "0xeE60C95711F5650bbBBee421426820feC6e060c0";
export const STEWARD: Address = "0xE83bc0dddED710C5A6e4E6Fc8d6E5da4Cd46042c";
export const LIMIT_TX: Hex = "0x54fe7b43a44a0e179d8ff4d97d12a6039e8fd0cfb619dc590d48d49654c6d4f8";
export const CLOSE_TX: Hex = "0x9de3edbec3a9433a18919fac13b2344760c04e1adcb166967fc20e7bbe15a9dd";
export const SHORT_TX: Hex = "0xb5e739198e9868f42f2510264755d495e42f1ff8202eadc889d3fac1cfe79ab7";
export const INIT_BLOCK = 92857518n;

export const drillParams: HookParams = {
  bandTicks: 300,
  edgeTicks: 60,
  refWindow: 120,
  limitSeconds: 10,
  haltSeconds: 300,
  cooldownSeconds: 300,
  minLiquidity: 10n ** 18n,
  arbBlocks: true,
};

const log = (
  eventName: string,
  args: Record<string, unknown>,
  blockNumber: bigint,
  logIndex: number,
  transactionHash: Hex,
  timestamp: number,
): ChainLog => ({ eventName, args, address: DRILL_HOOK, blockNumber, logIndex, transactionHash, timestamp });

export const drillLogs: ChainLog[] = [
  log("Trade", { trader: STEWARD, volume: 1065106246299n }, 92857808n, 3, LIMIT_TX, 1792437689),
  log("LimitEntered", { nonce: 0, ref: 230400, tick: 230129, haltsAt: 1792437699n }, 92857808n, 4, LIMIT_TX, 1792437689),
  log(
    "HaltClosed",
    { nonce: 0, haltStart: 1792437699n, haltEnd: 1792437999n, verdict: 0, newRef: 230129, cooldownEnd: 1792438299n },
    92861075n,
    1,
    CLOSE_TX,
    1792438019,
  ),
  log("Trade", { trader: STEWARD, volume: 1000000000n }, 92861075n, 3, CLOSE_TX, 1792438019),
];
