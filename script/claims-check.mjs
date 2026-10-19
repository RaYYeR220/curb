// Checks CLAIMS.md against the chain and the suite: every transaction exists with the outcome the
// claim states ("(failed" or "(succeeded"), and every test name exists in `forge test --list`.
//   node script/claims-check.mjs [rpc]
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const rpc = process.argv[2] ?? process.env.RH_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const claims = readFileSync(new URL("../CLAIMS.md", import.meta.url), "utf8");
let failures = 0;

const txs = [...claims.matchAll(/tx `(0x[0-9a-f]{64})` \((failed|succeeded)/g)];
for (const [, hash, expected] of txs) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
  }).then((r) => r.json());
  const status = res.result ? (res.result.status === "0x1" ? "succeeded" : "failed") : "missing";
  const ok = status === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${hash} ${status} (claimed ${expected})`);
}

const listed = execSync("forge test --list --json", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const names = new Set();
for (const contracts of Object.values(JSON.parse(listed))) {
  for (const tests of Object.values(contracts)) for (const t of tests) names.add(t);
}
// IMD's protected suites and the fork rehearsal are listed under their own profiles; read their sources.
const extra = ["test/protected/Hook.protected.t.sol", "test/protected/Owners.protected.t.sol", "test/fork/LaunchRehearsal.t.sol"]
  .map((p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8"))
  .join("\n");
for (const [, name] of extra.matchAll(/function (test\w+)\(/g)) names.add(name);

const tests = new Set([...claims.matchAll(/`((?:test|testFuzz|invariant)_\w+)`/g)].map((m) => m[1]));
for (const t of tests) {
  const ok = names.has(t);
  if (!ok) failures++;
  if (!ok) console.log(`FAIL test ${t} not found`);
}
console.log(`${txs.length} transactions, ${tests.size} tests checked, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
