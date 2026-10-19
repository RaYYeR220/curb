// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BandMath} from "./BandMath.sol";

/// @title A Limit Up–Limit Down circuit breaker for one pool
/// @notice The state machine behind CurbHook, kept free of anything Uniswap-specific so it can be
/// tested and replayed on its own: time, ticks and liquidity come in as arguments.
///
/// Equity markets have run the same rules since 2013. Price may not trade outside a band around a
/// moving reference. A price that sits at the edge of its band for a few seconds puts the market in
/// a limit state, and a limit state that does not resolve becomes a trading pause of fixed length.
/// Here:
///
/// - The reference is the time-weighted mean tick of the last window, rolled lazily on the first
///   swap after the window ends. A roll moves it only as far as keeps the current price inside the
///   band and out of the edge zone, so a roll on its own never refuses anything or starts a halt.
/// - A swap is refused when it would end outside the band further from the reference than it
///   started. A swap toward the reference always passes.
/// - A price in the edge zone for `limitSeconds` halts the pool in both directions. The halt is not
///   written anywhere: it is a function of when the limit state began and the clock, so it starts
///   on time even if nobody trades, and it ends on time with no keeper.
/// - The halt lasts `haltSeconds` at most. The owner may end it early (organic) or ask that the
///   reference stay where it was before the move (concentrated); it can never lengthen it.
/// - After a halt, the next one cannot start before `haltSeconds + cooldownSeconds + limitSeconds`
///   from the start of the last, counted from the scheduled end so an early reopen buys no slack.
///
/// Where the pool has no liquidity in range, as at the bottom of a single-sided launch position,
/// moving the price costs nothing. The band still caps such a move, but the limit clock and the
/// reference roll ignore it, so nobody can halt the pool or walk its reference for the price of gas.
library Breaker {
    enum Phase {
        Open,
        Limit,
        Halted,
        Cooldown
    }

    enum Verdict {
        None,
        Organic,
        Concentrated,
        Inconclusive
    }

    struct Config {
        int24 band;
        int24 edge;
        uint32 refWindow;
        uint32 limitSeconds;
        uint32 haltSeconds;
        uint32 cooldownSeconds;
    }

    struct State {
        int24 ref;
        int24 lastTick;
        /// @dev The reference in force when the current limit state began: the level a
        /// concentrated verdict pins.
        int24 edgeRef;
        /// @dev The current incident. Bumped when an incident closes.
        uint32 nonce;
        Verdict verdict;
        uint64 windowStart;
        uint64 lastObs;
        /// @dev Tick-seconds accumulated from `windowStart` to `lastObs`.
        int56 cum;
        /// @dev When the price entered the edge zone; zero when it is not there.
        uint64 edgeSince;
        uint64 cooldownEnd;
        /// @dev While non-zero the reference is pinned: no rolls and no limit clock until then.
        uint64 pinUntil;
        /// @dev When an organic verdict reopened the current halt; zero otherwise.
        uint64 reopenedAt;
    }

    struct Closed {
        bool happened;
        uint32 nonce;
        uint64 haltStart;
        uint64 haltEnd;
        Verdict verdict;
        int24 newRef;
        uint64 cooldownEnd;
    }

    struct Before {
        bool rolled;
        int24 twap;
        bool limitCleared;
        Closed closed;
    }

    struct After {
        bool refused;
        int24 limit;
        bool limitEntered;
        bool limitCleared;
        uint64 haltsAt;
    }

    error Halted(uint32 nonce, uint64 reopensAt);
    error NotHalted();
    error WrongIncident(uint32 expected, uint32 got);
    error AlreadyResolved();
    error BadVerdict();

    function init(State storage s, int24 tick, uint64 nowTs) internal {
        s.ref = tick;
        s.lastTick = tick;
        s.windowStart = nowTs;
        s.lastObs = nowTs;
    }

    /// @notice When the current incident's halt starts and ends; `(0, 0)` with no limit state.
    function halt(State storage s, Config memory c) internal view returns (uint64 start, uint64 end) {
        uint64 since = s.edgeSince;
        if (since == 0) return (0, 0);
        uint64 cooldownEnd = s.cooldownEnd;
        start = (since > cooldownEnd ? since : cooldownEnd) + c.limitSeconds;
        end = start + c.haltSeconds;
        uint64 reopenedAt = s.reopenedAt;
        if (reopenedAt != 0 && reopenedAt < end) end = reopenedAt;
    }

    function phase(State storage s, Config memory c, uint64 nowTs) internal view returns (Phase) {
        if (s.edgeSince != 0) {
            (uint64 start, uint64 end) = halt(s, c);
            if (nowTs < start) return Phase.Limit;
            if (nowTs < end) return Phase.Halted;
            // Over but not yet closed: closing is lazy, the cooldown is not.
            return nowTs < start + c.haltSeconds + c.cooldownSeconds ? Phase.Cooldown : Phase.Open;
        }
        return nowTs < s.cooldownEnd ? Phase.Cooldown : Phase.Open;
    }

    /// @notice The first half of a swap: refuse it during a halt, close a halt that has ended, roll
    /// the reference if its window is over, and account the time since the last swap.
    function beforeSwap(State storage s, Config memory c, uint64 nowTs, bool liquid)
        internal
        returns (Before memory b)
    {
        if (s.edgeSince != 0) {
            (uint64 start, uint64 end) = halt(s, c);
            if (nowTs >= start) {
                if (nowTs < end) revert Halted(s.nonce, end);
                b.closed = _close(s, c, nowTs, start, end);
            }
        }
        if (s.pinUntil != 0 && nowTs >= s.pinUntil) s.pinUntil = 0;
        if (s.pinUntil == 0 && liquid && nowTs >= s.windowStart + c.refWindow) {
            int24 t = BandMath.twap(s.cum, s.lastTick, s.lastObs, s.windowStart, nowTs, c.refWindow);
            s.ref = BandMath.rollRef(t, s.lastTick, c.band, c.edge);
            s.windowStart = nowTs;
            s.lastObs = nowTs;
            s.cum = 0;
            b.rolled = true;
            b.twap = t;
            if (s.edgeSince != 0) {
                s.edgeSince = 0;
                b.limitCleared = true;
            }
        }
        s.cum += int56(s.lastTick) * int56(uint56(nowTs - s.lastObs));
        s.lastObs = nowTs;
    }

    /// @notice The second half of a swap: judge where it left the price, then run the limit clock.
    /// @dev A refusal is reported, not reverted, so the caller can revert with an error that names
    /// the pool's own numbers. Nothing is written on that path.
    function afterSwap(State storage s, Config memory c, uint64 nowTs, int24 tickAfter, bool liquid)
        internal
        returns (After memory a)
    {
        int24 ref = s.ref;
        if (BandMath.refused(ref, c.band, s.lastTick, tickAfter)) {
            (int24 lower, int24 upper) = BandMath.limits(ref, c.band);
            a.refused = true;
            a.limit = tickAfter < ref ? lower : upper;
            return a;
        }
        s.lastTick = tickAfter;
        if (s.pinUntil == 0 && liquid) {
            bool edge = BandMath.inEdge(ref, c.band, c.edge, tickAfter);
            if (edge && s.edgeSince == 0) {
                s.edgeSince = nowTs;
                s.edgeRef = ref;
                a.limitEntered = true;
            } else if (!edge && s.edgeSince != 0) {
                s.edgeSince = 0;
                a.limitCleared = true;
            }
        }
        (a.haltsAt,) = halt(s, c);
    }

    /// @notice Applies a verdict to the halt in progress. It can end the halt now or pin the
    /// reference for the reopen; it cannot make the halt longer.
    function resolve(State storage s, Config memory c, uint64 nowTs, uint32 nonce, Verdict v)
        internal
        returns (uint64 reopensAt)
    {
        if (v != Verdict.Organic && v != Verdict.Concentrated) revert BadVerdict();
        if (phase(s, c, nowTs) != Phase.Halted) revert NotHalted();
        if (nonce != s.nonce) revert WrongIncident(s.nonce, nonce);
        if (s.verdict != Verdict.None) revert AlreadyResolved();
        s.verdict = v;
        if (v == Verdict.Organic) s.reopenedAt = nowTs;
        (, reopensAt) = halt(s, c);
    }

    function _close(State storage s, Config memory c, uint64 nowTs, uint64 start, uint64 end)
        private
        returns (Closed memory closed)
    {
        Verdict v = s.verdict;
        uint64 cooldownEnd = start + c.haltSeconds + c.cooldownSeconds;
        bool pin = v == Verdict.Concentrated;
        int24 newRef = pin ? BandMath.pinRef(s.edgeRef, s.lastTick, c.band) : s.lastTick;
        closed = Closed(true, s.nonce, start, end, v, newRef, cooldownEnd);
        s.ref = newRef;
        s.pinUntil = pin ? cooldownEnd : 0;
        s.cooldownEnd = cooldownEnd;
        // Halted time is never sampled: the next reference is built from the reopened market only.
        s.windowStart = nowTs;
        s.lastObs = nowTs;
        s.cum = 0;
        s.edgeSince = 0;
        s.reopenedAt = 0;
        s.verdict = Verdict.None;
        s.nonce++;
    }
}
