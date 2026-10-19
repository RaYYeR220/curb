# Backtest: Curb on the real IMD launch pools

**The question.** Take every pool IMD's LaunchFactory launched on Robinhood Chain in the last 30
days and replay its real swaps through Curb's breaker with the CURB/IMD parameters:

- how often would a swap have been refused;
- how often would the pool have halted;
- how would the desk's verdict rule have classified each halt.

The replay runs on `Breaker` from `@curb/sdk`, the TypeScript twin of `src/libraries/Breaker.sol`
that `test/differential` holds to the Solidity library. The verdict rule is `CurbDesk.classify`.

## Results

<!-- results:start -->
Run at L2 block 92,971,927 (2026-10-19T22:36:12Z) over every launch since 2026-09-19T22:36:12Z.

- **21 launch pools**, 13 of them traded: **2,982 swaps** from 747 distinct senders.
- **Refused (OutsideBand): 470 swaps** (15.8%) from 252 senders, in 89 breakouts (runs of consecutive refusals on one side). 318 pushed the token up, 152 down; 4 were swaps larger than all the liquidity on their side, ending where nothing trades.
- **Halts: 22**, in 6 pools. 420 swaps arrived during one; 1 halt saw none.
- **Verdicts:** 12 organic, 1 concentrated, 9 inconclusive. 13 applied (organic reopens after 90 s, concentrated pins); inconclusive halts run their full 15 minutes.
- **Time halted:** 2.8 h within the pools' first 24 hours, 0.60% of those 21 pool-days; 2.8 h over their whole lives, 0.082%.
- **If no verdict ever landed** (oracle down, every halt runs 15 minutes): 241 refused, 22 halts, 943 swaps during halts, 5.5 h halted.

| Launch | Token | Pair | Swaps | Senders | Refused (up / down) | Breakouts | Halts | Swaps in halts | Halted, first 24 h | Halted, % of life | Verdicts O / C / I | First-hour high |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 784 | WIN | IMD | 1,401 | 343 | 275 (186 / 89) | 51 | 7 | 162 | 51 min (3.5%) | 0.26% | 4 / 0 / 3 | +191.5% |
| 832 | KING | ETH | 8 | 8 | 1 (0 / 1) | 1 | 0 | 0 | — | — | — | +1.7% |
| 1015 | WORK | IMD | 533 | 254 | 62 (46 / 16) | 19 | 6 | 114 | 63 min (4.4%) | 0.38% | 2 / 1 / 3 | +51.6% |
| 1033 | i/p | IMD | 3 | 3 | 0 (0 / 0) | 0 | 0 | 0 | — | — | — | +0.0% |
| 1205 | SVO | IMD | 85 | 37 | 0 (0 / 0) | 0 | 0 | 0 | — | — | — | +0.0% |
| 1316 | MONEYBACK | IMD | 179 | 101 | 40 (26 / 14) | 6 | 2 | 13 | 3 min (0.2%) | 0.03% | 2 / 0 / 0 | +79.4% |
| 1330 | RNNN | IMD | 4 | 3 | 0 (0 / 0) | 0 | 0 | 0 | — | — | — | +0.6% |
| 1439 | PIMD | IMD | 147 | 77 | 52 (51 / 1) | 7 | 2 | 15 | 3 min (0.2%) | 0.03% | 2 / 0 / 0 | +47.6% |
| 1710 | BLACKOUT | ETH | 427 | 95 | 0 (0 / 0) | 0 | 3 | 36 | 45 min (3.1%) | 0.56% | 0 / 0 / 3 | +29.2% |
| 1745 | REKTD | IMD | 14 | 2 | 1 (0 / 1) | 1 | 0 | 0 | — | — | — | +0.7% |
| 1768 | REKTD | ETH | 2 | 2 | 0 (0 / 0) | 0 | 0 | 0 | — | — | — | +0.0% |
| 1872 | CRWN | ETH | 5 | 2 | 0 (0 / 0) | 0 | 0 | 0 | — | — | — | +0.0% |
| 2196 | CABAL | IMD | 174 | 82 | 39 (9 / 30) | 4 | 2 | 80 | 3 min (0.2%) | 0.21% | 2 / 0 / 0 | +169.3% |
| **All** | | | **2,982** | **747** | **470 (318 / 152)** | **89** | **22** | **420** | **2.8 h** | **0.082%** | **12 / 1 / 9** | |

