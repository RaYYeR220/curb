# Failure modes

What can go wrong with Curb, what it costs, and where it stops. Numbers use the CURB/IMD
parameters:

| Parameter | Value |
|---|---|
| band | 1,000 ticks (about ±10.5%) |
| edge zone | 100 ticks |
| reference window | 5 min |
| limit state | 15 s |
| halt | 15 min |
| cooldown | 30 min |

## Halts and refusals

**Griefing by repeated halts.**
- **How:** an attacker pushes the price into the edge zone, waits 15 seconds, and the pool halts.
- **Cost:** at the opening liquidity a 9.5% push is about 105 IMD of buying. The attacker sells
  most of it back afterwards, so the real cost is the round-trip fee (2 × 1.25%) plus spread:
  roughly 3 IMD per halt. The cost scales linearly with the pool's liquidity. Near the opening
  price, launch 2266 has a far cheaper path: see "Waiting in the empty range" below.
- **Bound:** the next halt cannot start before halt + cooldown + limit (45 min 15 s) from the
  start of the last. Continuous griefing therefore keeps the pool halted at most a third of the
  time.
- **Trading during the cooldown:** the pool trades normally, with its band intact. Proven by
  invariants 1 and 2.

**A holder cannot sell through the band in one swap.**
- **The rule:** a swap that would end outside ±1,000 ticks of the reference, further from the
  reference than it started, is refused whole.
- **What it means for a seller:** a sale large enough to move the price more than about 10% has
  to be split, or wait for the reference to follow. It follows by up to 899 ticks per 5-minute
  window.
- **What always passes:** any swap that ends inside the band, and any swap toward the reference.
  Proven by invariant 4. This is the anti-honeypot property.

**Router swaps with a price limit at the end of the curve.**
- **The case:** aggregators often send exact-input swaps with `sqrtPriceLimit` at MIN or MAX. One
  that would cross the band is refused whole, not filled up to the band.
- **The remedy:** `curb preflight` and the router's `simulate` tell an integrator before sending,
  and decode the reason: `OutsideBand(ref, tickAfter, limit, zeroForOne)`.

**The pin after a Concentrated verdict.**
- **The rule:** when the oracle attests that one trader did at least 60% of the window's volume,
  the pool sits out the full 15-minute halt. It then reopens on the reference from before the
  move, pinned through the 30-minute cooldown.
- **How far the pin moves:** the pinned reference moves only far enough to take the price out of
  the edge zone, so there are always at least 101 ticks (about 1%) of room in the direction of the
  move.
- **What is refused during the pin:** swaps that would carry the price beyond that band. Swaps
  toward it pass.
- **The bound:** the longest any direction can be held near the band because of one incident is
  halt + cooldown (45 minutes), and only after a signed attestation.
- **After the pin:** the reference is rebuilt from post-reopen prices only. Pre-halt samples never
  return.

**A roll during the cooldown clears a deferred limit state.**
- **The case:** a price pressed into the edge zone during a cooldown cannot halt until the
  cooldown ends. If a reference roll comes first, it re-centres the band and the limit state ends.
- **Consequence:** the same rule as on stock exchanges, where the band moves with the reference.
  This means fewer halts during a cooldown, never more.

**Silent halts.**
- **The rule:** halts are a function of the clock, not of a keeper. A halt that starts and ends
  with nobody trading is still a halt; the first swap after it closes the incident.
- **Reading it:** `status()` reports every phase without a swap.

## Under the opening price: no market

**The situation.** A launch seeds single-sided CURB from the opening price up. Below it, on the
"CURB cheaper than launch" side, there is no liquidity in range, and moving the price costs
nothing.

**What Curb does there.** A range counts as having no market when its in-range liquidity is
below `minLiquidity` (1e23, about 7% of what the factory seeds). Such prices:
- never start the limit clock;
- never roll the reference;
- never become the reference when a halt closes there; a close keeps the reference instead;
- in code after launch 2266, are never sampled into the next reference: the window slides past
  time spent there.

