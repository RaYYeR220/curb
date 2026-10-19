import { ADDRESSES } from "@curb/sdk";
import { getAddress, isAddress, toHex } from "viem";
import type { Context } from "../context";
import { duration } from "../format";
import { checkLaunch, importRepo, type CheckResult, type ImportResult } from "../imd";
import { ACTIONS, CHAIN_ID } from "../known";

export interface HookParams {
  bandTicks: number;
  edgeTicks: number;
  refWindow: number;
  limitSeconds: number;
  haltSeconds: number;
  cooldownSeconds: number;
  minLiquidityE18: number;
}

export interface ManifestInput {
  name: string;
  symbol: string;
  owner: string;
  params?: Partial<HookParams>;
  repoUrl?: string;
  baseCommit?: string;
  check?: boolean;
}

/** CURB/IMD's settings, from the repository's launch.json. */
export const DEFAULT_PARAMS: HookParams = {
  bandTicks: 1000,
  edgeTicks: 100,
  refWindow: 300,
  limitSeconds: 15,
  haltSeconds: 900,
  cooldownSeconds: 1800,
  minLiquidityE18: 100000,
};

export const UPSTREAM_REPO = "https://github.com/RaYYeR220/curb";
const SUPPLY = "1,000,000,000";
const PERMISSIONS = ["beforeInitialize", "beforeSwap", "afterSwap"];
const REFERENCES = ["uniswap-v4-hooks", "uniswap-v4-security", "oracle-consumer"];
const UINT32_MAX = 2 ** 32 - 1;

/** The same checks CurbHook's constructor makes, so a bad set fails here rather than at deployment. */
export function validateParams(p: HookParams): string[] {
  const problems: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (!Number.isInteger(v) || v <= 0) problems.push(`${k} must be a positive integer`);
  }
  if (p.bandTicks - p.edgeTicks < 2) problems.push("bandTicks must exceed edgeTicks by at least 2");
  if (p.bandTicks > 20_000) problems.push("bandTicks must be at most 20000");
  for (const k of ["refWindow", "limitSeconds", "haltSeconds", "cooldownSeconds", "minLiquidityE18"] as const) {
    if (p[k] > UINT32_MAX) problems.push(`${k} must fit in uint32`);
  }
  return problems;
}

const adjective = (s: number) => duration(s).replace(/ (\w+?)s?$/, "-$1");

export function buildManifest(name: string, symbol: string, p: HookParams) {
  const minLiq =
    p.minLiquidityE18 === DEFAULT_PARAMS.minLiquidityE18
      ? "i.e. a minimum in-range liquidity of 1e23 (about 7% of the liquidity the factory seeds at poolBps 9000; below it a range counts as having no market)"
      : `i.e. a minimum in-range liquidity of ${p.minLiquidityE18}e18 (below it a range counts as having no market)`;
  const notes =
    `CurbToken (src/CurbToken.sol) is a fixed-supply ERC-20: name ${name}, symbol ${symbol}, 18 decimals, ${SUPPLY} tokens ` +
    `minted once to its deployer in the constructor, no constructor arguments, no owner, mint, burn, tax or pause. ` +
    `CurbHook (src/CurbHook.sol) brings exchange-style Limit Up-Limit Down circuit breakers to its pool. Constructor, in ` +
    `declaration order: IPoolManager poolManager_ ($poolManager), address token_ ($token), address initializer_ ($factory), ` +
    `address owner_ ($owner), int24 bandTicks ${p.bandTicks}, int24 edgeTicks ${p.edgeTicks}, uint32 refWindow ${p.refWindow}, ` +
    `uint32 limitSeconds ${p.limitSeconds}, uint32 haltSeconds ${p.haltSeconds}, uint32 cooldownSeconds ${p.cooldownSeconds}, ` +
    `uint32 minLiquidityE18 ${p.minLiquidityE18}, ${minLiq}, bool arbBlocks true. ` +
    `The constructor makes no external calls and rejects zero addresses and inconsistent parameters; BaseHook (OpenZeppelin ` +
    `uniswap-hooks v1.3.0-rc.0) validates the address against getHookPermissions, so it must be CREATE2-mined to flags 0x20C0: ` +
    `beforeInitialize, beforeSwap, afterSwap. No return deltas, no liquidity or donate callbacks, no fee: adding, removing and ` +
    `the factory's zero-liquidity fee collect are untouched. beforeInitialize accepts exactly one pool: sender must be the launch ` +
    `factory ($factory), the key must hold ${symbol}, key.fee must be 12500 (static) and key.tickSpacing 60; a second ` +
    `initialisation reverts. Behaviour: a swap that would end more than ${p.bandTicks} ticks from a ${adjective(p.refWindow)} ` +
    `time-weighted reference, further from the reference than it started, reverts OutsideBand(ref, tickAfter, limit, zeroForOne); ` +
    `a swap toward the reference always passes and the price is always inside the band. A price held within ${p.edgeTicks} ticks ` +
    `of the band edge for ${p.limitSeconds} seconds halts the pool in both directions for at most ${p.haltSeconds} seconds ` +
    `(Halted(nonce, reopensAt)), derived from stored state and the clock with no keeper, then a ${p.cooldownSeconds}-second ` +
    `cooldown spaces the next halt. Where in-range liquidity is below minLiquidity the price never starts the limit clock, never ` +
    `rolls the reference and never becomes the reference when a halt closes; a swap that starts there and crosses into liquidity ` +
    `is judged from the first initialised tick carrying at least minLiquidity, so a reference left in an empty range cannot shut ` +
    `buyers out. The owner ($owner) has one power, resolve(nonce, verdict): end the current halt now or pin the pre-move ` +
    `reference through the cooldown; it cannot lengthen a halt, change a parameter or move funds, and ownership cannot be ` +
    `transferred. Each successful swap emits Trade(tx.origin, |paired-currency delta|) and adds it to totalVolume. The L2 block ` +
    `number comes from ArbSys (address 100) with a fallback to block.number where it is absent; the read forwards at most 20,000 gas.`;
  return {
    kind: "univ4_hook",
    hook: {
      contract: "CurbHook",
      permissions: PERMISSIONS,
      // Literals in the form IMD's manifest step writes them: decimal strings, and "1" for true.
      constructorArgs: [
        "$poolManager",
        "$token",
        "$factory",
        "$owner",
        ...[p.bandTicks, p.edgeTicks, p.refWindow, p.limitSeconds, p.haltSeconds, p.cooldownSeconds, p.minLiquidityE18].map(String),
        "1",
      ],
    },
    token: { contract: "CurbToken", name, symbol, decimals: 18 },
    pool: {
      pairedCurrency: ADDRESSES.imd.toLowerCase(),
      fee: 12500,
      tickSpacing: 60,
      initialPrice: "79228162514264337593543950336",
    },
    notes,
  };
}

