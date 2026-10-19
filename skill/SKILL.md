---
name: curb
description: Trade, watch, file incidents for and launch Uniswap v4 pools guarded by Curb circuit breakers on Robinhood Chain (4663), through Identity MD.
---

# Curb circuit breakers

A Curb pool is a Uniswap v4 pool whose hook enforces the stock-market rule called Limit Up–Limit
Down. A swap may not end outside a band around where the pool has recently traded, and a price
that presses against the band pauses the pool for a bounded time. The hook says which rule
stopped a swap, in the revert. Every refusal can be read before a swap is sent, for free.

Everything here is fixed by contracts that are live on Robinhood Chain (chain id 4663). Where a
brief and this reference disagree on an address, a parameter or an error, the chain wins: read
`params()`, `status()` and `poolKey()` on the hook.

## What a Curb pool does

- **The reference.** A time-weighted average of the pool's tick over a window (5 minutes on
  CURB/IMD). It rolls on the first swap after each window ends, and never jumps more than
  `band - edge - 1` ticks from the current tick.
- **The band.** `reference ± band` ticks. A swap that would end outside it, further from the
  reference than it started, reverts `OutsideBand(ref, tickAfter, limit, zeroForOne)` and the whole
  swap is undone. A swap that ends inside the band passes. A swap toward the reference passes even
  when it ends outside. The price is always inside the band.
- **The edge zone.** The last `edge` ticks of the band on each side, that is any tick at least
  `band - edge` from the reference. A swap that ends there starts the limit clock.
- **The halt.** If the price is still in the edge zone `limitSeconds` later, the pool halts in
  both directions. Every swap reverts `Halted(nonce, reopensAt)` until `reopensAt`, at most
  `haltSeconds` after the halt started. No keeper is needed: the halt is a function of stored
  state and the clock, and the first swap after it closes the incident (`HaltClosed`).
- **The cooldown.** No new halt starts until `haltStart + haltSeconds + cooldownSeconds`. The pool
  trades normally in the meantime, band intact.
- **The verdict.** During a halt the pool's desk can ask the IMD oracle one question about the
  hook's own `Trade` tape: which trader moved the most paired-currency volume in the incident
  window, and how much. A fixed rule turns the share into a verdict:

  | Top trader's share of the window's volume | Verdict | Effect |
  | --- | --- | --- |
  | at most 30% | Organic | The halt ends now. |
  | at least 60% | Concentrated | The halt runs its full length, then the pre-move reference is pinned through the cooldown. |
  | anything else, or no answer | Inconclusive / none | Nothing changes: the halt runs its course and the pool re-centres on close. |

  A verdict can shorten a halt or keep a level. It can never lengthen a halt or move funds.
- **No market, no rule.** Where in-range liquidity is below `minLiquidity`, prices never start the
  limit clock, never roll the reference and never become the reference when a halt closes. A swap
  that starts there is judged from the first initialised tick carrying real liquidity. On launch
  2266, time the price spends there is still averaged into the next reference: if CURB/IMD has
  sat below its opening price, expect the next roll to pull the band down, and call
  `curb_preflight` before every buy.

| Parameter | CURB/IMD | DRILL/ETH (drill pool) |
| --- | --- | --- |
| `bandTicks` | 1000 (about ±10.5%) | 300 (about ±3%) |
| `edgeTicks` | 100 | 60 |
| `refWindow` | 300 s | 120 s |
| `limitSeconds` | 15 s | 10 s |
| `haltSeconds` | 900 s | 300 s |
| `cooldownSeconds` | 1800 s | 300 s |
| `minLiquidity` | 1e23 | 1e18 |

Both pools use the static 1.25% fee (`12500`) and tick spacing 60. The hook takes no fee and has no
liquidity callbacks: adding, removing and collecting fees are never refused.

## Trading a Curb pool

**Always preflight.** `CurbRouter.simulate(key, zeroForOne, amountSpecified, sqrtPriceLimitX96)`
runs the swap inside the PoolManager and always reverts. Called with `eth_call` it needs no wallet,
balance or approval, and nothing is sent:

- `Simulated(int128 amount0, int128 amount1, int24 tickAfter)` (selector `0x7e40f2ec`): the swap
  would pass. Amounts are the swapper's deltas: negative is paid, positive is received.
