import type { Address, Hex } from "viem";

/** A PoolManager Swap, with its block's timestamp and its transaction's sender. */
export interface SwapEvent {
  kind: "swap";
  block: number;
  index: number;
  time: number;
  tx: Hex;
  /** `tx.from`, which is the `tx.origin` CurbHook would put on its tape. */
  trader: Address;
  /** The swapper's deltas: negative paid in, positive taken out. */
  amount0: bigint;
  amount1: bigint;
  /** In-range liquidity after the swap. */
  liquidity: bigint;
  tick: number;
}

/** A PoolManager ModifyLiquidity: the factory's seed and every later add or remove. */
export interface LiquidityEvent {
  kind: "liquidity";
  block: number;
  index: number;
  tickLower: number;
  tickUpper: number;
  delta: bigint;
}

export type PoolEvent = SwapEvent | LiquidityEvent;

export interface PoolData {
  launchNumber: number;
  token: Address;
  symbol: string;
  hook: Address;
  requester: Address;
  /** IMD or native ETH (the zero address). */
  paired: Address;
  pairedIs0: boolean;
  poolId: Hex;
  fee: number;
  tickSpacing: number;
  launchBlock: number;
  launchTime: number;
  /** The tick the pool was initialised at, from the PoolManager's Initialize event. */
  initTick: number;
  /** `Launched.liquiditySeeded`. */
  seeded: bigint;
  seedLower: number;
  seedUpper: number;
  /** Swaps and liquidity changes in chain order. */
  events: PoolEvent[];
}
