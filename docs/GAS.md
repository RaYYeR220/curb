# Gas

Measured with `forge test --match-contract HookGasTest -vv` (solc 0.8.26, via-IR, 200 runs).

## Swap overhead

The same exact-input swap, in a fresh block with no reference roll due, on a CURB/IMD pool with
CurbHook and on an identical pool with no hook:

| | gas |
|---|---|
| swap with CurbHook | 204,299 |
| swap without a hook | 137,992 |
| **overhead** | **66,307** |

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