export function buildObjective(name: string, symbol: string, p: HookParams): string {
  const literals = [p.bandTicks, p.edgeTicks, p.refWindow, p.limitSeconds, p.haltSeconds, p.cooldownSeconds, p.minLiquidityE18, true];
  return (
    `Launch ${name} (${symbol}) with the Uniswap v4 hook in src/CurbHook.sol from this repository with no changes to the ` +
    `production source unless an audit finding requires one; launch.json in the repository root is the manifest. Token: ` +
    `src/CurbToken.sol, name ${name}, symbol ${symbol}, 18 decimals, fixed ${SUPPLY} supply minted once to its deployer, no ` +
    `constructor arguments, no owner, mint, burn, tax or pause. Hook: src/CurbHook.sol (OpenZeppelin uniswap-hooks ` +
    `v1.3.0-rc.0 BaseHook), constructor arguments in order: $poolManager; $token; $factory (the only address allowed to ` +
    `initialize the pool); $owner (the hook's owner, whose one power is resolve); then the literals ${literals.join(", ")} ` +
    `(bandTicks, edgeTicks, refWindow seconds, limitSeconds, haltSeconds, cooldownSeconds, minLiquidityE18, arbBlocks). ` +
    `Permissions beforeInitialize, beforeSwap, afterSwap (flags 0x20C0), CREATE2-mined. Pool fee 12500 static, tick spacing ` +
    `60, paired with IMD. Only the launch factory may initialize the pool, once. The hook takes no fee of its own, returns no ` +
    `deltas and has no liquidity callbacks, so adding, removing and the factory's zero-liquidity fee collect are untouched. It ` +
    `refuses a swap that would end outside a ${p.bandTicks}-tick band around a ${adjective(p.refWindow)} time-weighted ` +
    `reference and further from it (a swap toward the reference always passes), and halts the pool both ways for at most ` +
    `${duration(p.haltSeconds)} when the price holds at the band edge for ${duration(p.limitSeconds)}; the owner can only ` +
    `shorten a halt or pin the pre-move reference through the cooldown, never lengthen a halt or move funds. Tests: forge test ` +
    `runs offline; IMD's univ4_hook protected suites run via script/protected.sh.`
  );
}

export function launchBody(o: {
  name: string;
  symbol: string;
  owner: string;
  params: HookParams;
  repoUrl?: string;
  baseCommit?: string;
}) {
  const owner = o.owner.toLowerCase();
  return {
    objective: buildObjective(o.name, o.symbol, o.params),
    ...(o.repoUrl ? { repoUrl: o.repoUrl } : {}),
    ...(o.baseCommit ? { baseCommit: o.baseCommit } : {}),
    references: REFERENCES,
    onchain: "univ4_hook",
    chainId: CHAIN_ID,
    pairWith: "imd",
    owner,
    economics: { poolBps: 9000, remainderTo: owner },
    github: true,
    shape: "chain",
    steps: [{ skill: "audit-imported-code" }],
  };
}

