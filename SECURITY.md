# Security

Curb's self-assessment against the Uniswap Foundation's
[Hooks Security Framework](https://github.com/uniswapfoundation/security-framework). Scores follow
the framework's own dimensions and brackets; higher means more risk.

## Scope

| Contract | What it is | Holds funds |
|---|---|---|
| `src/CurbHook.sol` | Uniswap v4 hook, one per pool | no |
| `desk/CurbDesk.sol` | Pays IMD, owns the hooks, buys oracle verdicts | IMD treasury (LP fees, top-ups) |
| `src/CurbToken.sol` | Fixed-supply ERC-20 launched with the pool | n/a |
| `src/libraries/*` | Band math, the breaker state machine, L2 block number | n/a |

`src/tools/` (a router and a drill token for demos) is not part of the launch and holds nothing.
`desk/` is deployed from the steward's wallet, not by the launch, so it sits outside the `src/` tree
the launch builds.
`src/oracle/` is IMD's canonical oracle library, copied unchanged.

## Risk dimensions

| Dimension | Score | Why |
|---|---|---|
| Complexity | 3 / 5 | Three callbacks; a four-phase state machine (open, limit, halted, cooldown); two verdict paths. No modes, no configuration after deploy. |
| Custom math | 2 / 5 | A time-weighted mean tick with floor division, and clamps. No curve, no fee formula, no exponentials. |
| External dependencies | 1 / 3 | The hook reads only the PoolManager and ArbSys. The desk depends on IMD's Intake and oracle, but a verdict can only shorten a halt or pin a level; it cannot extend a halt or move funds. |
| External liquidity exposure | 0 / 3 | The hook holds no tokens and moves none. |
| TVL potential | 1 / 5 | A launch pool opened at a 2,500 IMD market cap. |
| Team maturity | 3 / 3 | New project, built for the Identity MD hackathon. |
| Upgradeability | 0 / 3 | No proxy, no admin over code or parameters. |
| Autonomous parameter updates | 1 / 3 | The reference moves on its own each window; every parameter is immutable. |
| Price impacting behavior | 2 / 3 | Refuses swaps and halts the pool. Never changes a price, fee or delta. |
| **Total** | **13 / 33** | **Medium tier** |

**Feature trigger: price impacting behavior.** Curb influences the execution path: it refuses
swaps and halts the pool. The framework asks for simulation of worst-case economic and
adversarial price manipulation. That is what the invariant suite and the soak walk do (below), and
`FAILURE-MODES.md` prices each adversarial strategy.

## What was done

- **Tests.** 188 Foundry tests: unit, fuzz, eight stateful invariants, a 3,000-action seeded soak
  walk and the oracle conformance vector. The soak walk reaches 150 closed halts, 478 refusals and
  47 applied verdicts.
- **IMD's admission floor.** IMD's own `univ4_hook` protected suites, 13 of 13 in both token
  orders (`script/protected.sh`).
- **The live oracle signature.** A signature produced by IMD's live oracle verifies against the
  vendored library.
- **Fork rehearsal.** IMD's launch wallet calls the real LaunchFactory with this code on Robinhood
  Chain, and the real Intake delivers a verdict (`docs/VERIFICATION.md`).
- **Review.** A self-audit against a catalogue of known exploit chains (v4-hook reentrancy, oracle
  and TWAP manipulation, donation and reserve desync, transient-storage contamination), Slither,
  and an independent review with working proofs of concept. Every finding was fixed with a
  regression test that fails without the fix:
  - **High:** below the opening price, a halt closing in an empty range, or a reference rolled
    up over someone's temporary liquidity, could leave the reference where nothing trades and
    refuse buys for good. Fixed by the no-market rules and boundary judging in
    `FAILURE-MODES.md`.
  - **Medium:** dust liquidity counted as a market, so a 1-wei position could halt the pool.
    Fixed with the `minLiquidity` floor.
  - **Medium:** rotating the desk's Intake was a delayed withdrawal path. Fixed: the Intake is
    immutable and every request is capped at `MAX_PRICE`.
  - **Low:** leaving the edge zone into an empty range did not clear the limit clock.
  - **Low:** a Concentrated pin could leave no room to trade in the direction of the move; it
    now always leaves the edge zone clear.
  - **Low:** a zero figure read as organic.
  - **Desk:** `bind` was open to anyone, so a decoy launch could take the pool slot; and an
    incident was marked filed only after external calls.
- **IMD's admission.** IMD's swarm audits the repository before it deploys anything: provenance,
  findings and independent review.
- **Not done.** There is no external human audit and no funded bug bounty.

## Core controls

- **Access control.**
  - The hook's only privileged function is `resolve`, callable by its owner, the desk. The owner
    is immutable and has no transfer function.
  - The desk's steward can bind pools, rotate the oracle key behind a 48-hour timelock, and
    renounce. It cannot withdraw, and the Intake is fixed at deployment.
- **Callbacks.** Every hook callback is PoolManager-only (`BaseHook.onlyPoolManager`). The desk's
  Intake callbacks are Intake-only. `submitAttestation` is open, and is bound by signature, the
  pinned question hash and the panel size.
- **Reentrancy.**
  - The hook makes no state-changing external calls; it reads the PoolManager and ArbSys only.
  - The desk's paying functions are `nonReentrant`, and an incident is marked filed before any
    external call.
- **Checks-effects-interactions.**
  - A refused swap writes nothing; the revert is in `afterSwap`, before any settlement.
  - The desk records state before paying.
- **OpenZeppelin.** BaseHook (uniswap-hooks v1.3.0-rc.0), ERC20, SafeERC20, ReentrancyGuard,
  Math, Strings, EIP712 and SignatureChecker.
- **Griefing.** Halts are bounded and spaced, the limit clock ignores zero-liquidity moves, and
  the desk files one question per incident. See `FAILURE-MODES.md`.

## Accounting safety

- **No deltas.** The hook returns no delta, so delta conservation is v4's own.
- **The volume tape.** `totalVolume` equals the sum of all `Trade` events (invariant 8). Window
  snapshots are block-aligned, so an on-chain total matches a log query over the same blocks.
- **Rounding.** The time-weighted mean rounds toward negative infinity, like Uniswap's oracle. The
  verdict share uses `Math.mulDiv`.
- **Bounded state.** Fixed slots per pool and per incident. Nothing grows with the number of swaps.
- **Token transfers.** All go through `SafeERC20`; approvals are `forceApprove` for exactly one
  price.

## Upgradeability

None. Everything is immutable once deployed, including the desk's Intake. The desk can point at
a new oracle key only after a public 48-hour timelock, and the steward can renounce even that.

## Reporting a vulnerability

Open a private security advisory on this repository (Security → Report a vulnerability).