Never traded: 1194 SNEWT/IMD, 1300 SPEPE/IMD, 1327 RNNN/IMD, 1660 PERK/IMD, 1867 CRWN/ETH, 2185 KEPT/IMD, 2232 GAMMA/IMD, 2266 CURB/IMD.

### The most violent launches

- **784 WIN/IMD:** +191.5% at the first hour's high over 322 swaps; its biggest single swap moved the price +7.0%. Curb would have refused 167 of those swaps and halted once (organic, top sender 24.8% of 8). Over its life: 275 refused in 51 breakouts, 7 halts, 51 min halted.
- **2196 CABAL/IMD:** +169.3% at the first hour's high over 160 swaps; its biggest single swap moved the price -6.1%. Curb would have refused 39 of those swaps and halted twice (organic, top sender 12.5% of 10; organic, top sender 14.8% of 28). Over its life: 39 refused in 4 breakouts, 2 halts, 3 min halted.
- **1316 MONEYBACK/IMD:** +79.4% at the first hour's high over 107 swaps; its biggest single swap moved the price -6.0%. Curb would have refused 39 of those swaps and halted twice (organic, top sender 22.1% of 14; organic, top sender 17.2% of 14). Over its life: 40 refused in 6 breakouts, 2 halts, 3 min halted.
- **1015 WORK/IMD:** +51.6% at the first hour's high over 71 swaps; its biggest single swap moved the price -3.3%. Curb would have refused 18 of those swaps and halted once (organic, top sender 21.1% of 15). Over its life: 62 refused in 19 breakouts, 6 halts, 63 min halted.
- **1439 PIMD/IMD:** +47.6% at the first hour's high over 68 swaps; its biggest single swap moved the price -7.2%. Curb would have refused 21 of those swaps and halted once (organic, top sender 18.9% of 9). Over its life: 52 refused in 7 breakouts, 2 halts, 3 min halted.

### Every halt