/** https://github.com/o/r, with any .git suffix or trailing slash dropped. */
export function normalizeRepo(url: string): string {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) throw new Error(`repoUrl must look like https://github.com/<owner>/<repo>, got "${url}".`);
  return `https://github.com/${m[1]}/${m[2]}`;
}

export async function curbLaunchManifest(ctx: Context, input: ManifestInput) {
  if (!isAddress(input.owner, { strict: false })) throw new Error(`owner "${input.owner}" is not an address.`);
  if (/^0x0{40}$/i.test(input.owner)) throw new Error("owner cannot be the zero address.");
  if (input.baseCommit && !/^[0-9a-f]{40}$/.test(input.baseCommit)) throw new Error("baseCommit must be a 40-character lowercase hex commit.");
  const params: HookParams = { ...DEFAULT_PARAMS, ...stripUndefined(input.params ?? {}) };
  const problems = validateParams(params);
  if (problems.length) throw new Error(`params rejected: ${problems.join("; ")}.`);

  let repoUrl = input.repoUrl ? normalizeRepo(input.repoUrl) : undefined;
  let baseCommit = input.baseCommit;
  let imported: ImportResult | undefined;
  let check: CheckResult | undefined;

  if (input.check) {
    if (!repoUrl) throw new Error("check needs repoUrl: the body launches code from a public GitHub repository.");
    imported = await importRepo(ctx, baseCommit ? `${repoUrl}/commit/${baseCommit}` : repoUrl);
    if (imported.ok && imported.source?.baseCommit) {
      baseCommit = imported.source.baseCommit;
      if (imported.source.repoUrl) repoUrl = imported.source.repoUrl;
    }
  }

  const manifest = buildManifest(input.name, input.symbol, params);
  const body = launchBody({ name: input.name, symbol: input.symbol, owner: input.owner, params, repoUrl, baseCommit });

  if (input.check && imported?.ok) check = await checkLaunch(ctx, body);

  const missing = [!repoUrl && "repoUrl", !baseCommit && "baseCommit"].filter(Boolean) as string[];
  const bodyJson = JSON.stringify(body);
  const owner = getAddress(input.owner);
  const ready = missing.length === 0 && (check ? check.blockers.length === 0 : false);

  let summary: string;
  if (imported && !imported.ok) summary = "IMD could not import the repository; see import.problems. Nothing was checked.";
  else if (check && check.blockers.length === 0) summary = "The free check returned no blockers: this body can be paid as it stands.";
  else if (check) summary = `The free check returned ${check.blockers.length} blocker(s); fix them before paying.`;
  else if (missing.length) summary = `Manifest and body built. Missing for a payable body: ${missing.join(", ")}.`;
  else summary = "Manifest and body built. Run with check: true for IMD's free check before paying.";

  return {
    summary,
    readyToPay: ready,
    missing,
    manifest,
    body,
    ...(imported ? { import: imported } : {}),
    ...(check
      ? {
          check: {
            blockers: check.blockers,
            suggestions: check.suggestions,
            plan: (check.plan ?? []).map((s) => (s && typeof s === "object" && "title" in s ? (s as { title: string }).title : s)),
            facts: check.facts,
            kind: check.kind,
          },
        }
      : {}),
    payment: {
      intake: ADDRESSES.intake,
      action: "launch.open@launch-1",
      actionId: ACTIONS.launchOpen,
      asset: ADDRESSES.imd,
      price: "500000000000000000",
      priceNote: "0.5 IMD today; read Intake.priceOf(actionId, IMD) before paying. Nothing is refunded once paid.",
      bodyHex: toHex(bodyJson),
      bodyBytes: new TextEncoder().encode(bodyJson).length,
    },
    nextSteps: [
      `Fork ${UPSTREAM_REPO}. In src/CurbToken.sol set ERC20("${input.name}", "${input.symbol}"), replace launch.json with the manifest above, then run forge test and bash script/protected.sh. IMD's verifier compiles every contract in the pinned tree and parks the launch if any of them reads as containing DELEGATECALL, launched or not.`,
      "Commit and push to a public GitHub repository, then call this tool again with repoUrl (and baseCommit, or check: true to resolve it with POST https://api.imd.fun/requests/import).",
      "Pay only when the free check (POST https://api.imd.fun/requests/check, action launch.open) returns no blockers.",
      `Pay from a wallet: IMD.approve(${ADDRESSES.intake}, price), then Intake.request(actionId, bodyHex, (0x0000000000000000000000000000000000000000, 0x00000000), ${ADDRESSES.imd}, price). The payer is the launch's requester and receives its LP fee share.`,
      `Or pay from a CurbDesk you deploy with yourself as steward: fund it with IMD and call launch(bodyHex); the desk is then payer and requester, and its fee share pays for incident questions. Bind the pool with bind(launchNumber) once it is live. Name the desk as owner so its verdicts can resolve halts; this body names ${owner}.`,
      "Track the launch: GET https://api.imd.fun/intake/4663/<payment transaction hash>.",
    ],
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