- `WrappedError(address target, bytes4 selector, bytes reason, bytes details)` (`0x90bfb865`): the
  hook refused. `reason` holds the hook's own error, `OutsideBand` (`0x6903c757`) or `Halted`
  (`0xa4e8c8ab`). It can be nested more than once.

```sh
# Buy DRILL with 0.0001 ETH on the drill pool, no price limit.
cast call 0x040B0f37e4CcdB79e4A2cdA7a894800bbe73eD45 \
  "simulate((address,address,uint24,int24,address),bool,int256,uint160)" \
  "(0x0000000000000000000000000000000000000000,0x2c7852B54EFd464AD16D2C36c00b43Af8EA02DD3,12500,60,0xeE60C95711F5650bbBBee421426820feC6e060c0)" \
  true -100000000000000 4295128740 --rpc-url https://rpc.mainnet.chain.robinhood.com
```

The MCP tool `curb_preflight` does the same and decodes the answer. In TypeScript, `previewSwap`
and `decodeCurbError` from `@curb/sdk` do it.

**Direction.** The tick is the price of `currency0` in `currency1`. Paying `currency0`
(`zeroForOne = true`) moves the tick down. `amountSpecified` is negative for an exact input. On
the drill pool `currency0` is ETH, so a buy of DRILL is `zeroForOne = true`. Read `poolKey()` and
`token()` on the hook for any other pool.

**Reading `OutsideBand(ref, tickAfter, limit, zeroForOne)`.** The swap would have ended at
`tickAfter`, beyond `limit` (`ref - band` or `ref + band`). Nothing was filled. Three ways on:

1. **Cap it.** Send the same swap with `sqrtPriceLimitX96` at one tick inside `limit` (`limit + 1`
   moving down, `limit - 1` moving up). It fills up to there and stops. The preflight's amounts
   at that limit are the largest single order the pool takes now. One tick inside matters: a
   downward swap that stops exactly on an initialised tick crosses it.
2. **Stay out of the edge zone.** Cap at `ref - (band - edge) + 1` moving down, or
   `ref + (band - edge) - 1` moving up. The fill is smaller, but it starts no limit clock and so
   no halt.
3. **Split over time.** The reference follows the price by up to `band - edge - 1` ticks each
   window, which reopens room in the same direction. Preflight each slice.

An exact-input swap with its limit at `MIN_SQRT_PRICE + 1` or `MAX_SQRT_PRICE - 1`, as aggregators
send, is refused whole rather than filled to the band.

**Reading `Halted(nonce, reopensAt)`.** Incident `nonce` is in progress and every swap, in either
direction, is refused until `reopensAt` (unix seconds) at the latest. An Organic verdict can end
it sooner. Halts always end by `reopensAt`. Preflight again after it, since the close may have
moved the reference.

**What always passes.** Outside a halt, a swap that ends inside the band, or that moves the price
toward the reference, is never refused. A holder can always sell toward the price the pool has
been trading at.

**Sending.** Any v4 router works; the hook does not care who calls the PoolManager.
`CurbRouter.swap(key, zeroForOne, amountSpecified, sqrtPriceLimitX96)` takes the input from the
caller with `transferFrom` (approve the router) or as `msg.value` for ETH, and refunds unused ETH.
The trade tape keys traders by `tx.origin`, so trades sent through a shared bundler count as one
trader.

## Watching a Curb pool

`status()` on the hook tells everything without a swap:

| Field | Meaning |
| --- | --- |
| `phase` | 0 open, 1 limit, 2 halted, 3 cooldown. |
| `nonce` | The current incident number; it rises when a halt closes. |
| `ref`, `lower`, `upper` | The reference tick and the band's limits. |
| `tick` | The pool's tick after the last swap. |
| `edgeSince` | When the price entered the edge zone; 0 when it is not there. |
| `haltStart`, `reopensAt` | When the pending or current halt starts and ends at the latest; 0 when none. |
| `cooldownEnd` | When the current cooldown ends. |
| `pinUntil` | When a Concentrated pin ends; 0 when not pinned. |
| `verdict` | 0 none, 1 Organic, 2 Concentrated, 3 Inconclusive, for the current incident. |
| `fromBlock`, `toBlock`, `windowVolume` | The incident window a filing now would ask about, in L2 blocks, and the paired volume traded in it. |

