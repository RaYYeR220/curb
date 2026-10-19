# Verification

How to check every claim about Curb's contracts yourself, and what we saw when we did.

## Offline

```sh
forge test                       # unit, fuzz, invariant, conformance, live-signature tests
bash script/protected.sh         # IMD's univ4_hook protected suites, CURB sorting below IMD
bash script/protected.sh above   # the same with CURB sorting above IMD
```

- **`forge test`** runs offline in any order. The fork rehearsal skips without `RH_RPC`.
- **The protected suites** are IMD's own admission floor, run against the exact creation code a
  launch deploys, with the verifier's probes for `$token`, `$factory` and `$owner`:
  - `Hook.protected.t.sol`: 4 passed;
  - `Owners.protected.t.sol`: 2 passed;
  - `Token.protected.t.sol`: 7 passed;
  - 0 skipped in either token order.
- **The live oracle signature.** `test/oracle/RealAttestation.t.sol` checks a signature the IMD
  oracle actually produced (request `2f590561…`, signer `0x5598…2982`) against the
  `OracleAttestation` library Curb ships. `test/oracle/DeskConformance.t.sol` reproduces the
  protocol's conformance vector with CurbDesk deployed at the vector's address.

## Fork rehearsal of the launch

```sh
RH_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract LaunchRehearsal -vv
```

Run on 2026-10-19 18:13 UTC against Robinhood Chain at L2 block 92,825,234, using IMD's live
contracts throughout:

| Contract | Address |
|---|---|
| LaunchFactory | `0xa25b02a1e93903b790e6aaf7da1b8b8d50294645` |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Intake v2 | `0xa43e6f75ee006411f79ac1c84120606c2330de82` |
| IMD | `0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127` |

The template is IMD's own `LaunchFactory.launch` call for launch #2185, a hook launch paired with
IMD (`test/fixtures/kept-launch-input.hex`, read from transaction `0x5ee8ceaa…6aee`). Only what
makes the launch ours is replaced:

- the token and hook creation code;
- a hook salt mined for flags `0x20C0`;
- `poolBps` 9000;
- the desk as requester, remainder recipient and hook owner;
- the opening price for a 2,500 IMD market cap;
- the single-sided seed range.

Both token orders pass:

| | CURB above IMD | CURB below IMD |
|---|---|---|
| launch transaction gas | 5,812,207 | 5,794,538 |
| EIP-7825 cap | 16,777,216 | 16,777,216 |
| result | pass | pass |

Each run checks, in order:

1. **The launch.** IMD's launch wallet sends `LaunchFactory.launch` and it succeeds:
   - the factory deploys CURB and CurbHook;
   - the pool initialises through the hook's `beforeInitialize` from the factory;
   - the factory seeds it.
2. **Ownership.** `hook.owner()` is the desk and `positionOf(n).requester` is the desk. The desk
   binds the launch.
3. **Trading** through the live PoolManager:
   - ETH is swapped for IMD on the IMD/ETH pool;
   - CURB is bought and sold;
   - an order that would carry the price through the band is refused with `OutsideBand`.
4. **Fees.** `LaunchFactory.claimFees` runs with the hook live, and the desk receives its 80%
   requester share in IMD.
5. **The halt.** Price pressed into the edge zone gives phase `Limit`. Fifteen seconds later a swap
   is refused with `Halted`.
6. **The incident.** `desk.fileIncident` sweeps fees and pays 0.5 IMD through the real Intake's
   `requestWithFailure`.
7. **The verdict.** The Intake's writer calls `complete`, and the callback is delivered within the
   real 200,000 gas stipend: the event reads `Completed(…, delivered: true)`.
   - The answer is a Concentrated attestation (70% of the window's volume from one trader).
   - The hook's verdict becomes Concentrated.
8. **The reopen.** After the full halt the next swap closes the incident. The reference is pinned
   to the level from before the move, through the cooldown.

## What the rehearsal caught

- **ArbSys on a fork.** It answers with the fork block's L2 number and does not advance with
  `vm.roll`, while `block.number` is Ethereum's. The rehearsal advances the L2 block number the
  way the chain would before filing; on the live chain blocks arrive about four times a second.
- **Delegated test keys.** Well-known test keys carry EIP-7702 delegations on live chains, so a
  signature from one goes down `SignatureChecker`'s ERC-1271 path and fails. The rehearsal signs
  with a key of its own. IMD's oracle signer `0x5598…2982` is a plain EOA on Robinhood Chain and
  on Ethereum (checked with `cast code`).
