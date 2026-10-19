# Gas

Measured with `forge test --match-contract HookGasTest -vv` (solc 0.8.26, via-IR, 200 runs).

## Swap overhead

The same exact-input swap, in a fresh block with no reference roll due, on a CURB/IMD pool with
CurbHook and on an identical pool with no hook:

| | gas |
|---|---|
| swap with CurbHook | 204,766 |
| swap without a hook | 137,992 |
| **overhead** | **66,774** |

What the overhead pays for, per swap:

- two hook calls from the PoolManager (`beforeSwap`, `afterSwap`);
- three reads of pool state through `extsload` (in-range liquidity before and after, the tick after);
- the breaker's state: the last observation and the tick-seconds accumulator are updated on every
  swap, so the reference is a true time-weighted mean rather than a last-trade price;
- the volume tape: `totalVolume`, the block-start snapshot when the L2 block changes, one ArbSys
  read for the chain's own block number and one `Trade` event.

At Robinhood Chain's 0.02 gwei that is about 0.0000013 ETH per swap. A swap that rolls the
reference or closes a halt writes two more snapshots and costs more; those happen at most once per
reference window.

## Test effort

| Suite | Profile | Calls | Wall time |
|---|---|---|---|
| `CurbHookInvariants` (8 invariants) | default | 64 runs × 64 calls = 4,096 | ~2.6 s |
| `CurbHookInvariants` (8 invariants) | `deep` | 256 runs × 200 calls = 51,200 | ~37 s |
| `test_soak_longRandomWalk` | any | 3,000 seeded actions | included above |

The soak walk reaches 1,130 swaps, 478 refusals, 260 swaps refused by a halt, 150 closed halts and
47 applied verdicts, with every invariant checked at the end.

## The oracle callback

IMD's Intake calls `CurbDesk.onOracleResult` once, with a 200,000 gas stipend. A Concentrated
verdict that resolves the live halt uses **102,468 gas** in `test_callback_fitsIn200k`, including
the hook's `resolve` (14,108) and a reentrancy guard. That leaves about half the stipend as
margin. Signature check, replay mark, verdict record and the call into the hook all fit.

A swap that starts where nothing trades and is refused by the band walks the PoolManager's tick
bitmap to find the first real liquidity it crossed. That costs one read per bitmap word (256
spaced ticks), bounded at 64 words, and only on that rare path.