When a halt has ended but no swap has closed it yet, `ref`, `cooldownEnd` and `pinUntil` already
show what the close will set. `params()`, `poolKey()`, `token()`, `isLive()`, `totalVolume()` and
`incidentWindow()` are also views.

| Event | Emitted by | When |
| --- | --- | --- |
| `Trade(address indexed trader, uint256 volume)` | hook | Every successful swap: `tx.origin` and the paired currency moved. |
| `ReferenceRolled(nonce, ref, twap, tick)` | hook | The reference window rolled. |
| `ReferenceReanchored(nonce, ref, boundary, tick)` | hook | A swap from an empty range landed in liquidity. |
| `LimitEntered(nonce, ref, tick, haltsAt)` | hook | The price entered the edge zone; the pool halts at `haltsAt` unless it leaves. |
| `LimitCleared(nonce, tick)` | hook | The price left the edge zone, or the reference rolled. |
| `Resolved(nonce, verdict, reopensAt)` | hook | A verdict was applied during the halt. |
| `HaltClosed(nonce, haltStart, haltEnd, verdict, newRef, cooldownEnd)` | hook | The first swap after a halt closed it. |
| `IncidentFiled(hook, nonce, requestId, questionHash, fromBlock, toBlock, total)` | desk | The desk paid the oracle question. |
| `VerdictReached(hook, nonce, verdict, shareBps, leader, figure, total, applied)` | desk | The oracle answered; `applied` is false when the halt was already over. |
| `RequestFailed(requestId, status, reason)` | desk | IMD refused or could not answer; `reason` is ASCII in a `bytes32`. |

Block numbers in the incident window are Robinhood Chain's own (ArbSys `arbBlockNumber`), not
`block.number`, which on this chain is Ethereum's. The public RPC serves `eth_getLogs` over at most
10,000,000 blocks per call and keeps no historical state for `eth_call`.

## Filing an incident and pushing an attestation

**Anyone may file.** While a pool is halted, `CurbDesk.fileIncident(hook)` asks the oracle about
the halt. The desk pays from its own treasury: `Intake.priceOf("oracle.request@oracle-1", IMD)`,
0.5 IMD today, and never more than `MAX_PRICE` (1 IMD). On a launch pool it first claims its LP
fees. One question per incident, never retried. It reverts:

- `UnknownPool(hook)`: the desk has not bound this hook.
- `NotHalted()`: the pool is not halted right now.
- `AlreadyFiled(nonce)`: this incident was already asked about.
- `WindowTooFresh(toBlock, head)`: the window's last block is less than 8 L2 blocks deep. Wait a
  few seconds.
- `TreasuryShort(have, need)`: the desk cannot pay. The halt then runs its full length, which is
  the default. Anyone can top the desk up: approve IMD to the desk, then `fund(amount)`.
- `PriceAboveCap(price, cap)`: IMD lists the question above 1 IMD.

The question is written on chain from the hook's address and the window alone (`question(hook,
fromBlock, toBlock)`, `oracleBody(...)`): answer type `address[]` with `head` 1, a panel of 7,
quorum 5, valid for an hour. Its hash is pinned, so only the answer to that question is accepted.

**Pushing the answer.** The Intake delivers the signed answer to `onOracleResult` under a 200,000
gas stipend. If that delivery does not land, anyone can push the same answer:

1. Take the Intake's `requestId` from `IncidentFiled`. `pending(requestId)` returns a non-zero
   `questionHash` while the request is unsettled.
2. `GET https://api.imd.fun/intake/4663/<fileIncident transaction hash>`. In `entries[]`,
   `admission.result` names the oracle request and its `attestationUrl`.
3. `GET https://api.imd.fun/oracle/requests/<oracle request id>/attestation` returns
   `{message, signature, signer, ...}` once the request is attested (`404 not_attested` before).
