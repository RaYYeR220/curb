import { ADDRESSES } from "@curb/sdk";
import { PageHead } from "../components/PageHead";
import { AddrLink, CodeBlock, Out } from "../components/ui";
import { deployments, REPO_URL } from "../lib/deployments";

const SECTIONS = [
  ["what", "What Curb is"],
  ["parameters", "Parameters"],
  ["refusals", "Reading a refusal"],
  ["verify", "Verify it"],
  ["mcp", "MCP server"],
  ["skill", "Agent skill"],
  ["addresses", "Addresses"],
] as const;

const PREVIEW = `import { curbClient, readPoolKey, previewSwap, deployments } from "@curb/sdk";

const client = curbClient();
const key = await readPoolKey(client, deployments.drill.drillHook);

// Buy DRILL with 0.0001 ETH: ETH is currency0, so zeroForOne; negative = exact input.
const p = await previewSwap(client, deployments.router, key, true, -100000000000000n);

if (p.ok) console.log("passes, ends at tick", p.tickAfter);
else console.log(p.error?.name, p.error?.human);`;

const VERIFY = `forge test                         # 193 tests: unit, fuzz, 8 invariants, soak, oracle conformance,
                                   # and the TypeScript model replayed against the Solidity breaker
node script/claims-check.mjs       # every claim in CLAIMS.md against its transaction or test
bash script/protected.sh           # IMD's univ4_hook admission suites, 13/13
bash script/protected.sh above     # the same with CURB sorting above IMD
RH_RPC=https://rpc.mainnet.chain.robinhood.com \\
  forge test --match-contract LaunchRehearsal -vv   # the launch, rehearsed on live Robinhood state`;

const MCP_START = `pnpm install
npx -y tsx apps/mcp/src/index.ts                 # stdio
npx -y tsx apps/mcp/src/index.ts --http 8787     # Streamable HTTP at /mcp`;

const MCP_CONFIG = `{
  "mcpServers": {
    "curb": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/curb/apps/mcp/src/index.ts"]
    }
  }
}`;

