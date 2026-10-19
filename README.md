# Curb

Circuit breakers for Uniswap v4 pools.

Stock markets have run Limit Up–Limit Down since 2013. A price may not trade outside a band around
where it has recently traded, and a price that presses against the band pauses the market for a
few minutes. Curb is that rule as a v4 hook, on Robinhood Chain, launched through
[Identity MD](https://imd.fun).

- **Refused, with a reason.** A swap that would end outside the band, further from the reference
  than it started, reverts with `OutsideBand(ref, tickAfter, limit, zeroForOne)`. A swap back
  toward the reference always passes.
- **Bounded halts.** A price held at the band's edge for 15 seconds halts the pool in both
  directions for at most 15 minutes. The halt ends on its own, and a 30-minute cooldown spaces
  the next one.
- **Agents measure, contracts decide.** During a halt the pool's desk asks the IMD oracle one
  question about its own trade tape: which trader moved the most volume, and how much. The answer
  is signed. Code turns the share into a verdict:
  - **≤ 30%:** organic; reopen now.
  - **≥ 60%:** one actor; sit out the halt and keep the pre-move price.
  - **otherwise:** no change.

  The swarm can shorten a halt or decline to bless a level. It can never lengthen a halt or touch
  funds.
- **No strandings below the launch price.** Where nothing trades, prices don't count: they never
  start a halt or roll the reference. A swap from there into real liquidity is judged from where
  that liquidity begins. One gap shipped in launch 2266: time spent there was still averaged into
  the next reference, which makes a cheap halt possible near the opening price. It is fixed in
  code since, and priced in [FAILURE-MODES.md](FAILURE-MODES.md#waiting-in-the-empty-range).

## How it works

```
             swap ──▶ CurbHook.beforeSwap ── halted? ──▶ revert Halted(nonce, reopensAt)
                       │  roll the reference if its window is over
                       ▼
                    PoolManager swaps
                       │
             CurbHook.afterSwap ── outside the band and further? ──▶ revert OutsideBand(...)
                       │  record Trade(tx.origin, volume), run the 15 s limit clock
                       ▼
                     settled

 halt ──▶ CurbDesk.fileIncident ──▶ IMD Intake (0.5 IMD) ──▶ oracle panel ranks the Trade tape
                                                                     │ EIP-712 attestation
 CurbHook.resolve(nonce, verdict) ◀── rule: top share vs total ◀── CurbDesk.onOracleResult
```

| Contract | Role |
|---|---|
| `CurbHook` | The breaker: one per pool, immutable, owner = the desk, one power (`resolve`). |
| `CurbDesk` | Pays IMD for the launch, earns the launch's LP-fee share, files incidents, applies verdicts. No withdraw function. |
| `CurbToken` | CURB: 1,000,000,000 fixed supply, no owner. |
| `libraries/Breaker` | The state machine (limit, halt, close, cooldown, pin), testable on its own. |
| `libraries/BandMath` | Tick arithmetic: band limits, refusal rule, time-weighted reference, clamps. |
| `tools/CurbRouter` | Swap, add liquidity, and `simulate` a swap to read the hook's answer before sending. Not launched. |

### Parameters

| | CURB/IMD | Drill pool |
|---|---|---|
| band | 1,000 ticks (±10.5%) | 300 ticks |
| edge zone | 100 ticks | 60 ticks |
| reference window | 5 min | 2 min |
| limit state | 15 s | 10 s |
| halt (max) | 15 min | 5 min |
| cooldown | 30 min | 5 min |

The pool is CURB/IMD with the static 1.25% fee and tick spacing 60, seeded by IMD's LaunchFactory.

## Live on Robinhood Chain

- **App:** [curb-bay.vercel.app](https://curb-bay.vercel.app): a live board, "try to break it" against
  the real pool through `eth_call`, incidents, and a launch builder for your own token.
- **MCP server:** `https://curb-bay.vercel.app/mcp` (Streamable HTTP), or run
  [apps/mcp](apps/mcp) locally. [skill/SKILL.md](skill/SKILL.md) teaches an agent to trade on a Curb pool.
- **Backtest:** [backtest/](backtest): every IMD launch pool on Robinhood replayed through the breaker.

| | Address |
|---|---|
| CURB/IMD hook (IMD launch [2266](https://api.imd.fun/launches/9ed20a51-ec83-49e3-9e05-550c36540df7)) | [`0xEBF7ac7660aD0e0C6fB5061866cd45a4d31520c0`](https://robin.etherscan.io/address/0xEBF7ac7660aD0e0C6fB5061866cd45a4d31520c0) |
| CURB | [`0x5d289Ef8d8faE12Bb6cE394929260f647e362234`](https://robin.etherscan.io/token/0x5d289Ef8d8faE12Bb6cE394929260f647e362234) |
| CurbDesk | [`0xa4dF8fbf3A1aB94795577c74fFae26E1d2083819`](https://robin.etherscan.io/address/0xa4dF8fbf3A1aB94795577c74fFae26E1d2083819) |
| Drill hook (DRILL/ETH) | [`0xeE60C95711F5650bbBBee421426820feC6e060c0`](https://robin.etherscan.io/address/0xeE60C95711F5650bbBBee421426820feC6e060c0) |
| CurbRouter | [`0x040B0f37e4CcdB79e4A2cdA7a894800bbe73eD45`](https://robin.etherscan.io/address/0x040B0f37e4CcdB79e4A2cdA7a894800bbe73eD45) |

The CURB/IMD hook, CURB, the desk, the drill hook, the router and the drill token are source-verified on [Sourcify](https://sourcify.dev/#/lookup/0xa4dF8fbf3A1aB94795577c74fFae26E1d2083819).

The desk paid IMD's `launch.open` itself
([tx](https://robin.etherscan.io/tx/0x5ac4c9d4473b061caa6c01665e288df0a3355a424984033c05132a4da9275d93)),
so it is the launch's requester and its hook's owner, and it is bound to the pool
([tx](https://robin.etherscan.io/tx/0x527a73ad76619223b40f4ca48decb5aa05e6c5f85e538e27df708daa0fd83e5d)).
On CURB/IMD, a 500 IMD buy was refused on chain:
[`OutsideBand(-128999, -124993, -127999, false)`](https://robin.etherscan.io/tx/0xa2afe6c89a71f51d01fc41210e0bfa1ac0475a0e8d8e31e444df68d6910de917).
(The first launch parked on a false positive in IMD's bytecode scan; see [CLAIMS.md](CLAIMS.md#the-first-launch).)

The drill pool runs the same hook with short timings, and ran every refusal on chain:

| What happened | Transaction |
|---|---|
| A swap through the band, refused: `OutsideBand` | [`0xb650a395…`](https://robin.etherscan.io/tx/0xb650a39530addc0b7e9af4ff8246d0eddd1778d3d77201549134b3088480ebb4) |
| The price at the edge: `LimitEntered` | [`0x54fe7b43…`](https://robin.etherscan.io/tx/0x54fe7b43a44a0e179d8ff4d97d12a6039e8fd0cfb619dc590d48d49654c6d4f8) |
| Ten seconds later, any swap refused: `Halted` | [`0x2d3d543c…`](https://robin.etherscan.io/tx/0x2d3d543cb871e7c03f9caf71e7ffac3944ea308861e071b9b23eb5fb8522026b) |
| An incident the desk cannot pay for, refused: `TreasuryShort` | [`0xb5e73919…`](https://robin.etherscan.io/tx/0xb5e739198e9868f42f2510264755d495e42f1ff8202eadc889d3fac1cfe79ab7) |
| The halt ends on its own, with no keeper: `HaltClosed` | [`0x9de3edbe…`](https://robin.etherscan.io/tx/0x9de3edbec3a9433a18919fac13b2344760c04e1adcb166967fc20e7bbe15a9dd) |

Every claim and the transaction or test behind it is in [CLAIMS.md](CLAIMS.md);
`node script/claims-check.mjs` checks them all. `bash script/drill.sh` replays the drill.

## Verify it

```sh
forge test                         # 199 tests: unit, fuzz, 8 invariants, soak, oracle conformance,
                                   # and the TypeScript model replayed against the Solidity breaker
bash script/protected.sh           # IMD's univ4_hook admission suites, 13/13
bash script/protected.sh above     # the same with CURB sorting above IMD
RH_RPC=https://rpc.mainnet.chain.robinhood.com \
  forge test --match-contract LaunchRehearsal -vv   # the launch, rehearsed on live Robinhood state
```

- **The invariants** (`test/invariant/`) hold under random trading, clock moves, verdicts, fee
  collects and stray callback calls:
  1. no halt longer than its maximum;
  2. halts spaced by halt + cooldown + limit;
  3. a verdict never lengthens a halt;
  4. outside a halt, no swap that ends in the band or moves toward the reference is refused;
  5. the price is always inside the band;
  6. the factory's fee collect always succeeds;
  7. only the PoolManager drives callbacks;
  8. on-chain volume equals the sum of the tape.
- **The fork rehearsal** has IMD's launch wallet call the live LaunchFactory with this exact code,
  then trades, refuses, halts, files an incident through the live Intake and has it answered by
  the Intake's own `complete`. Details are in [docs/VERIFICATION.md](docs/VERIFICATION.md).
- **Further reading:**
  - [FAILURE-MODES.md](FAILURE-MODES.md): what each adversarial strategy costs and where it stops;
  - [SECURITY.md](SECURITY.md): the self-assessment against the Uniswap Foundation's hooks
    security framework;
  - [docs/GAS.md](docs/GAS.md): measured costs.

## Built on

- [OpenZeppelin uniswap-hooks v1.3.0-rc.0](https://github.com/OpenZeppelin/uniswap-hooks).
  rc.0 adds an opt-in `onlyValidPools` modifier and documents that a hook keeping per-pool state
  must check the pool itself. Curb serves exactly one pool, fixed at initialisation, so that check
  lives in `beforeInitialize`.
- [Uniswap v4-core](https://github.com/Uniswap/v4-core), at the commit uniswap-hooks pins.
- [IMD's oracle consumer library](https://imd.fun/docs), copied unchanged into `src/oracle/`. A
  signature from the live oracle is verified against it in `test/oracle/RealAttestation.t.sol`.

## License

MIT