| Launch | Incident | Halt start (UTC) | Lasted | Token vs reference | Window (L2 blocks) | Senders | Top sender | Top share | Verdict | Swaps during |
|---:|---:|---|---:|---:|---|---:|---|---:|---|---:|
| 784 WIN | 0 | 2026-10-06 09:58:36 | 90 s | +27.8% | 81,528,886–81,542,276 | 8 | `0x415d…481a` | 24.8% | organic | 67 |
| 784 WIN | 1 | 2026-10-06 10:43:51 | 90 s | +52.4% | 81,563,167–81,568,806 | 78 | `0xc234…e1d6` | 8.3% | organic | 12 |
| 784 WIN | 2 | 2026-10-06 11:56:17 | 90 s | +10.9% | 81,605,617–81,611,212 | 9 | `0xada5…f7cb` | 28.9% | organic | 2 |
| 784 WIN | 3 | 2026-10-06 13:23:43 | 15 min | +23.1% | 81,656,581–81,662,723 | 9 | `0xc01a…a2c2` | 36.1% | inconclusive | 60 |
| 784 WIN | 4 | 2026-10-06 14:54:35 | 90 s | -9.0% | 81,711,725–81,716,095 | 13 | `0x728f…f500` | 26.3% | organic | 2 |
| 784 WIN | 5 | 2026-10-06 16:51:08 | 15 min | -14.9% | 81,777,140–81,784,789 | 7 | `0x415d…481a` | 40.8% | inconclusive | 10 |
| 784 WIN | 6 | 2026-10-06 21:34:38 | 15 min | -10.0% | 81,942,275–81,951,268 | 4 | `0x4337…9ad4` | 43.2% | inconclusive | 9 |
| 1015 WORK | 0 | 2026-10-08 07:31:57 | 90 s | +14.6% | 83,132,338–83,140,796 | 15 | `0x534e…d45b` | 21.1% | organic | 12 |
| 1015 WORK | 1 | 2026-10-08 08:17:12 | 15 min | +10.8% | 83,162,957–83,167,068 | 23 | `0x87ef…9bc2` | 49.4% | inconclusive | 71 |
| 1015 WORK | 2 | 2026-10-08 09:10:47 | 90 s | -12.8% | 83,192,477–83,198,224 | 17 | `0x2fd1…003d` | 28.6% | organic | 9 |
| 1015 WORK | 3 | 2026-10-08 11:38:52 | 15 min | -8.8% | 83,280,883–83,284,929 | 9 | `0x5e9e…d07d` | 80.8% | concentrated | 8 |
| 1015 WORK | 4 | 2026-10-08 14:04:29 | 15 min | +11.5% | 83,365,500–83,369,962 | 7 | `0x18dd…8e25` | 45.3% | inconclusive | 11 |
| 1015 WORK | 5 | 2026-10-08 15:04:36 | 15 min | -11.7% | 83,391,363–83,405,439 | 3 | `0xce7c…acd5` | 58.5% | inconclusive | 3 |
| 1316 MONEYBACK | 0 | 2026-10-11 16:58:49 | 90 s | +30.2% | 85,989,366–85,990,667 | 14 | `0x9698…e471` | 22.1% | organic | 6 |
| 1316 MONEYBACK | 1 | 2026-10-11 17:44:04 | 90 s | +17.0% | 86,012,067–86,017,035 | 14 | `0xf4ef…6424` | 17.2% | organic | 7 |
| 1439 PIMD | 0 | 2026-10-12 16:30:08 | 90 s | +11.3% | 86,812,336–86,815,580 | 9 | `0x758e…d011` | 18.9% | organic | 7 |
| 1439 PIMD | 1 | 2026-10-13 04:30:54 | 90 s | +39.6% | 87,037,934–87,234,239 | 10 | `0xf678…d6c9` | 16.1% | organic | 8 |
| 1710 BLACKOUT | 0 | 2026-10-14 09:12:46 | 15 min | +10.2% | 88,242,019–88,249,860 | 9 | `0x153f…883c` | 33.2% | inconclusive | 17 |
| 1710 BLACKOUT | 1 | 2026-10-14 13:45:48 | 15 min | +9.7% | 88,407,158–88,412,666 | 8 | `0x841e…984b` | 32.5% | inconclusive | 10 |
| 1710 BLACKOUT | 2 | 2026-10-14 15:21:47 | 15 min | -9.2% | 88,465,198–88,469,967 | 7 | `0x153f…883c` | 35.1% | inconclusive | 9 |
| 2196 CABAL | 0 | 2026-10-18 23:06:03 | 90 s | +52.1% | 92,145,872–92,146,005 | 10 | `0x9092…738b` | 12.5% | organic | 80 |
| 2196 CABAL | 1 | 2026-10-18 23:51:18 | 90 s | -37.3% | 92,165,224–92,171,465 | 28 | `0xa0f8…3c76` | 14.8% | organic | 0 |

*Token vs reference* is the token's price when the halt began, against the reference in force when its limit state began. Beyond ±10.5% the run there was made of swaps Curb would have refused.
<!-- results:end -->

The full per-pool data, every halt and every refused swap with its transaction are in
[`results/`](results/).

### What the 2026-10-19 run says

- **Refusals come from runs, not whales.** In the five most violent first hours, no single swap
  moved the price more than 7.2%, well inside the ±10.5% band. The refused swaps were the tail of
  buying runs that outpaced a 5-minute reference.
  - 284 of the 470 refusals fall in a pool's first hour, and 469 in its first day.
  - WIN alone accounts for 275 of them, 167 in its first hour on the way to +191%.
- **Halts are a launch-day event.** All 22 began within 12.1 hours of their pool's launch.
  - With verdicts landing, the 13 traded pools spent 2.8 hours halted in all.
  - With no verdict ever landing, that is 5.5 hours, and 943 swaps arrive during halts instead of
    420.
- **Organic is the common verdict, and it needs a crowd.** The 12 organic halts had 8 to 78
  senders in their window, a median of 13.5. The 9 inconclusive ones had 3 to 23, a median of 7.
  - In a window of 7 senders the leader seldom has 30% or less.
  - The ETH-paired BLACKOUT shows it: three moves into the edge zone without a single refusal, each
    read inconclusive at a 32–35% top share, each a full 15-minute halt.
