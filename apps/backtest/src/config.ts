import type { Address } from "viem";
import { ADDRESSES, robinhood, type Config } from "@curb/sdk";

/** The CURB/IMD parameters, as in launch.json. */
export const CURB: Config = {
  band: 1000,
  edge: 100,
  refWindow: 300,
  limitSeconds: 15,
  haltSeconds: 900,
  cooldownSeconds: 1800,
};

/**
 * CurbHook's liquidity floor, as a share of the launch's seeded liquidity. CURB's floor is 1e23
 * against the ~1.427e24 an IMD-paired launch seeds, which is 7%. ETH-paired launches seed about
 * 7e22 to 9e22, so an absolute 1e23 would call every one of them illiquid; the ratio carries over.
 */
export const FLOOR_BPS = 700n;

/**
 * Seconds from a halt's start to its verdict landing on the hook. IMD's oracle has answered
 * recent requests in a median of about 90 s from request to attestation; filing adds a few blocks.
 */
export const VERDICT_LATENCY = 90;

export const LOOKBACK_DAYS = 30;

export const RPC_URL = robinhood.rpcUrls.default.http[0];
export const FACTORY = ADDRESSES.launchFactory.toLowerCase() as Address;
export const POOL_MANAGER = ADDRESSES.poolManager.toLowerCase() as Address;
export const IMD = ADDRESSES.imd.toLowerCase() as Address;
export const ETH: Address = "0x0000000000000000000000000000000000000000";

/** eth_getLogs accepts at most this many blocks per call when each topic position holds one value. */
export const MAX_LOG_SPAN = 10_000_000;
