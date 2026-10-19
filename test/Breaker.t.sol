// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Breaker} from "../src/libraries/Breaker.sol";
import {BreakerHarness} from "./utils/BreakerHarness.sol";

/// @dev Mainnet CURB/IMD parameters: band 1000, edge 100, window 300 s, limit 15 s, halt 900 s,
/// cooldown 1800 s. The pool opens at tick 0 at t = 1000.
contract BreakerTest is Test {
    BreakerHarness internal h;
    uint64 internal constant T0 = 1000;

    function setUp() public {
        h = new BreakerHarness(Breaker.Config(1000, 100, 300, 15, 900, 1800));
        h.init(0, T0);
    }

    function _enterEdge(uint64 at) internal {
        (, Breaker.After memory a) = h.swap(at, 950, true);
        assertTrue(a.limitEntered);
    }

    // ---- limit state and halt ----

    function test_edgeEntry_startsClock() public {
        (, Breaker.After memory a) = h.swap(1010, 950, true);
        assertTrue(a.limitEntered);
        assertEq(a.haltsAt, 1025);
        Breaker.State memory st = h.state();
        assertEq(st.edgeSince, 1010);
        assertEq(st.edgeRef, 0);
        assertEq(uint8(h.phase(1010)), uint8(Breaker.Phase.Limit));
    }

    function test_edgeExit_clearsClock() public {
        _enterEdge(1010);
        (, Breaker.After memory a) = h.swap(1015, 500, true);
        assertTrue(a.limitCleared);
        assertEq(h.state().edgeSince, 0);
        assertEq(uint8(h.phase(1100)), uint8(Breaker.Phase.Open));
    }

    function test_limit_staysWhileInEdge() public {
        _enterEdge(1010);
        (, Breaker.After memory a) = h.swap(1024, 960, true);
        assertFalse(a.limitEntered);
        assertEq(h.state().edgeSince, 1010);
    }

    function test_halt_startsAfterLimitSeconds() public {
        _enterEdge(1010);
        vm.expectRevert(abi.encodeWithSelector(Breaker.Halted.selector, uint32(0), uint64(1925)));
        h.swap(1025, 900, true);
        assertEq(uint8(h.phase(1025)), uint8(Breaker.Phase.Halted));
        (uint64 start, uint64 end) = h.halt();
        assertEq(start, 1025);
        assertEq(end, 1925);
    }

    function test_halt_endsAtMax_thenCloses_recenters() public {
        _enterEdge(1010);
        (Breaker.Before memory b,) = h.swap(1925, 950, true);
        assertTrue(b.closed.happened);
        assertEq(b.closed.nonce, 0);
        assertEq(b.closed.haltStart, 1025);
        assertEq(b.closed.haltEnd, 1925);
        assertEq(uint8(b.closed.verdict), uint8(Breaker.Verdict.None));
        assertEq(b.closed.newRef, 950);
        assertEq(b.closed.cooldownEnd, 1025 + 900 + 1800);
        Breaker.State memory st = h.state();
        assertEq(st.nonce, 1);
        assertEq(st.ref, 950);
        assertEq(st.edgeSince, 0);
        assertEq(st.pinUntil, 0);
    }

    function test_silentHalt_closesOnFirstSwapAfterEnd() public {
        _enterEdge(1010);
        (Breaker.Before memory b,) = h.swap(5000, 950, true);
        assertTrue(b.closed.happened);
        assertEq(b.closed.haltStart, 1025);
        assertEq(b.closed.haltEnd, 1925);
    }

    function test_refusedSwap_changesNothing() public {
        Breaker.State memory before = h.state();
        vm.expectRevert(abi.encodeWithSelector(BreakerHarness.Refused.selector, int24(1000)));
        h.swap(1010, 1001, true);
        assertEq(keccak256(abi.encode(h.state())), keccak256(abi.encode(before)));
    }

    // ---- verdicts ----

    function test_resolveOrganic_reopensNow_recenters() public {
        _enterEdge(1010);
        assertEq(h.resolve(1100, 0, Breaker.Verdict.Organic), 1100);
        assertEq(uint8(h.phase(1100)), uint8(Breaker.Phase.Cooldown));
        (Breaker.Before memory b,) = h.swap(1101, 950, true);
        assertTrue(b.closed.happened);
        assertEq(b.closed.haltEnd, 1100);
        assertEq(uint8(b.closed.verdict), uint8(Breaker.Verdict.Organic));
        assertEq(b.closed.newRef, 950);
    }

    function test_cooldown_fromScheduledEnd_afterOrganic() public {
        _enterEdge(1010);
        h.resolve(1100, 0, Breaker.Verdict.Organic);
        (Breaker.Before memory b,) = h.swap(1101, 950, true);
        // Counted from the halt's scheduled maximum end, not from the early reopen.
        assertEq(b.closed.cooldownEnd, 1025 + 900 + 1800);
        assertEq(h.state().cooldownEnd, 3725);
    }

    function test_resolveConcentrated_fullHalt_pinsEdgeRef() public {
        _enterEdge(1010);
        assertEq(h.resolve(1100, 0, Breaker.Verdict.Concentrated), 1925);
        vm.expectRevert(abi.encodeWithSelector(Breaker.Halted.selector, uint32(0), uint64(1925)));
        h.swap(1100, 900, true);
        (Breaker.Before memory b,) = h.swap(1925, 950, true);
        assertEq(uint8(b.closed.verdict), uint8(Breaker.Verdict.Concentrated));
        // The pre-move reference, moved only far enough to take the price out of the edge zone.
        assertEq(b.closed.newRef, 51);
        assertEq(h.state().pinUntil, 3725);
        // Pushing further is refused against the pinned level; moving back toward it is not.
        vm.expectRevert(abi.encodeWithSelector(BreakerHarness.Refused.selector, int24(1051)));
        h.swap(2000, 1052, true);
        h.swap(2000, 900, true);
    }

    function test_pin_leavesEdgeRoom_afterDump() public {
        // A dump to the lower limit, called concentrated: the pinned band still leaves sellers room.
        (, Breaker.After memory a) = h.swap(1010, -1000, true);
        assertTrue(a.limitEntered);
        h.resolve(1100, 0, Breaker.Verdict.Concentrated);
        (Breaker.Before memory b,) = h.swap(1925, -1000, true);
        assertEq(b.closed.newRef, -101);
        h.swap(1930, -1100, true);
        assertEq(h.state().lastTick, -1100);
    }

    function test_pin_keepsReferenceFromLimitEntry() public {
        // The reference rolls up with a price that ran, then the next push is called concentrated:
        // the pin holds the reference in force when the limit state began, not the pushed price.
        h.swap(1290, 950, true);
        h.swap(1300, 950, true); // roll: ref follows to 950 - 899 = 51
        assertEq(h.state().ref, 51);
        (, Breaker.After memory a) = h.swap(1301, 1001, true);
        assertTrue(a.limitEntered);
        h.resolve(1400, 0, Breaker.Verdict.Concentrated);
        (Breaker.Before memory b,) = h.swap(1316 + 900, 1001, true);
        assertEq(b.closed.newRef, 102);
    }

    function test_pin_blocksRolls_untilCooldownEnd_thenRollUsesPostHaltSamplesOnly() public {
        _enterEdge(1010);
        h.resolve(1100, 0, Breaker.Verdict.Concentrated);
        h.swap(1925, 950, true); // closes, pins ref 0 until 3725, accumulator restarts at 1925
        (Breaker.Before memory b,) = h.swap(2000, 400, true);
        assertFalse(b.rolled);
        (b,) = h.swap(2600, 400, true);
        assertFalse(b.rolled);
        assertEq(h.state().ref, 51);
        h.swap(3600, 380, true);
        (b,) = h.swap(3730, 380, true);
        assertTrue(b.rolled);
        // Only post-close samples: 950 for 75 s, 400 for 1600 s, 380 for 130 s, over 1805 s.
        assertEq(b.twap, 421);
        assertEq(h.state().ref, 421);
        assertEq(h.state().pinUntil, 0);
    }

    function test_pin_suspendsEdgeClock() public {
        _enterEdge(1010);
        h.resolve(1100, 0, Breaker.Verdict.Concentrated);
        h.swap(1925, 500, true);
        (, Breaker.After memory a) = h.swap(2000, 950, true);
        assertFalse(a.limitEntered);
        assertEq(h.state().edgeSince, 0);
    }

    function test_nextHaltSpacing_atLeast_halt_plus_cooldown_plus_limit() public {
        _enterEdge(1010);
        h.swap(1925, 950, true); // closes; ref 950, cooldown until 3725
        (, Breaker.After memory a) = h.swap(2000, 1900, true);
        assertTrue(a.limitEntered);
        assertEq(a.haltsAt, 3725 + 15);
        assertEq(a.haltsAt - 1025, 900 + 1800 + 15);
        vm.expectRevert(abi.encodeWithSelector(Breaker.Halted.selector, uint32(1), uint64(3740 + 900)));
        h.swap(3740, 1900, true);
    }

    // ---- rolls ----

    function test_roll_followsTwap() public {
        h.swap(1100, 200, true);
        (Breaker.Before memory b,) = h.swap(1300, 200, true);
        assertTrue(b.rolled);
        // 0 for 100 s, 200 for 200 s.
        assertEq(b.twap, 133);
        assertEq(h.state().ref, 133);
    }

    function test_roll_clearsLimit() public {
        (, Breaker.After memory a) = h.swap(1295, 950, true);
        assertTrue(a.limitEntered);
        (Breaker.Before memory b,) = h.swap(1300, 950, true);
        assertTrue(b.rolled);
        assertTrue(b.limitCleared);
        assertEq(h.state().edgeSince, 0);
    }

    function test_zeroLiquidity_noRoll_noEdgeClock() public {
        (, Breaker.After memory a) = h.swap(1010, 950, false);
        assertFalse(a.limitEntered);
        assertEq(h.state().edgeSince, 0);
        (Breaker.Before memory b,) = h.swap(1400, 950, false);
        assertFalse(b.rolled);
        assertEq(h.state().ref, 0);
        // The band still caps a free move.
        vm.expectRevert(abi.encodeWithSelector(BreakerHarness.Refused.selector, int24(1000)));
        h.swap(1500, 1001, false);
    }

    // ---- where nothing trades ----

    function test_edgeExitIntoVoid_clearsClock() public {
        _enterEdge(1010);
        (, Breaker.After memory a) = h.swapFull(1012, 300, true, false, false, 0);
        assertTrue(a.limitCleared);
        assertEq(h.state().edgeSince, 0);
        h.swap(1030, 250, true);
        assertEq(uint8(h.phase(1030)), uint8(Breaker.Phase.Open));
    }

    function test_closeIlliquid_keepsReference() public {
        _enterEdge(1010);
        // Back through the market and out the other side, into a range with no liquidity: still
        // at a band edge, so the limit state holds and the pool halts.
        h.swapFull(1012, -1000, true, false, false, 0);
        (Breaker.Before memory b,) = h.swapFull(1925, -1000, false, false, false, 0);
        assertTrue(b.closed.happened);
        // A close never re-centres onto a price nobody can trade at.
        assertEq(b.closed.newRef, 0);
    }

    function test_voidStart_admittedFromBoundary() public {
        h.swapFull(1010, -900, true, false, false, 0); // a free push into a range with no liquidity
        assertEq(h.state().edgeSince, 0);
        (, Breaker.After memory a) = h.swapFull(1020, 1200, false, true, true, 300);
        assertTrue(a.reanchored);
        Breaker.State memory st = h.state();
        assertEq(st.ref, 301);
        assertEq(st.lastTick, 1200);
        assertEq(st.windowStart, 1020);
        assertEq(st.cum, 0);
    }

    function test_voidStart_notWhenStartedLiquid() public {
        vm.expectRevert(abi.encodeWithSelector(BreakerHarness.Refused.selector, int24(1000)));
        h.swapFull(1020, 1200, true, true, true, 300);
    }

    function test_voidStart_boundaryTooFar() public {
        h.swapFull(1010, -900, true, false, false, 0);
        vm.expectRevert(abi.encodeWithSelector(BreakerHarness.Refused.selector, int24(1000)));
        h.swapFull(1020, 1200, false, true, true, 100);
    }

    // ---- resolve guards ----

    function test_resolve_refusals() public {
        vm.expectRevert(Breaker.NotHalted.selector);
        h.resolve(1010, 0, Breaker.Verdict.Organic);
        _enterEdge(1010);
        vm.expectRevert(Breaker.BadVerdict.selector);
        h.resolve(1100, 0, Breaker.Verdict.None);
        vm.expectRevert(Breaker.BadVerdict.selector);
        h.resolve(1100, 0, Breaker.Verdict.Inconclusive);
        vm.expectRevert(abi.encodeWithSelector(Breaker.WrongIncident.selector, uint32(0), uint32(1)));
        h.resolve(1100, 1, Breaker.Verdict.Organic);
        h.resolve(1100, 0, Breaker.Verdict.Concentrated);
        vm.expectRevert(Breaker.AlreadyResolved.selector);
        h.resolve(1101, 0, Breaker.Verdict.Organic);
        vm.expectRevert(Breaker.NotHalted.selector);
        h.resolve(1925, 0, Breaker.Verdict.Organic);
    }

    function testFuzz_resolve_neverExtends(uint64 at, bool organic) public {
        _enterEdge(1010);
        at = uint64(bound(at, 1025, 1924));
        (, uint64 endBefore) = h.halt();
        uint64 end = h.resolve(at, 0, organic ? Breaker.Verdict.Organic : Breaker.Verdict.Concentrated);
        assertLe(end, endBefore);
        (, uint64 endAfter) = h.halt();
        assertEq(end, endAfter);
    }

    // ---- phase ----

    function test_phase_pendingClose_reportsCooldownThenOpen() public {
        _enterEdge(1010);
        assertEq(uint8(h.phase(1924)), uint8(Breaker.Phase.Halted));
        assertEq(uint8(h.phase(1925)), uint8(Breaker.Phase.Cooldown));
        assertEq(uint8(h.phase(3724)), uint8(Breaker.Phase.Cooldown));
        assertEq(uint8(h.phase(3725)), uint8(Breaker.Phase.Open));
    }
}