The band still caps a free move at ±1,000 ticks.

### Waiting in the empty range

Launch 2266 runs the code tagged `launch-2266`, which averaged time spent in the empty range
into the next reference roll. The final review found it after the launch and proved it on a fork
of the live hook.
- **How:**
  1. A 1-wei CURB sell with a price limit 999 ticks into the empty range. It costs nothing:
     both deltas are 0, and no CURB is needed.
  2. Wait. On a pool that trades, one window is enough. On 2266, which had not rolled since its
     launch, the wait has to be comparable to the time since launch; 6 hours did it.
  3. Buy back into the launch liquidity, about 1 IMD, and one second later buy a little more.
     That swap rolls the reference about 830 ticks toward the empty price, buyers have about
     90 ticks of room left, and the limit state starts.
- **Effect:** 15 seconds later the pool halts for 15 minutes. Between halts, buys of more than
  about 1% are refused until a roll brings the reference back.
- **Cost:** about 2 IMD of buying, which the attacker keeps as CURB. The real cost is the
  round-trip fee, about 0.05 IMD, against about 3 IMD per halt anywhere else.
- **Bound:** the halt-spacing bound still holds: at most one halt per 45 minutes 15 seconds.
  Sells toward the reference always pass, so it is a nuisance, not a trap. Once the desk holds
  IMD, each such halt can also be filed for one question.
- **Fixed in code** (`75d1a6c`): where in-range liquidity is below `minLiquidity`, the elapsed time
  is not sampled and the window start moves past it. Tests:
  `test_voidTime_isNotSampled_cannotHaltReturningBuyers`,
  `test_voidTime_isNotSampled_cannotCapBuyers` and `test_voidTime_rollUsesOnlyLiquidTime`, plus
  regenerated differential traces.
- **On 2266:** the hook is immutable. Liquidity of at least `minLiquidity` across the band below
  the opening price would close the empty range. The review put that at about 8 IMD.

**The stranding attack, and why it fails.**
- **How it would work:** someone adds their own liquidity in the empty range, rolls the reference
  up into it a window at a time, then pulls the liquidity. The reference is left sitting where
  nothing trades.
- **Why it fails:** a swap that starts in such a range and crosses into liquidity is judged from
  the first initialised tick carrying at least `minLiquidity`, read from the PoolManager's tick
  bitmap, not from a reference it never traded against. If it lands within a band of that
  boundary it passes, and the reference re-anchors beside where it landed
  (`ReferenceReanchored`).
- **Result:** buyers can always cross back into the launch's liquidity.
- **Tests:** `test_voidStart_*`, `test_closeIlliquid_keepsReference`, `test_zeroLiquidity_*`.

**Dust doesn't count.** Liquidity below `minLiquidity` is not a market, so a 1-wei position
cannot start a halt (`test_dustBelowMinimum_isNotLiquidity`).

**What it costs instead.** Someone who adds at least `minLiquidity` of their own near the edge
can halt the pool by trading against themselves:
- **Capital:** about 1 IMD near the opening price, fully returned when they pull it.
- **Their position:** it offers CURB below the launch price to anyone who wants it.
- **The bound:** the halt-spacing bound above still holds, so the pool stays live at least two
  thirds of the time.
- **On launch 2266** waiting in the empty range is cheaper still and needs no capital at all;
  see above.

## The verdict

**Sybil split.**
- **How:** an actor spreads one move across many wallets. The top trader's share falls and the
  verdict reads Organic.
- **Worst case:** the halt ends early and the reference re-centres. That is the same re-centring
  the default (no answer) applies, only sooner.

**Faked concentration.**
- **How:** one wallet wash-trades to dominate a window, so an organic move reads Concentrated.
- **Worst case:** the bounded pin above (45 minutes), paid for with 1.25% fees on the wash volume.

