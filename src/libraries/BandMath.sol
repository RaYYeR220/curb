// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @title The tick arithmetic behind a price band
/// @notice Pure helpers for Curb's band: where its limits are, whether a swap is refused, whether a
/// price sits in the edge zone, and how the reference moves. Everything is in ticks, so a band of
/// 1000 ticks is the same ±10.5% move at any price and in either token order.
library BandMath {
    /// @notice `x` limited to `[lo, hi]`.
    function clamp(int24 x, int24 lo, int24 hi) internal pure returns (int24) {
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }

    /// @notice How many ticks lie between `a` and `b`.
    function dist(int24 a, int24 b) internal pure returns (uint24) {
        int256 d = int256(a) - int256(b);
        return uint24(uint256(d < 0 ? -d : d));
    }

    /// @notice The band around `ref`, cut at the ticks v4 can represent.
    function limits(int24 ref, int24 band) internal pure returns (int24 lower, int24 upper) {
        int256 lo = int256(ref) - band;
        int256 hi = int256(ref) + band;
        lower = lo < TickMath.MIN_TICK ? TickMath.MIN_TICK : int24(lo);
        upper = hi > TickMath.MAX_TICK ? TickMath.MAX_TICK : int24(hi);
    }

    /// @notice Whether a swap from `tickBefore` to `tickAfter` is refused: it ends outside the band
    /// and further from the reference than it started.
    /// @dev The second half is the anti-honeypot half. A swap toward the reference is never refused,
    /// so a holder can always trade back toward where the market has been, whatever the band says.
    function refused(int24 ref, int24 band, int24 tickBefore, int24 tickAfter) internal pure returns (bool) {
        (int24 lower, int24 upper) = limits(ref, band);
        if (tickAfter >= lower && tickAfter <= upper) return false;
        return dist(tickAfter, ref) > dist(tickBefore, ref);
    }

    /// @notice Whether `tick` is within `edge` ticks of either band limit.
    function inEdge(int24 ref, int24 band, int24 edge, int24 tick) internal pure returns (bool) {
        return dist(tick, ref) >= uint24(band - edge);
    }

    /// @notice The time-weighted mean tick since `windowStart`, rounded toward negative infinity.
    /// @dev `cum` holds tick-seconds up to `lastObs`; the tick that has held since then is added up
    /// to `nowTs`. A window in which nothing traded for a whole `refWindow` gives the last tick, the
    /// only price that market has actually shown.
    function twap(int56 cum, int24 lastTick, uint64 lastObs, uint64 windowStart, uint64 nowTs, uint32 refWindow)
        internal
        pure
        returns (int24)
    {
        if (nowTs <= windowStart || nowTs - lastObs >= refWindow) return lastTick;
        int256 num = int256(cum) + int256(lastTick) * int256(uint256(nowTs - lastObs));
        int256 den = int256(uint256(nowTs - windowStart));
        int256 q = num / den;
        if (num % den != 0 && num < 0) q--;
        return int24(q);
    }

    /// @notice The reference after a roll: the TWAP, moved just far enough that `tick` sits inside
    /// the band and outside its edge zone.
    /// @dev Without the clamp a roll could leave the price outside its own band, refusing trades in
    /// one direction until the next roll. With it a roll alone can never strand the price or start a
    /// halt.
    function rollRef(int24 twapTick, int24 tick, int24 band, int24 edge) internal pure returns (int24) {
        int24 span = band - edge - 1;
        return clamp(twapTick, tick - span, tick + span);
    }

    /// @notice The pinned reference after an incident the swarm called concentrated: the reference
    /// from before the move, moved only as far as needed to keep `tick` inside the band.
    function pinRef(int24 edgeRef, int24 tick, int24 band) internal pure returns (int24) {
        return clamp(edgeRef, tick - band, tick + band);
    }
}
