# Claims

Every claim Curb makes, and where to check it. Transactions are on Robinhood Chain
([robin.etherscan.io](https://robin.etherscan.io)). Tests run with `forge test` unless noted.
`node script/claims-check.mjs` confirms that every transaction below exists with the stated outcome
and that every test name exists in the suite.

## Live on Robinhood Chain

| Claim | Evidence |
|---|---|
| CURB/IMD is live as IMD launch 2266, with this hook, and bound to the desk | tx `0x527a73ad76619223b40f4ca48decb5aa05e6c5f85e538e27df708daa0fd83e5d` (succeeded: `Bound`) |
| On the CURB/IMD pool, a buy that would leave the band is refused, with the reason on chain | tx `0xa2afe6c89a71f51d01fc41210e0bfa1ac0475a0e8d8e31e444df68d6910de917` (failed: `OutsideBand(-128999, -124993, -127999, false)`) |
| A swap that would leave the band is refused, with the reason on chain | tx `0xb650a39530addc0b7e9af4ff8246d0eddd1778d3d77201549134b3088480ebb4` (failed: `OutsideBand`) |
| A price that reaches the band's edge zone enters a limit state | tx `0x54fe7b43a44a0e179d8ff4d97d12a6039e8fd0cfb619dc590d48d49654c6d4f8` (succeeded: `LimitEntered`) |
| A limit state that holds halts the pool in both directions | tx `0x2d3d543cb871e7c03f9caf71e7ffac3944ea308861e071b9b23eb5fb8522026b` (failed: `Halted`) |
| The desk will not file an incident it cannot pay for, and says why | tx `0xb5e739198e9868f42f2510264755d495e42f1ff8202eadc889d3fac1cfe79ab7` (failed: `TreasuryShort(0, 0.5 IMD)`) |
| A halt ends on its own at its maximum, with no keeper | tx `0x9de3edbec3a9433a18919fac13b2344760c04e1adcb166967fc20e7bbe15a9dd` (succeeded: `HaltClosed`, phase cooldown) |
| The desk paid IMD's `launch.open` itself: it is the payer, requester and hook owner | tx `0x01c6be368e6b206308a9f0b82bdb7375d352e44930865604a723a83cafada7a2` (succeeded: Intake `Requested`, 0.5 IMD; launch 2255, parked) and tx `0x5ac4c9d4473b061caa6c01665e288df0a3355a424984033c05132a4da9275d93` (succeeded: the relaunch, 0.5 IMD) |

The CURB/IMD hook is `0xEBF7ac7660aD0e0C6fB5061866cd45a4d31520c0`. The five drill transactions ran on the DRILL/ETH pool, on the same `CurbHook` code with short
timings (band 300 ticks, limit 10 s, halt 5 min). Hook `0xeE60C95711F5650bbBBee421426820feC6e060c0`.

## Proven by tests

| Claim | Test |
|---|---|
| A swap toward the reference is never refused, and outside a halt a swap that ends in the band never is | `invariant_4_liveness_noHookRevertOnTowardOrInBandOutsideHalt`, `testFuzz_refused_neverTowardReference` |
| The price is always inside the band | `invariant_5_priceAlwaysInsideBand`, `testFuzz_rollRef_keepsTickInsideBandOutsideEdge` |
| No halt lasts longer than its maximum | `invariant_1_haltNeverLongerThanHaltSeconds` |
| Halts are spaced by halt + cooldown + limit | `invariant_2_haltStartsSpaced`, `test_nextHaltSpacing_atLeast_halt_plus_cooldown_plus_limit` |
| A verdict can only shorten a halt or pin a level, never lengthen a halt | `invariant_3_resolveNeverExtends`, `testFuzz_resolve_neverExtends` |
| The launch factory's fee collect always works with the hook live | `invariant_6_collectAlwaysSucceeds`, `test_theFactoryCollectsItsFeesWithTheHookLive` (IMD's suite, `script/protected.sh`) |
| Only the PoolManager can drive the hook | `invariant_7_onlyPoolManager`, `test_callbacksRefuseCallersOtherThanThePoolManager` |
| On-chain volume equals the sum of the `Trade` tape, block for block | `invariant_8_totalVolumeEqualsTradeSum`, `test_volume_sameBlockRoll` |
| Nothing parked below the opening price can lock buyers out | `test_voidStart_strandedReferenceIsEscapable`, `test_closeIlliquid_keepsReference` |
| Dust liquidity cannot start a halt | `test_dustBelowMinimum_isNotLiquidity` |
| Time where nothing trades is not sampled into the reference (code after launch 2266; see FAILURE-MODES) | `test_voidTime_isNotSampled_cannotHaltReturningBuyers`, `test_voidTime_isNotSampled_cannotCapBuyers`, `test_voidTime_rollUsesOnlyLiquidTime` |
| IMD leaves the desk only as an exact Intake price, never more than `MAX_PRICE` | `testFuzz_noTokenLeavesExceptIntakePrice`, `test_launch_priceAboveCapRefused`, `test_file_priceAboveCapRefused` |
| Only the steward can bind a pool to the desk | `test_bind_onlySteward` |
| One question per incident, even if something calls back | `test_file_reentryFromFeeClaimFilesOnce`, `test_file_oncePerNonce` |
| The desk's verdict rule: ≤30% organic, ≥60% concentrated, in between inconclusive | `test_settle_boundary_3000Organic`, `test_settle_boundary_3001Inconclusive`, `test_settle_boundary_5999Inconclusive`, `test_settle_boundary_6000Concentrated` |
| A late answer is recorded and never applied to another incident | `test_answer_lateAfterHaltClosed_recordedNotApplied`, `test_answer_forOldNonce_neverTouchesNewIncident` |
| The verdict callback fits IMD's 200,000 gas stipend | `test_callback_fitsIn200k` |
| The question the desk asks is the one the oracle hashes | `test_file_bodyGolden`, `test_protocolVectorHash` |
| The oracle library verifies a signature the live IMD oracle produced | `test_realSignatureFromLiveOracle` |
| The desk reproduces IMD's consumer conformance vector | `test_digestMatchesTheProtocol`, `test_callbackSelectorIsCanonical` |
| IMD's own admission suites pass in both token orders | `script/protected.sh`, `script/protected.sh above` (13/13 each) |
| The exact launch call works against IMD's live contracts | `test_rehearsal_curbBelowImd`, `test_rehearsal_curbAboveImd` (with `RH_RPC`) |
| The TypeScript model the backtest and the web app use matches the Solidity breaker | `test_trace_1` … `test_trace_5` (2,000 steps) |
| A fork of the chain cannot make a swap burn its gas on ArbSys | `test_l2Block_forkedArbSysCostsBoundedGas` |

## Not live yet

- **A swarm verdict on a real halt.** The whole path is wired: filing, the oracle question, the
  signed answer, the rule and the hook's `resolve`. It is tested against a mock Intake, and on a
  fork against IMD's real Intake, which delivered the verdict inside its real 200,000 gas stipend
  (`docs/VERIFICATION.md`). It
  has not run live because each question costs 0.5 IMD and the desk's treasury is empty. It fills
  from the CURB/IMD pool's LP fees, or from anyone's `fund`. The drill's `TreasuryShort`
  transaction above is that state, on chain.
- **The post-mortem job.** Tested against a mock Intake only. It runs once the treasury holds two
  question prices.

## The first launch

Launch 2255, from `faea5be`, passed IMD's provenance, findings, review, manifest, protected-invariant
and economics checks and parked on the bytecode check: `CurbDesk contains DELEGATECALL`. The desk has
none. The compiler stores three 32-byte constants after the desk's final `INVALID`, the topic of
`ResultDelivered` ends in `0xf4`, and a linear scan of the code reads that byte as an opcode. The
check covers contracts under `src/`, and the desk is not part of the launch, so it moved to `desk/`
(`335beee`). Its bytecode is unchanged (`cast code` on the desk matches the build), and the hook and
token are byte-identical to 2255's. Launch 2266 from that commit passed all seven checks
(`bytecode: 10 contract(s) clean and reproducible`) and went live.