**Shared `tx.origin`.**
- **The case:** the tape keys traders by `tx.origin`. Trades sent through a smart-wallet bundler
  share the bundler's origin and look concentrated.
- **Effect:** this lands on the conservative outcome, the pin.

**The oracle is down, late or split.**
- **What happens:** no verdict applies. The halt runs its full 15 minutes and the pool re-centres,
  which is the default.
- **Late answers:** an answer that lands after the halt is recorded on its incident and never
  applied to another one.
- **Failures:** a refused or failed request closes the incident as failed. The desk does not ask
  again, so a second payment is never made for one incident.

**The callback runs out of gas or is not delivered.**
- **Measured:** the Intake allows 200,000 gas; the verdict callback uses 102,468.
- **Fallback:** if delivery fails anyway, anyone can push the signed answer with
  `submitAttestation`.

**The question window is too fresh.**
- **The check:** the desk refuses to file until the window's last block is 8 L2 blocks deep
  (`WindowTooFresh`), because the oracle reads only settled blocks.
- **In practice:** on Robinhood Chain that is about two seconds after the last pre-halt trade.

## The desk

**Empty treasury.**
- **What happens:** filing reverts with `TreasuryShort(have, need)` and the default policy
  applies.
- **Where the money comes from:** IMD fees from the pool's LP share, or anyone's `fund`.

**Anyone can spend the treasury on incidents.**
- **The design:** filing is permissionless, so a griefer who halts the pool can also make the desk
  pay for the question.
- **The bound:** one question per incident, never more than `MAX_PRICE` (1 IMD), and on CURB/IMD
  at most one incident per 45 minutes.
- **The drill pool shares the treasury.** It is bound to the same desk and halts for 5 minutes
  with a 5-minute cooldown. Anyone can push it to its edge for under a cent and file the halt
  about every 10 minutes, so the drill can spend the launch pool's fees on questions about a demo
  pool. The deployed desk has no unbind. `curb watch` never files drill halts unless run with
  `--file-drill`, and `script/drill.sh` sends its filing step only while the desk holds no IMD.
  A later desk should give each pool its own budget.
- **Who gains:** the IMD goes to IMD's treasury, never to the griefer. Spending the treasury on
  incidents is what it is for.

**Steward trust.**
- **What the steward can do:** bind the launch pool and drill pools, and rotate the oracle key
  after a public 48-hour timelock. It can renounce.
- **What it cannot do:** withdraw, or point the desk at another Intake: the Intake is fixed at
  deployment. No function moves IMD except into IMD's Intake, for exactly one listed price capped
  at `MAX_PRICE`.
- **Oracle-key rotation:** a rotated key can sign verdicts, which only shorten halts or pin a
  level. It cannot move funds.
- **Why binding is steward-only:** a stranger can launch a decoy pool whose hook names this desk
  as owner and hand the desk its requester share.

**CURB fees are locked.**
- **The case:** the desk's LP share arrives in both IMD and CURB. IMD pays for incidents. CURB has
  no use in the desk, and there is no withdraw function.
- **Effect:** it stays there, which is the same as burned.

## Deployment

**The launch parks.**
- **The risk:** IMD's admission can refuse a launch after payment, and about 29% of hook launches
  park. There is no refund.
- **Mitigations:**
  - the protected suites pass locally in both token orders;
  - the exact `LaunchFactory.launch` call is rehearsed on a fork;
  - the free `POST /requests/check` must return no blockers before paying.

**No ArbSys.**
- **The case:** Robinhood Chain's `block.number` is Ethereum's, so the chain's own block number
  comes from ArbSys.
- **The fallback:** where ArbSys is absent (local tests, IMD's verifier) the read falls back to
  `block.number` instead of reverting a swap.

**One pool per hook.**
- **The rule:** the first initialisation from the launch factory binds the hook to its pool, and a
  second is refused.
- **Consequence:** the drill pool runs on its own hook instance.
