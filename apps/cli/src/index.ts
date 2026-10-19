#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { createWalletClient, http, parseUnits, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ADDRESSES,
  Phase,
  curbClient,
  curbDeskAbi,
  deployments,
  previewSwap,
  readPoolKey,
  readStatus,
  robinhood,
} from "@curb/sdk";
import { formatPreview, formatStatus } from "./format";
import { healthGate } from "./gate";
import { Imd, importUrl } from "./imd";
import { attestationTuple, decide, type PoolView } from "./keeper";

const ORACLE_REQUEST = stringToHex("oracle.request@oracle-1", { size: 32 });
const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const intakeAbi = [
  { type: "function", name: "priceOf", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const factoryAbi = [
  { type: "function", name: "claimFees", stateMutability: "nonpayable", inputs: [{ type: "uint64" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
] as const;

const program = new Command().name("curb").description("Curb: circuit breakers for Uniswap v4 pools on Robinhood Chain");
program.option("--rpc <url>", "Robinhood Chain RPC", process.env.RH_RPC);

const client = (): PublicClient => curbClient(program.opts().rpc);
const imd = new Imd();
const desk = deployments.desk as Address;

function wallet() {
  const key = process.env.DEPLOYER_KEY as Hex | undefined;
  if (!key) throw new Error("set DEPLOYER_KEY to send transactions");
  return createWalletClient({ account: privateKeyToAccount(key), chain: robinhood, transport: http(program.opts().rpc) });
}

/** Every bound pool: the drill now, the CURB/IMD launch pool once it is bound. */
function pools(): { hook: Address; kind: "launch" | "drill" }[] {
  const out: { hook: Address; kind: "launch" | "drill" }[] = [];
  const launch = (deployments as { launch?: { hook?: string } }).launch;
  if (launch?.hook) out.push({ hook: launch.hook as Address, kind: "launch" });
  out.push({ hook: deployments.drill.drillHook as Address, kind: "drill" });
  return out;
}

program
  .command("health")
  .description("IMD's processor for Robinhood Chain: is it safe to pay?")
  .action(async () => {
    const gate = healthGate(await imd.health());
    console.log(gate.ok ? "green: IMD is reading Robinhood Chain" : `red: ${gate.reasons.join("; ")}`);
    process.exitCode = gate.ok ? 0 : 1;
  });

program
  .command("check <body>")
  .description("free check of a launch.open body (JSON file)")
  .action(async (file: string) => {
    const res = await imd.check("launch.open", JSON.parse(readFileSync(file, "utf8")));
    console.log(JSON.stringify({ blockers: res.blockers, plan: res.plan?.map((p) => p.title), error: res.error }, null, 2));
    process.exitCode = res.blockers && res.blockers.length === 0 ? 0 : 1;
  });

program
  .command("import <repo>")
  .description("free import check of a public GitHub repository")
  .action(async (repo: string) => {
    const res = await imd.importRepo(repo);
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.ok ? 0 : 1;
  });

program
  .command("launch <body>")
  .description("pay IMD's launch.open through the desk, after the health gate, the free check and the import")
  .action(async (file: string) => {
    const body = JSON.parse(readFileSync(file, "utf8"));
    const gate = healthGate(await imd.health());
    if (!gate.ok) throw new Error(`not paying: ${gate.reasons.join("; ")}`);
    const check = await imd.check("launch.open", body);
    if (!check.blockers || check.blockers.length > 0) throw new Error(`not paying: ${JSON.stringify(check.blockers ?? check)}`);
    const imported = await imd.importRepo(importUrl(body.repoUrl, body.baseCommit));
    if (!imported.ok || imported.source?.baseCommit !== body.baseCommit) throw new Error(`not paying: import ${JSON.stringify(imported)}`);
    const hash = await wallet().writeContract({
      address: desk,
      abi: curbDeskAbi,
      functionName: "launch",
      args: [stringToHex(JSON.stringify(body))],
    });
    console.log(`launch.open paid: ${robinhood.blockExplorers.default.url}/tx/${hash}`);
  });

program
  .command("job [id]")
  .description("the IMD job building the launch")
  .action(async (id?: string) => {
    const job = await imd.job(id ?? (deployments as { launch?: { job?: string } }).launch?.job ?? "");
    console.log(JSON.stringify({ state: job.state, blocked: job.blockedReason, launch: job.launch }, null, 2));
  });

program
  .command("bind <launchNumber>")
  .description("bind the launched pool to the desk (steward)")
  .action(async (n: string) => {
    const hash = await wallet().writeContract({ address: desk, abi: curbDeskAbi, functionName: "bind", args: [BigInt(n)] });
    console.log(`bound: ${robinhood.blockExplorers.default.url}/tx/${hash}`);
  });

program
  .command("status [hook]")
  .description("a pool's breaker, without a swap")
  .action(async (hook?: string) => {
    for (const p of hook ? [{ hook: hook as Address }] : pools()) {
      console.log(formatStatus(p.hook, await readStatus(client(), p.hook)));
      console.log();
    }
  });

program
  .command("preflight <side> <amount> [hook]")
  .description("what the pool would do with a swap: buy or sell, amount of the input token")
  .option("--limit <tick>", "stop at this tick")
  .action(async (side: string, amount: string, hook: string | undefined, opts: { limit?: string }) => {
    const target = (hook ?? pools()[0]!.hook) as Address;
    const c = client();
    const key = await readPoolKey(c, target);
    const token = (await c.readContract({ address: target, abi: [{ type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "token" })) as Address;
    // Buying the pool's token spends the paired currency.
    const tokenIs0 = key.currency0.toLowerCase() === token.toLowerCase();
    const zeroForOne = side === "buy" ? !tokenIs0 : tokenIs0;
    const limit = opts.limit ? sqrtAtTick(Number(opts.limit)) : undefined;
    const p = await previewSwap(c, deployments.router as Address, key, zeroForOne, -parseUnits(amount, 18), limit);
    console.log(formatPreview(p));
  });

program
  .command("watch")
  .description("the keeper: file halts the desk can pay for, push undelivered answers, sweep fees")
  .option("--interval <seconds>", "poll interval", "10")
  .option("--dry", "decide without sending")
  .action(async (opts: { interval: string; dry?: boolean }) => {
    const c = client();
    let lastClaim = 0;
    for (;;) {
      for (const p of pools()) {
        const view = await poolView(c, p.hook, p.kind, Math.floor(Date.now() / 1000) - lastClaim);
        for (const a of decide(view)) {
          console.log(new Date().toISOString(), p.kind, a.kind, "why" in a ? a.why : "");
          if (opts.dry || a.kind === "wait") continue;
          const w = wallet();
          if (a.kind === "file") {
            await w.writeContract({ address: desk, abi: curbDeskAbi, functionName: "fileIncident", args: [a.hook] });
          } else if (a.kind === "push") {
            await w.writeContract({
              address: desk,
              abi: curbDeskAbi,
              functionName: "submitAttestation",
              args: [a.requestId, attestationTuple(a.attestation), a.attestation.signature],
            });
          } else if (a.kind === "claim") {
            const n = BigInt((deployments as { launch?: { number?: number } }).launch?.number ?? 0);
            if (n > 0n) await w.writeContract({ address: ADDRESSES.launchFactory, abi: factoryAbi, functionName: "claimFees", args: [n] });
            lastClaim = Math.floor(Date.now() / 1000);
          }
        }
      }
      await new Promise((r) => setTimeout(r, Number(opts.interval) * 1000));
    }
  });

program
  .command("drill")
  .description("replay the live drill (script/drill.sh): refusal, halt, unfunded incident, reopen")
  .action(() => {
    const r = spawnSync("bash", ["script/drill.sh"], { stdio: "inherit", env: { ...process.env, RPC: program.opts().rpc ?? process.env.RH_RPC } });
    process.exitCode = r.status ?? 1;
  });

program
  .command("backtest")
  .description("replay real Robinhood launch pools through the breaker (apps/backtest)")
  .action(() => {
    const r = spawnSync("pnpm", ["--filter", "@curb/backtest", "run", "run"], { stdio: "inherit", shell: true });
    process.exitCode = r.status ?? 1;
  });

async function poolView(c: PublicClient, hook: Address, kind: "launch" | "drill", sinceClaim: number): Promise<PoolView> {
  const s = await readStatus(c, hook);
  const incident = (await c.readContract({ address: desk, abi: curbDeskAbi, functionName: "incident", args: [hook, s.nonce] })) as {
    state: number;
    requestId: Hex;
  };
  const treasury = await c.readContract({ address: ADDRESSES.imd, abi: erc20, functionName: "balanceOf", args: [desk] });
  const questionPrice = await c.readContract({ address: ADDRESSES.intake, abi: intakeAbi, functionName: "priceOf", args: [ORACLE_REQUEST, ADDRESSES.imd] });
  let pending: PoolView["pending"];
  if (incident.state === 1) {
    const [, , questionHash] = (await c.readContract({ address: desk, abi: curbDeskAbi, functionName: "pending", args: [incident.requestId] })) as [Address, number, Hex];
    if (questionHash !== `0x${"0".repeat(64)}`) pending = { requestId: incident.requestId, attestation: await answerFor(c, hook, s.nonce) };
  }
  return { hook, kind, phase: s.phase as Phase, nonce: s.nonce, incidentState: incident.state, treasury, questionPrice, pending, sinceClaim };
}

/** The oracle's signed answer for an incident, found through the filing transaction's Intake entry. */
async function answerFor(c: PublicClient, hook: Address, nonce: number) {
  const logs = await c.getContractEvents({ address: desk, abi: curbDeskAbi, eventName: "IncidentFiled", args: { hook, nonce }, fromBlock: 92_856_000n });
  const tx = logs.at(-1)?.transactionHash;
  if (!tx) return null;
  const entry = (await imd.intake(4663, tx)).entries?.find((e) => e.action === "oracle.request");
  const id = entry?.admission?.result?.kind === "oracle" ? entry.admission.result.id : undefined;
  return id ? imd.attestation(id) : null;
}

function sqrtAtTick(tick: number): bigint {
  return BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 96));
}

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
