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
  halt the pool or move its reference. A swap from there into real liquidity is judged from where
  that liquidity begins.

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

## Verify it

```sh
forge test                         # 186 tests: unit, fuzz, 8 invariants, soak, oracle conformance
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