4. Call `submitAttestation(requestId, a, signature)`. `requestId` is the Intake's id from step 1,
   not the oracle's UUID. `a` is the message's 15 fields in this order: `requestId, chainId,
   questionHash, answerType, answer, figure, fromBlock, toBlock, blockHash, panelJobId, panelSize,
   quorum, agreed, issuedAt, expiresAt`. `answerType` is the code, not the name: `address[]` is 4.

It reverts `UnknownRequest` once settled, and `WrongQuestion`, `PanelTooWeak`, `BadSignature`,
`AttestationExpired` or `AlreadyConsumed` for an answer it must not act on. A late answer is
recorded on its own incident (`VerdictReached` with `applied` false) and never applied to another.

`incident(hook, nonce)` returns what the desk knows about an incident: `state` (0 none, 1 filed,
2 answered, 3 failed), `verdict`, `applied`, `shareBps`, `leader`, `figure`, `total` and the request
ids. `commissionPostMortem(hook, nonce)` hires an IMD research job to write up an answered
incident, only while the treasury could still pay for the next question afterwards.

## Launching your own token with Curb through IMD

A launch deploys your token and a Curb hook through IMD's launch factory, seeds a single-sided pool
paired with IMD (`poolBps` 9000), and pins the code to a public GitHub commit. The MCP tool
`curb_launch_manifest` builds the manifest and the body and runs the free checks.

1. **Fork** `https://github.com/RaYYeR220/curb`. Set the token's name and symbol in
   `src/CurbToken.sol` (`ERC20("Garden", "GRDN")`). Write `launch.json` with your parameters; the
   hook's constructor arguments are `$poolManager, $token, $factory, $owner, bandTicks, edgeTicks,
   refWindow, limitSeconds, haltSeconds, cooldownSeconds, minLiquidityE18, true`. The constructor
   requires `edgeTicks > 0`, `bandTicks - edgeTicks >= 2`, `bandTicks <= 20000` and every duration
   above zero.
2. **Test.** `forge test`, then `bash script/protected.sh`: IMD's `univ4_hook` admission suites.
   IMD's verifier compiles every contract in the tree it pins and parks the launch if any of them
   reads as containing `DELEGATECALL`, so check the whole tree, not only the launched contracts.
3. **Push** to a public repository and resolve the commit:
   `POST https://api.imd.fun/requests/import` with
   `{"url":"https://github.com/<owner>/<repo>","kind":"contracts"}` returns
   `{ok, source: {repoUrl, baseCommit}}`, or `{ok: false, problems}`.
4. **Write the body** for `launch.open`:

   ```json
   {"objective":"Launch Garden (GRDN) with the Uniswap v4 hook in src/CurbHook.sol from this repository ... Token: src/CurbToken.sol, name Garden, symbol GRDN, 18 decimals, fixed 1,000,000,000 supply ...","repoUrl":"https://github.com/<owner>/<repo>","baseCommit":"<40 hex>","references":["uniswap-v4-hooks","uniswap-v4-security","oracle-consumer"],"onchain":"univ4_hook","chainId":4663,"pairWith":"imd","owner":"<lowercase address>","economics":{"poolBps":9000,"remainderTo":"<lowercase address>"},"github":true,"shape":"chain","steps":[{"skill":"audit-imported-code"}]}
   ```

   The objective must name the token's name, symbol and supply, and the files. `owner` is the
   hook's `$owner`, whose one power is `resolve`: name a CurbDesk to have the oracle decide
   verdicts, or an address you control.
5. **Check, free.** `POST https://api.imd.fun/requests/check` with
   `{"action":"launch.open","input":<body>}` returns `{blockers, plan, suggestions, ...}` after 1
   to 3 minutes. Pay only when `blockers` is `[]`.
6. **Pay** 0.5 IMD (`Intake.priceOf("launch.open@launch-1", IMD)`); nothing is refunded, and a
   launch can still park after payment.
   - From a wallet: `IMD.approve(Intake, price)`, then `Intake.request(0x6c61756e63682e6f70656e406c61756e63682d31000000000000000000000000,
     <body as UTF-8 bytes>, (0x0000000000000000000000000000000000000000, 0x00000000), IMD, price)`.
     The payer is the launch's requester and receives its LP fee share (80% of the pool fee).
   - From a desk: deploy `CurbDesk(intake, imd, launchFactory, oracleSigner, steward)`, fund it
     with IMD and call `launch(body)` as steward. The desk is then payer and requester, and its fee
     share pays for incident questions; name it as `owner` in the body so its verdicts can resolve
     halts. Once the pool is live, `bind(launchNumber)` lets the desk file incidents for it.