- **One concentrated halt.** WORK's incident 3 was a −8.8% slide in which one sender did 80.8% of
  the window. Curb would have kept the pool shut for the full 15 minutes and pinned the pre-move
  reference.
- **A Sybil split, caught in the wild.** CABAL's first two blocks held six buys of 56.1 to 57.2 IMD
  from six different wallets. The same six sold within two blocks of each other 41 minutes later.
  - Both CABAL halts read organic, at a 12.5% and a 14.8% top share.
  - Counted as one actor, the six did 66.0% and 69.1% of those windows, which is concentrated.
  - Keyed by `tx.origin`, the rule cannot see this. FAILURE-MODES.md bounds the cost: the halt ends
    early and the reference re-centres, the same as the no-answer default, only sooner.
- **Dumps larger than the pool.** Four sells were bigger than all the paired currency on their
  side and slid the price to the end of the tick range. Curb refuses each of them whole; a smaller
  sale toward the reference would still pass.

## Data

All of it comes from the public RPC, `https://rpc.mainnet.chain.robinhood.com`.

- **Launches:** every `Launched` event of the LaunchFactory
  (`0xa25b02a1e93903b790e6aaf7da1b8b8d50294645`) from the block 30 days before the run's head.
  The factory's first launch was on 2026-10-06, so this is its whole history.
  - All pools are included, with no top-N cut.
  - `positionOf(launchNumber)` gives each pool key; the PoolId is `keccak256(abi.encode(key))`.
- **Opening tick:** the PoolManager's `Initialize` event in the launch block.
- **Swaps:** PoolManager `Swap` events per PoolId, from the launch block to the head.
  - They carry the post-swap tick and in-range liquidity, and the swapper's deltas.
  - Only swaps that succeeded are on chain. Anything a launch's own hook refused is not in the
    data.
- **Liquidity changes:** PoolManager `ModifyLiquidity` events per PoolId, including the factory's
  seed.
- **Time:** block timestamps. Swaps in one block share a timestamp and keep their log order.
- **Senders:** `tx.from` of every swap's transaction, which is the `tx.origin` CurbHook puts on its
  tape. Every sender is fetched; nothing is sampled.
  - They are read from the full block (`eth_getBlockByNumber` with transactions), not
    `eth_getTransactionByHash`. It is the same field, and the endpoint meters calls, so this takes
    half as many.

## Method: shadow replay

A breaker that refuses trades changes the market it watches. A refused trader splits the order,
waits or leaves, and nobody can know which. This replay does not try to invent that market.
Instead it lets the breaker watch the market that really happened:

- **Every real swap goes through `Breaker.swapFull`, in chain order,** with the pool's real tick and
  the liquidity flags described below.
- **A swap Curb would refuse (`OutsideBand`) is counted, then applied anyway** with the band check
  off for that one call. It stands for the same order split over time.
  - The price is where it really went.
  - The limit clock, rolls and halts react to that, exactly as the model's rules say.
- **A swap that arrives during a halt (`Halted`) is counted and held for the reopen.**
  - The price follows it.
  - It adds no reference sample, starts no limit clock and puts nothing on the tape.
  - So the halt closes on the price the market reopened at, like an exchange's reopening auction.
- **Halts need no swap.** A halt is recorded when the clock passes its start, whether or not anyone
  traded into it. A halt still running at the head is cut there.

So the counts answer one question: how often Curb would have said no to the trades that actually
happened. They do not simulate the market Curb would have produced.

### Liquidity

CurbHook treats in-range liquidity below `minLiquidity` as no market. Such prices never start the
limit clock, never roll the reference and are judged from where liquidity begins.

- **The floor is 7% of the launch's `liquiditySeeded`.** CURB's floor is 1e23, 7% of the
  1.427e24 a standard IMD-paired launch seeds. Seeds vary: 1.6e23 to 1.43e24 on IMD pairs, 7e22
  to 9e22 on ETH pairs. A fixed 1e23 would call every ETH-paired pool illiquid, so the ratio is what
  carries over.
- **Liquidity before a swap** is the previous swap's reported in-range liquidity, adjusted by any
  `ModifyLiquidity` in between. v4 counts a position at tick `t` when `lower <= t < upper`.
  **Liquidity after a swap** is the `Swap` event's own figure.
