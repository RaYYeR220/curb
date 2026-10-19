// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BandMath} from "../src/libraries/BandMath.sol";

contract BandMathTest is Test {
    function test_clamp() public pure {
        assertEq(BandMath.clamp(5, -3, 3), 3);
        assertEq(BandMath.clamp(-5, -3, 3), -3);
        assertEq(BandMath.clamp(1, -3, 3), 1);
    }

    function test_dist() public pure {
        assertEq(BandMath.dist(-100, 250), 350);
        assertEq(BandMath.dist(250, -100), 350);
        assertEq(BandMath.dist(7, 7), 0);
    }

    function test_limits_saturateAtTickBounds() public pure {
        (int24 lower, int24 upper) = BandMath.limits(TickMath.MAX_TICK - 10, 1000);
        assertEq(lower, TickMath.MAX_TICK - 1010);
        assertEq(upper, TickMath.MAX_TICK);
        (lower, upper) = BandMath.limits(TickMath.MIN_TICK + 10, 1000);
        assertEq(lower, TickMath.MIN_TICK);
        assertEq(upper, TickMath.MIN_TICK + 1010);
    }

    function test_refused_outsideAndFurther() public pure {
        assertTrue(BandMath.refused(0, 1000, 900, 1001));
        assertTrue(BandMath.refused(0, 1000, -900, -1001));
    }

    function test_refused_outsideButCloser_passes() public pure {
        // A price stranded outside the band may always move back toward the reference.
        assertFalse(BandMath.refused(0, 1000, 1500, 1200));
    }

    function test_refused_insideBand_passes() public pure {
        assertFalse(BandMath.refused(0, 1000, 0, 1000));
        assertFalse(BandMath.refused(0, 1000, 0, -1000));
    }

    function test_inEdge() public pure {
        assertTrue(BandMath.inEdge(0, 1000, 100, 900));
        assertTrue(BandMath.inEdge(0, 1000, 100, -950));
        assertFalse(BandMath.inEdge(0, 1000, 100, 899));
    }

    function test_twap_lastSecondPushBarelyMoves() public pure {
        // 299 s at tick 0, then a push to 500 for the window's last second.
        assertEq(BandMath.twap(0, 500, 299, 0, 300, 300), 1);
    }

    function test_twap_negativeFloors() public pure {
        assertEq(BandMath.twap(-3, 0, 2, 0, 2, 300), -2);
    }

    function test_twap_idleWindowUsesLastTick() public pure {
        assertEq(BandMath.twap(123_456, -42, 1000, 0, 1300, 300), -42);
    }

    function test_rollRef_clamps() public pure {
        // TWAP far below a price that ran up: the reference follows just far enough.
        assertEq(BandMath.rollRef(0, 5000, 1000, 100), 5000 - 899);
        assertEq(BandMath.rollRef(0, -5000, 1000, 100), -5000 + 899);
        assertEq(BandMath.rollRef(10, 0, 1000, 100), 10);
    }

    function testFuzz_rollRef_keepsTickInsideBandOutsideEdge(int24 twapTick, int24 tick, int24 band, int24 edge)
        public
        pure
    {
        band = int24(bound(band, 3, 20_000));
        edge = int24(bound(edge, 1, band - 2));
        tick = int24(bound(tick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        twapTick = int24(bound(twapTick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        int24 ref = BandMath.rollRef(twapTick, tick, band, edge);
        assertFalse(BandMath.inEdge(ref, band, edge, tick));
        (int24 lower, int24 upper) = BandMath.limits(ref, band);
        assertTrue(tick >= lower && tick <= upper);
    }

    function testFuzz_refused_neverTowardReference(int24 ref, int24 band, int24 before, int24 afterTick) public pure {
        band = int24(bound(band, 3, 20_000));
        ref = int24(bound(ref, TickMath.MIN_TICK, TickMath.MAX_TICK));
        before = int24(bound(before, TickMath.MIN_TICK, TickMath.MAX_TICK));
        afterTick = int24(bound(afterTick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        if (BandMath.dist(afterTick, ref) <= BandMath.dist(before, ref)) {
            assertFalse(BandMath.refused(ref, band, before, afterTick));
        }
    }

    function testFuzz_pinRef_keepsTickInBand(int24 edgeRef, int24 tick, int24 band) public pure {
        band = int24(bound(band, 3, 20_000));
        tick = int24(bound(tick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        edgeRef = int24(bound(edgeRef, TickMath.MIN_TICK, TickMath.MAX_TICK));
        int24 ref = BandMath.pinRef(edgeRef, tick, band);
        assertLe(BandMath.dist(ref, tick), uint24(band));
        if (BandMath.dist(edgeRef, tick) <= uint24(band)) assertEq(ref, edgeRef);
    }
}