export function Docs() {
  return (
    <>
      <PageHead
        title="Docs"
        lede="What the hook enforces, how to read what it says, and how to check every claim yourself."
      />
      <div className="docs">
        <nav className="docs__index" aria-label="On this page">
          <ol>
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => {
                    const el = document.getElementById(id);
                    el?.scrollIntoView({ behavior: "smooth", block: "start" });
                    el?.focus({ preventScroll: true });
                  }}
                >
                  {label}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <article className="docs__body prose">
          <section id="what" tabIndex={-1}>
            <h2>What Curb is</h2>
            <p>
              Stock markets have run Limit Up–Limit Down since 2013: a price may not trade outside a band around where it has recently
              traded, and a price that presses against the band pauses the market for a few minutes. Curb is that rule as a Uniswap v4
              hook on Robinhood Chain, launched through Identity MD.
            </p>
            <ul>
              <li>
                <b>Refused, with a reason.</b> A swap that would end outside the band, further from the reference than it started, reverts
                with <code>OutsideBand(ref, tickAfter, limit, zeroForOne)</code>. A swap back toward the reference always passes.
              </li>
              <li>
                <b>Bounded halts.</b> A price held at the band's edge for 15 seconds halts the pool both ways for at most 15 minutes. The
                halt ends on its own, and a 30-minute cooldown spaces the next one.
              </li>
              <li>
                <b>Agents measure, contracts decide.</b> During a halt the pool's desk asks the IMD oracle which trader on its own trade
                tape moved the most volume. The answer is signed; code turns the share into a verdict: 30% or less is organic and reopens
                now, 60% or more is one actor and keeps the pre-move price, anything between changes nothing.
              </li>
              <li>
                <b>No strandings below the launch price.</b> Where nothing trades, prices don't count: they never halt the pool or move its
                reference, and a swap from there into real liquidity is judged from where that liquidity begins.
              </li>
            </ul>
            <p>
              The owner of a hook, the desk, has one power: <code>resolve(nonce, verdict)</code>. It can shorten a halt or pin a level. It
              cannot lengthen a halt, change a parameter, touch liquidity or move funds, and the desk has no withdraw function.
            </p>
          </section>

          <section id="parameters" tabIndex={-1}>
            <h2>Parameters</h2>
            <div className="table-wrap" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col" />
                    <th scope="col">CURB/IMD</th>
                    <th scope="col">Drill pool</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Band</th>
                    <td>1,000 ticks (±10.5%)</td>
                    <td>300 ticks (±3.05%)</td>
                  </tr>
                  <tr>
                    <th scope="row">Edge zone</th>
                    <td>100 ticks</td>
                    <td>60 ticks</td>
                  </tr>
                  <tr>
                    <th scope="row">Reference window</th>
                    <td>5 min</td>
                    <td>2 min</td>
                  </tr>
                  <tr>
                    <th scope="row">Limit state</th>
                    <td>15 s</td>
                    <td>10 s</td>
                  </tr>
                  <tr>
                    <th scope="row">Halt, at most</th>
                    <td>15 min</td>
                    <td>5 min</td>
                  </tr>
                  <tr>
                    <th scope="row">Cooldown</th>
                    <td>30 min</td>
                    <td>5 min</td>
                  </tr>
                  <tr>
                    <th scope="row">No-market floor</th>
                    <td>1e23 in-range liquidity</td>
                    <td>1e18</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              The CURB/IMD pool uses the static 1.25% fee and tick spacing 60, seeded by IMD's LaunchFactory. Every hook reports its own
              numbers through <code>params()</code>, and the <a href="#/board">board</a> reads them from there.
            </p>
          </section>

          <section id="refusals" tabIndex={-1}>
            <h2>Reading a refusal</h2>
            <p>
              v4's PoolManager wraps a hook's revert in <code>WrappedError(target, selector, reason, details)</code>. The reason inside is
              one of Curb's own errors:
            </p>
            <dl className="defs">
              <div>
                <dt>
                  <code>OutsideBand(ref, tickAfter, limit, zeroForOne)</code>
                </dt>
                <dd>
                  <code>ref</code> is the reference tick the band centres on, <code>tickAfter</code> where the swap would have ended,{" "}
                  <code>limit</code> the band edge it crossed, and <code>zeroForOne</code> its direction. A <code>tickAfter</code> at
                  ±887,272 means the swap would have run through every position to the end of the curve. Split the order, or set a price
                  limit inside the band.
                </dd>
              </div>
              <div>
                <dt>
                  <code>Halted(nonce, reopensAt)</code>
                </dt>
                <dd>
                  Incident <code>nonce</code> is in progress and every swap is refused both ways. <code>reopensAt</code> is the latest the
                  pool reopens, in Unix seconds; a verdict can only bring it forward.
                </dd>
              </div>
              <div>
                <dt>
                  <code>TreasuryShort(have, need)</code>
                </dt>
                <dd>From the desk: it cannot pay for the oracle's question, so the halt will run its full length.</dd>
              </div>
            </dl>
            <p>
              Before sending a swap, ask the router's <code>simulate</code>. It always reverts: with <code>Simulated(amount0, amount1,
              tickAfter)</code> when the swap would pass, or with the hook's reason when it would not. It works from any address, with no
              balance or approval, and the SDK decodes both into a sentence:
            </p>
            <CodeBlock label="TypeScript, @curb/sdk" code={PREVIEW} />
            <p>
              <a href="#/break">Try to break it</a> runs exactly this against the live pool.
            </p>
          </section>

          <section id="verify" tabIndex={-1}>
            <h2>Verify it</h2>
            <CodeBlock label="From the repository root" code={VERIFY} />
            <p>The invariants hold under random trading, clock moves, verdicts, fee collects and stray callback calls:</p>
            <ol>
              <li>no halt longer than its maximum;</li>
              <li>halts spaced by halt + cooldown + limit;</li>
              <li>a verdict never lengthens a halt;</li>
              <li>outside a halt, no swap that ends in the band or moves toward the reference is refused;</li>
              <li>the price is always inside the band;</li>
              <li>the factory's fee collect always succeeds;</li>
              <li>only the PoolManager drives callbacks;</li>
              <li>on-chain volume equals the sum of the tape.</li>
            </ol>
            <p>
              <Out href={`${REPO_URL}/blob/main/CLAIMS.md`}>CLAIMS.md</Out> ties every claim to a transaction or a test;{" "}
              <Out href={`${REPO_URL}/blob/main/docs/VERIFICATION.md`}>VERIFICATION.md</Out> records the fork rehearsal of the launch on
              live Robinhood state and the drill run live; <Out href={`${REPO_URL}/blob/main/FAILURE-MODES.md`}>FAILURE-MODES.md</Out> what each adversarial
              strategy costs and where it stops; <Out href={`${REPO_URL}/blob/main/SECURITY.md`}>SECURITY.md</Out> the self-assessment
              against the Uniswap Foundation's hooks security framework.
            </p>
          </section>

          <section id="mcp" tabIndex={-1}>
            <h2>MCP server</h2>
            <p>
              <code>apps/mcp</code> serves Curb's reads to any MCP client, so an agent can check a pool's phase and preview a swap
              before it sends one, with the same SDK this site uses. Its tools: <code>curb_status</code>, <code>curb_preflight</code>{" "}
              (the fill, or the refusal with the largest size that passes now), <code>curb_incidents</code>,{" "}
              <code>curb_explain_revert</code> and <code>curb_launch_manifest</code> (a <code>launch.json</code> and IMD body for your own
              token). Start it from the repository root:
            </p>
            <CodeBlock label="Shell" code={MCP_START} />
            <p>
              It is also hosted over Streamable HTTP at <code>https://curb-bay.vercel.app/mcp</code>. Or register the local server with a
              client that launches servers itself:
            </p>
            <CodeBlock label="MCP client configuration" code={MCP_CONFIG} />
          </section>

          <section id="skill" tabIndex={-1}>
            <h2>Agent skill</h2>
            <p>
              <code>skill/SKILL.md</code> is an instruction file an agent loads before it trades on a Curb pool: how to preview a swap, and
              how to read <code>OutsideBand</code> and <code>Halted</code> as instructions rather than failures, by splitting an order the
              band refuses and waiting out a halt instead of retrying into it.
            </p>
          </section>

          <section id="addresses" tabIndex={-1}>
            <h2>Addresses</h2>
            <p>Robinhood Chain, chain id 4663.</p>
            <dl className="addr-list">
              <div>
                <dt>CurbDesk</dt>
                <dd>
                  <AddrLink address={deployments.desk} label={deployments.desk} />
                </dd>
              </div>
              <div>
                <dt>CurbRouter</dt>
                <dd>
                  <AddrLink address={deployments.router} label={deployments.router} />
                </dd>
              </div>
              <div>
                <dt>Drill hook</dt>
                <dd>
                  <AddrLink address={deployments.drill.drillHook} label={deployments.drill.drillHook} />
                </dd>
              </div>
              <div>
                <dt>DRILL token</dt>
                <dd>
                  <AddrLink address={deployments.drill.drillToken} label={deployments.drill.drillToken} />
                </dd>
              </div>
              {deployments.launch?.hook && (
                <div>
                  <dt>CURB/IMD hook</dt>
                  <dd>
                    <AddrLink address={deployments.launch.hook} label={deployments.launch.hook} />
                  </dd>
                </div>
              )}
              <div>
                <dt>PoolManager</dt>
                <dd>
                  <AddrLink address={ADDRESSES.poolManager} label={ADDRESSES.poolManager} />
                </dd>
              </div>
              <div>
                <dt>IMD Intake</dt>
                <dd>
                  <AddrLink address={ADDRESSES.intake} label={ADDRESSES.intake} />
                </dd>
              </div>
              <div>
                <dt>IMD token</dt>
                <dd>
                  <AddrLink address={ADDRESSES.imd} label={ADDRESSES.imd} />
                </dd>
              </div>
              <div>
                <dt>Oracle signer</dt>
                <dd>
                  <AddrLink address={ADDRESSES.oracleSigner} label={ADDRESSES.oracleSigner} />
                </dd>
              </div>
            </dl>
          </section>
        </article>
      </div>
    </>
  );
}
