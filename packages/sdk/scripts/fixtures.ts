// Writes test/fixtures/breaker-trace-<n>.hex: seeded random walks through the TypeScript Breaker,
// each step ABI-encoded with what the model did, for test/differential/BreakerDiff.t.sol to replay
// against the Solidity library. Run from the repository root:
//   pnpm --dir apps/cli exec tsx ../../packages/sdk/scripts/fixtures.ts
import { writeFileSync } from "node:fs";
import { encodeAbiParameters } from "viem";
import { Breaker, BreakerRevert, Verdict, type Config } from "../src/model";

const config: Config = { band: 1000, edge: 100, refWindow: 300, limitSeconds: 15, haltSeconds: 900, cooldownSeconds: 1800 };
const STEPS = 400;

// mulberry32: small, seedable, good enough to spread steps around.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REVERTS: Record<string, number> = { OutsideBand: 1, Halted: 2 };

const stepType = {
  type: "tuple[]",
  components: [
    { name: "op", type: "uint8" },
    { name: "now", type: "uint64" },
    { name: "tickAfter", type: "int24" },
    { name: "liquidBefore", type: "bool" },
    { name: "liquidAfter", type: "bool" },
    { name: "crossed", type: "bool" },
    { name: "boundary", type: "int24" },
    { name: "verdict", type: "uint8" },
    { name: "expectRevert", type: "uint8" },
    { name: "ref", type: "int24" },
    { name: "lastTick", type: "int24" },
    { name: "nonce", type: "uint32" },
    { name: "edgeSince", type: "uint64" },
    { name: "cooldownEnd", type: "uint64" },
    { name: "pinUntil", type: "uint64" },
    { name: "phase", type: "uint8" },
  ],
} as const;

function trace(seed: number) {
  const r = rng(seed);
  let now = 1000;
  const b = new Breaker(config, 0, now);
  const steps = [];
  for (let i = 0; i < STEPS; i++) {
    now += r() < 0.3 ? Math.floor(r() * 1200) : Math.floor(r() * 30);
    const halted = b.phase(now) === 2;
    let op = 0;
    let tickAfter = 0;
    let liquidBefore = r() < 0.85;
    let liquidAfter = r() < 0.85;
    let crossed = false;
    let boundary = 0;
    let verdict = Verdict.None;
    let expectRevert = 0;
    if (halted && r() < 0.5) {
      op = 1;
      verdict = r() < 0.5 ? Verdict.Organic : Verdict.Concentrated;
      try {
        b.resolve(now, b.state.nonce, verdict);
      } catch {
        expectRevert = 3;
      }
    } else {
      const ref = b.state.ref;
      const pressEdge = r() < 0.3;
      const offset = pressEdge
        ? (r() < 0.5 ? 1 : -1) * (config.band - Math.floor(r() * config.edge))
        : Math.floor((r() * 3 - 1.5) * config.band);
      tickAfter = Math.max(-887271, Math.min(887271, ref + offset));
      if (!liquidBefore && r() < 0.5) {
        crossed = true;
        boundary = tickAfter + Math.floor((r() * 2 - 1) * config.band * 1.2);
      }
      try {
        b.swapFull(now, tickAfter, liquidBefore, liquidAfter, crossed ? boundary : undefined);
      } catch (e) {
        expectRevert = e instanceof BreakerRevert ? (REVERTS[e.errorName] ?? 9) : 9;
      }
    }
    const s = b.state;
    steps.push({
      op,
      now: BigInt(now),
      tickAfter,
      liquidBefore,
      liquidAfter,
      crossed,
      boundary,
      verdict,
      expectRevert,
      ref: s.ref,
      lastTick: s.lastTick,
      nonce: s.nonce,
      edgeSince: BigInt(s.edgeSince),
      cooldownEnd: BigInt(s.cooldownEnd),
      pinUntil: BigInt(s.pinUntil),
      phase: b.phase(now),
    });
  }
  return steps;
}

const root = new URL("../../../", import.meta.url);
for (let n = 1; n <= 5; n++) {
  const steps = trace(0xc0b + n);
  const reverts = steps.filter((s) => s.expectRevert !== 0).length;
  const halts = new Set(steps.filter((s) => s.phase === 2).map((s) => s.nonce)).size;
  writeFileSync(new URL(`test/fixtures/breaker-trace-${n}.hex`, root), encodeAbiParameters([stepType], [steps]));
  console.log(`trace ${n}: ${steps.length} steps, ${reverts} reverts, ${halts} halts, final nonce ${steps.at(-1)!.nonce}`);
}
