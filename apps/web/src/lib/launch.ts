import { isAddress } from "viem";
import { formatSig } from "./format";
import { tickPercent } from "./price";

/** The hook's constructor literals, in declaration order after the four addresses. */
export interface LaunchParams {
  bandTicks: number;
  edgeTicks: number;
  refWindow: number;
  limitSeconds: number;
  haltSeconds: number;
  cooldownSeconds: number;
  minLiquidityE18: number;
}

export const CURB_PARAMS: LaunchParams = {
  bandTicks: 1000,
  edgeTicks: 100,
  refWindow: 300,
  limitSeconds: 15,
  haltSeconds: 900,
  cooldownSeconds: 1800,
  minLiquidityE18: 100000,
};

export interface LaunchInput {
  name: string;
  symbol: string;
  /** The hook's owner: the contract allowed to resolve its halts, usually a CurbDesk. */
  owner: string;
  repoUrl: string;
  baseCommit: string;
  poolBps: number;
  remainderTo: string;
  params: LaunchParams;
}

export const IMD_TOKEN = "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127";
export const IMD_CHECK_URL = "https://api.imd.fun/requests/check";
export const IMD_IMPORT_URL = "https://api.imd.fun/requests/import";
const INITIAL_PRICE = "79228162514264337593543950336";
const UINT32_MAX = 4_294_967_295;

export type LaunchErrors = Partial<Record<keyof LaunchInput | keyof LaunchParams, string>>;

const isUint = (n: number, max: number) => Number.isInteger(n) && n > 0 && n <= max;

