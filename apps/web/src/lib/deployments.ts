import type { Address, Hex } from "viem";
import { deployments as generated } from "@curb/sdk";
import file from "../../../../deployments/4663.json";

export type DrillProof = "outsideBand" | "limitEntered" | "halted" | "treasuryShort" | "haltClosed";

export interface Deployments {
  desk: Address;
  router: Address;
  steward: Address;
  drill: { drillHook: Address; drillToken: Address };
  launch?: {
    payment?: Hex;
    requestId?: Hex;
    job?: string;
    baseCommit?: string;
    hook?: Address;
    token?: Address;
    block?: number;
  };
  proofs?: { drill?: Partial<Record<DrillProof, Hex>> };
}

// The SDK's copy is generated from deployments/4663.json; reading the file as well keeps the site
// right when the generated copy lags behind a deployment.
export const deployments = { ...generated, ...file } as unknown as Deployments;

export const REPO_URL = "https://github.com/RaYYeR220/curb";
export const IMD_JOB_URL = (job: string) => `https://api.imd.fun/jobs/${job}`;

/** Log scans start just before the desk's first event (L2 block 92,855,497) and the drill pool's opening (92,857,518). */
export const DESK_FROM_BLOCK = 92_855_000n;
export const DRILL_FROM_BLOCK = 92_857_000n;

export interface PoolDef {
  key: "drill" | "launch";
  title: string;
  /** What the pool is for, in a few words. */
  role: string;
  hook?: Address;
  fromBlock: bigint;
  tokenSymbol: string;
  pairedSymbol: string;
}

const launchHook = deployments.launch?.hook;

export const POOLS: PoolDef[] = [
  {
    key: "drill",
    title: "DRILL / ETH",
    role: "The drill pool",
    hook: deployments.drill.drillHook,
    fromBlock: DRILL_FROM_BLOCK,
    tokenSymbol: "DRILL",
    pairedSymbol: "ETH",
  },
  {
    key: "launch",
    title: "CURB / IMD",
    role: "The launch pool",
    hook: launchHook,
    fromBlock: deployments.launch?.block !== undefined ? BigInt(deployments.launch.block) : DESK_FROM_BLOCK,
    tokenSymbol: "CURB",
    pairedSymbol: "IMD",
  },
];

export const livePools = () => POOLS.filter((p): p is PoolDef & { hook: Address } => Boolean(p.hook));

/** The drill, step by step: each one a mainnet transaction anyone can open. */
export const DRILL_STEPS: { key: DrillProof; title: string; outcome: "refused" | "passed"; body: string }[] = [
  {
    key: "outsideBand",
    title: "A buy through the band",
    outcome: "refused",
    body: "0.0001 ETH with no price limit would have carried DRILL far past the band. Mined as a failed transaction: OutsideBand, with the reference, where the swap would have ended and the limit it crossed.",
  },
  {
    key: "limitEntered",
    title: "A buy into the edge zone",
    outcome: "passed",
    body: "The same buy, stopped 270 ticks from the reference: inside the band, inside its edge zone. It passes and the pool enters the limit state.",
  },
  {
    key: "halted",
    title: "A swap after ten seconds at the edge",
    outcome: "refused",
    body: "The price held at the edge, so the pool halted in both directions. Even a tiny swap is refused with Halted, naming when trading reopens.",
  },
  {
    key: "treasuryShort",
    title: "The desk asked for a verdict",
    outcome: "refused",
    body: "fileIncident would pay the IMD oracle to say whether one trader drove the move. The desk held no IMD, so it reverted with TreasuryShort and the default applied.",
  },
  {
    key: "haltClosed",
    title: "The first swap after the halt",
    outcome: "passed",
    body: "With no verdict the halt ran its full five minutes. The next swap passed, closed the incident and started the cooldown.",
  },
];