7. **Track.** `GET https://api.imd.fun/intake/4663/<payment transaction hash>` gives the job id;
   `GET https://api.imd.fun/jobs/<jobId>/result` gives the launch id; `GET
   https://api.imd.fun/launches/<launchId>` gives its `status` and, if parked, `parkedReason`.

## Addresses

Robinhood Chain, chain id 4663. RPC `https://rpc.mainnet.chain.robinhood.com`, explorer
`https://robin.etherscan.io`.

| Contract | Address |
| --- | --- |
| `CurbDesk` | `0xa4dF8fbf3A1aB94795577c74fFae26E1d2083819` |
| `CurbRouter` | `0x040B0f37e4CcdB79e4A2cdA7a894800bbe73eD45` |
| Desk steward | `0xE83bc0dddED710C5A6e4E6Fc8d6E5da4Cd46042c` |
| Drill hook (DRILL/ETH) | `0xeE60C95711F5650bbBBee421426820feC6e060c0` |
| DRILL token | `0x2c7852B54EFd464AD16D2C36c00b43Af8EA02DD3` |
| Uniswap v4 `PoolManager` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| IMD `Intake` (version 2) | `0xa43e6F75ee006411F79Ac1C84120606C2330DE82` |
| IMD `LaunchFactory` | `0xA25B02A1e93903b790E6aaf7dA1b8B8d50294645` |
| IMD token | `0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127` |
| IMD oracle signer | `0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982` |

The drill pool's key is `(0x0000000000000000000000000000000000000000, DRILL, 12500, 60, drill
hook)`. The CURB/IMD launch was paid by the desk in transaction
`0x01c6be368e6b206308a9f0b82bdb7375d352e44930865604a723a83cafada7a2` (IMD job
`ba1783a0-120c-41b3-a933-892a34a6e91c`). Every hook the desk serves is listed by `hookCount()` and
`hooks(i)`, and `pools(hook)` says whether it is the launch (1) or a drill (2). The same addresses
ship in `@curb/sdk` as `deployments` and `ADDRESSES`.

## Connecting the MCP server

The repository's `apps/mcp` is an MCP server named `curb` with five tools, all read-only:

| Tool | Does |
| --- | --- |
| `curb_status {hook?, listPools?}` | Phase, ticks, band and edge zone, halt and cooldown times, incident window, summary. |
| `curb_preflight {hook?, side, amount, limitTick?}` | Simulates an exact-input buy or sell; returns the fill or the refusal and what to do. |
| `curb_incidents {hook?, limit?, fromBlock?}` | Halts, filings, verdicts and failures with explorer links, and the desk's treasury. |
| `curb_explain_revert {data? \| txHash?}` | Decodes a revert, unwrapping `WrappedError`. |
| `curb_launch_manifest {name, symbol, owner, params?, repoUrl?, baseCommit?, check?}` | Builds `launch.json` and the `launch.open` body; with `check`, runs IMD's free import and check. |

`hook` takes an address, `"launch"` or `"drill"`. Left out, it is the CURB/IMD pool once its hook
is recorded, else the drill pool.

After `pnpm install` in the repository, run it over stdio:

```json
{
  "mcpServers": {
    "curb": { "command": "npx", "args": ["-y", "tsx", "/path/to/curb/apps/mcp/src/index.ts"] }
  }
}
```

or with Claude Code: `claude mcp add curb -- npx -y tsx /path/to/curb/apps/mcp/src/index.ts`.

Hosted over Streamable HTTP at `https://curb-bay.vercel.app/mcp`. To run your own,
`npx tsx apps/mcp/src/index.ts --http 8787` serves
`http://127.0.0.1:8787/mcp`, stateless, POST only. `--host 0.0.0.0` binds every interface.
`--rpc <url>` (or `CURB_RPC`) picks the Robinhood RPC and `--imd-api <url>` (or `IMD_API`) the IMD
API.