- **Where liquidity begins:** per-tick `liquidityGross` is rebuilt from `ModifyLiquidity`. It feeds
  the same 64-word bitmap walk as `CurbHook._liquidityBoundary`, for swaps that start below the
  floor.

### The tape and the verdict

- **The tape:** one entry per swap, `(tx.from, |paired-currency delta|)`.
  - It holds passed swaps and refused-then-applied ones.
  - It leaves out swaps that arrived during a halt.
- **The incident window** is what `CurbHook.incidentWindow()` would report at the halt: from the L2
  block where the previous reference window began to the last block on the tape. Windows shift on
  every roll, halt close and re-anchor, as `_shiftWindow` does.
- **The leader** is the sender with the largest summed volume in the window. A tie goes to the lower
  address.
- **The verdict** is `CurbDesk.classify(figure, total)`:
  - top share ≤ 30% → organic;
  - ≥ 60% → concentrated;
  - otherwise, or with no volume, inconclusive.
- **Landing the verdict:** the replay assumes a keeper files the incident at once, the desk can pay,
  and the oracle answers with the true leader. It lands 90 s after the halt starts, which is IMD's
  oracle's recent median from request to attestation.
  - Organic reopens the pool then.
  - Concentrated keeps the full halt and pins the pre-move reference through the cooldown.
  - Inconclusive changes nothing.
- **Oracle down:** the totals are reported a second time with no verdict ever applied, so every
  halt runs its full 15 minutes.

### Parameters

| | |
|---|---|
| band | 1,000 ticks (±10.5%) |
| edge zone | 100 ticks |
| reference window | 300 s |
| limit state | 15 s |
| halt | 900 s |
| cooldown | 1,800 s |
| liquidity floor | 7% of `liquiditySeeded` |
| verdict latency | 90 s |

They apply to every pool, whatever its own fee or hook. Launch 784 trades at 0.30% and the rest
at 1.25%.

## Caveats

- **Refusals come in runs.** Once the real price leaves the band, every further swap the same way
  is refused until the reference catches up, so one burst of buying can count dozens of times.
  The table's *breakouts* column counts the runs.
- **Traders would have adapted.** Refused buyers might have bought later and higher, or not at all.
  Arbitrage, MEV and gas are not modelled.
- **`tx.origin` is the trader.** Swaps routed through a shared bundler or relayer would merge into
  one sender and read as concentrated. That is the conservative outcome; see FAILURE-MODES.md. The
  other way round, one actor spread over several wallets reads as organic, as CABAL shows above.
- **Swaps larger than all the liquidity on their side** go all the way to the price limit,
  typically a holder dumping into a pool that has no paired currency left. Curb refuses them whole,
  and the table counts them among the refusals. The summary line reports them separately.
- **Time halted** is measured from launch to the run's head. Most launches go quiet after their
  first day, so the first-24-hour figure is the telling one.

## Rerun

```sh
pnpm --filter @curb/backtest start      # same as: pnpm --filter @curb/backtest run run
pnpm --filter @curb/backtest test       # replay and classification on a synthetic pool
pnpm --filter @curb/backtest typecheck
```

A bare `pnpm --filter @curb/backtest run` only lists the scripts, because the script is itself
named `run`.

- **Options** go after `--`: `--days 30`, `--to-block <L2 block>` to pin the head, `--latency 90`,
  `--rpc <url>`.
- **What a run writes:** `results/<date of the head block>.json`, and it regenerates the block
  between the `results` markers above.
- **The cache:** logs, block timestamps, senders and pool keys go to `.cache/` (gitignored). Later
  runs fetch only blocks past what is cached.
- **Timing:** a cold run takes about 2.5 minutes, held under the endpoint's rate limit of about
  20 calls a second. A warm run takes seconds.

**Key fields of the JSON:**

- `totals` and `totalsWithoutVerdicts`.
- Per pool:
  - `refused.{up, down, intoVoid, streaks, traders}`;
  - `haltList[]`, with each halt's window, leader, figure, total, `shareBps`, verdict and
    `swapsInside`;
  - `refusalList[]`, with each refused swap's transaction, sender, ticks, reference and limit.
- Bigints are decimal strings.