/** The constructor's BadParams checks and the request's own, as messages per field. */
export function validateLaunch(input: LaunchInput): LaunchErrors {
  const e: LaunchErrors = {};
  const p = input.params;
  if (!input.name.trim()) e.name = "Give the token a name.";
  else if (input.name.length > 64) e.name = "Keep the name under 64 characters.";
  if (!/^[A-Z0-9]{1,11}$/.test(input.symbol)) e.symbol = "Use 1–11 capital letters or digits.";
  if (!isAddress(input.owner)) e.owner = "Enter the owner's 0x address.";
  if (!isAddress(input.remainderTo)) e.remainderTo = "Enter a 0x address for the fee remainder.";
  if (!/^https:\/\/\S+$/.test(input.repoUrl)) e.repoUrl = "Use the repository's https URL.";
  if (!/^[0-9a-f]{40}$/.test(input.baseCommit)) e.baseCommit = "Use the full 40-character commit hash.";
  if (!Number.isInteger(input.poolBps) || input.poolBps < 0 || input.poolBps > 10_000) {
    e.poolBps = "Basis points from 0 to 10,000.";
  }
  if (!isUint(p.edgeTicks, 20_000)) e.edgeTicks = "A whole number of ticks above zero.";
  if (!isUint(p.bandTicks, 20_000)) e.bandTicks = "A whole number of ticks from 1 to 20,000.";
  else if (!e.edgeTicks && p.bandTicks - p.edgeTicks < 2) e.bandTicks = "The band must be at least 2 ticks wider than the edge zone.";
  for (const k of ["refWindow", "limitSeconds", "haltSeconds", "cooldownSeconds", "minLiquidityE18"] as const) {
    if (!isUint(p[k], UINT32_MAX)) e[k] = "A whole number above zero.";
  }
  return e;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** 300 -> "5 minutes", 15 -> "15 seconds", 3600 -> "1 hour". */
export function durationWords(seconds: number): string {
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

/** 300 -> "5-minute": the same span used as an adjective. */
export function durationAdjective(seconds: number): string {
  return durationWords(seconds).replace(/s$/, "").replace(" ", "-");
}

/** The constructor literals as IMD's manifest takes them: decimal strings, with arbBlocks as "1". */
function constructorArgs(p: LaunchParams): string[] {
  return [
    "$poolManager",
    "$token",
    "$factory",
    "$owner",
    ...[p.bandTicks, p.edgeTicks, p.refWindow, p.limitSeconds, p.haltSeconds, p.cooldownSeconds, p.minLiquidityE18].map(String),
    "1",
  ];
}

/** minLiquidityE18 in plain liquidity units: 100000 -> "1e23". */
export function liquidityFloor(minLiquidityE18: number): string {
  const exp = Math.log10(minLiquidityE18);
  return Number.isInteger(exp) ? `1e${18 + exp}` : `${minLiquidityE18}e18`;
}

function behaviour(p: LaunchParams): string {
  return (
    `It refuses a swap that would end outside a ${p.bandTicks}-tick band around a ` +
    `${durationAdjective(p.refWindow)} time-weighted reference and further from it (a swap toward the ` +
    `reference always passes), and halts the pool both ways for at most ${durationWords(p.haltSeconds)} ` +
    `when the price holds at the band edge for ${durationWords(p.limitSeconds)}; the owner can only ` +
    `shorten a halt or pin the pre-move reference through the cooldown, never lengthen a halt or move funds.`
  );
}

/** The `objective` IMD's swarm works from, in the shape of the one the CURB launch was paid with. */
export function buildObjective(input: LaunchInput): string {
  const p = input.params;
  return (
    `Launch ${input.name} (${input.symbol}) with the Uniswap v4 hook in src/CurbHook.sol from this repository ` +
    `with no changes to the production source unless an audit finding requires one; launch.json in the ` +
    `repository root is the manifest. Token: src/CurbToken.sol, name ${input.name}, symbol ${input.symbol}, ` +
    `18 decimals, fixed 1,000,000,000 supply minted once to its deployer, no constructor arguments, no owner, ` +
    `mint, burn, tax or pause. Hook: src/CurbHook.sol (OpenZeppelin uniswap-hooks v1.3.0-rc.0 BaseHook), ` +
    `constructor arguments in order: $poolManager; $token; $factory (the only address allowed to initialize ` +
    `the pool); $owner (the contract that resolves halts); then the literals ${p.bandTicks}, ${p.edgeTicks}, ` +
    `${p.refWindow}, ${p.limitSeconds}, ${p.haltSeconds}, ${p.cooldownSeconds}, ${p.minLiquidityE18}, true ` +
    `(bandTicks, edgeTicks, refWindow seconds, limitSeconds, haltSeconds, cooldownSeconds, minLiquidityE18, ` +
    `arbBlocks). Permissions beforeInitialize, beforeSwap, afterSwap (flags 0x20C0), CREATE2-mined. Pool fee ` +
    `12500 static, tick spacing 60, paired with IMD. Only the launch factory may initialize the pool, once. ` +
    `The hook takes no fee of its own, returns no deltas and has no liquidity callbacks, so adding, removing ` +
    `and the factory's zero-liquidity fee collect are untouched. ${behaviour(p)} Tests: forge test passes ` +
    `offline; IMD's univ4_hook protected suites pass via script/protected.sh.`
  );
}

/** A `launch.json` in the shape of the repository's own. */
export function buildManifest(input: LaunchInput) {
  const p = input.params;
  return {
    kind: "univ4_hook",
    hook: {
      contract: "CurbHook",
      constructorArgs: constructorArgs(p),
      permissions: ["beforeInitialize", "beforeSwap", "afterSwap"],
    },
    token: { contract: "CurbToken", name: input.name, symbol: input.symbol, decimals: 18 },
    pool: { pairedCurrency: IMD_TOKEN, fee: 12500, tickSpacing: 60, initialPrice: INITIAL_PRICE },
    notes:
      `CurbToken is src/CurbToken.sol: ${input.name} (${input.symbol}), 18 decimals, no constructor arguments. Its ` +
      `constructor mints the fixed 1,000,000,000-token supply once to its deployer; it exposes no owner, further ` +
      `mint, burn, tax or pause. CurbHook is src/CurbHook.sol, using the vendored OpenZeppelin uniswap-hooks ` +
      `BaseHook. Constructor arguments follow the declaration: poolManager_, token_, initializer_, owner_, ` +
      `bandTicks, edgeTicks, refWindow, limitSeconds, haltSeconds, cooldownSeconds, minLiquidityE18, arbBlocks. ` +
      `The seven numeric settings are ${p.bandTicks}, ${p.edgeTicks}, ${p.refWindow}, ${p.limitSeconds}, ` +
      `${p.haltSeconds}, ${p.cooldownSeconds} and ${p.minLiquidityE18}; durations are seconds and minLiquidityE18 ` +
      `scales to ${liquidityFloor(p.minLiquidityE18)} in-range liquidity. arbBlocks is true. Deploy with CREATE2 ` +
      `mining for flags 0x20C0, exactly beforeInitialize, beforeSwap and afterSwap. BaseHook restricts all ` +
      `callbacks to the PoolManager. Initialization is allowed once, only with sender $factory, a key containing ` +
      `$token, static fee 12500 and tick spacing 60. This manifest selects ${input.symbol}/IMD on Robinhood Chain. ` +
      `The hook takes no additional fee, returns zero deltas and enables no liquidity or donation callbacks; ` +
      `adding, removing and the factory's zero-liquidity fee collect are untouched. The pool charges the ` +
      `specified 1.25% LP fee. Outside a halt, the band check rejects a swap ending more than ${p.bandTicks} ticks ` +
      `from the time-weighted reference and farther from it than the starting tick; moves toward the reference ` +
      `pass that check. The ${p.refWindow}-second reference window rolls lazily on swaps, with clamping to keep ` +
      `the current tick out of the edge zone. Remaining in the ${p.edgeTicks}-tick edge zone for ` +
      `${p.limitSeconds} seconds triggers a halt in both directions for at most ${p.haltSeconds} seconds, followed ` +
      `by a ${p.cooldownSeconds}-second cooldown measured from the scheduled halt end. When in-range liquidity is ` +
      `below the floor, the hook does not start the edge clock or roll the reference. A swap starting below that ` +
      `floor may be admitted within ${p.bandTicks} ticks of the first qualifying liquidity boundary it crosses, ` +
      `reanchoring the reference. The immutable owner is $owner. Its sole hook authority, resolve(nonce, verdict), ` +
      `may end an active halt early or pin the pre-move reference through cooldown, with clamping on reopen; it ` +
      `cannot extend a halt, change parameters, transfer ownership or move funds. Trade events and totalVolume ` +
      `record paired-currency volume; ArbSys supplies L2 block numbers with a bounded call and block.number ` +
      `fallback. pool.initialPrice is the required one-to-one sqrtPriceX96; deployment derives the actual opening ` +
      `price from the separate launch policy and token ordering.`,
  };
}

/** The `launch.open` request body, field for field the shape the desk paid for. */
export function buildRequestBody(input: LaunchInput) {
  return {
    objective: buildObjective(input),
    repoUrl: input.repoUrl,
    baseCommit: input.baseCommit,
    references: ["uniswap-v4-hooks", "uniswap-v4-security", "oracle-consumer"],
    onchain: "univ4_hook",
    chainId: 4663,
    pairWith: "imd",
    owner: input.owner.toLowerCase(),
    economics: { poolBps: input.poolBps, remainderTo: input.remainderTo.toLowerCase() },
    github: true,
    shape: "chain",
    steps: [{ skill: "audit-imported-code" }],
  };
}

export function checkPayload(body: ReturnType<typeof buildRequestBody>) {
  return { action: "launch.open", input: body };
}

/** A string as one single-quoted shell word. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function curlCheck(body: ReturnType<typeof buildRequestBody>): string {
  return (
    `curl -s ${IMD_CHECK_URL} \\\n  -H 'content-type: application/json' \\\n  -d ` +
    shellQuote(JSON.stringify(checkPayload(body)))
  );
}

/** IMD resolves a bare repository URL to its default branch, so the import names the commit. */
export function importTarget(repoUrl: string, commit: string): string {
  return `${repoUrl.replace(/\.git$/, "")}/tree/${commit}`;
}

/** IMD's import of the exact commit the body names; its baseCommit must come back equal. */
export function curlImport(repoUrl: string, commit: string): string {
  return (
    `curl -s ${IMD_IMPORT_URL} \\\n  -H 'content-type: application/json' \\\n  -d ` +
    shellQuote(JSON.stringify({ url: importTarget(repoUrl, commit), kind: "contracts" }))
  );
}

/** One line per parameter, in words, for the wizard's summary. */
export function describeParams(p: LaunchParams): { label: string; value: string }[] {
  return [
    { label: "Band", value: `±${formatSig(tickPercent(p.bandTicks), 3)}% around the reference` },
    { label: "Edge zone", value: `the outer ${formatSig(tickPercent(p.edgeTicks), 2)}% of each side` },
    { label: "Reference", value: `${durationAdjective(p.refWindow)} time-weighted average` },
    { label: "Halt", value: `after ${durationWords(p.limitSeconds)} at the edge, for at most ${durationWords(p.haltSeconds)}` },
    { label: "Cooldown", value: `${durationWords(p.cooldownSeconds)} before the next halt can start` },
    { label: "No-market floor", value: `${liquidityFloor(p.minLiquidityE18)} in-range liquidity` },
  ];
}
