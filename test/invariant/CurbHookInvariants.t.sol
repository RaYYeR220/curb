// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CurbFixture} from "../utils/CurbFixture.sol";
import {HookHandler} from "./HookHandler.sol";
import {ICurbHook} from "../../src/interfaces/ICurbHook.sol";

/// @notice The eight properties Curb promises, held under random trading, clock moves, verdicts,
/// fee collects and stray callback calls.
contract CurbHookInvariants is CurbFixture {
    HookHandler internal handler;

    function curbIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        handler = new HookHandler(IPoolManager(address(manager)), swapRouter, lpRouter, hook, key, OWNER);
        curb.mint(address(handler), 1e30);
        imd.mint(address(handler), 1e30);
        handler.approve(curb, imd);
        targetContract(address(handler));
    }

    function invariant_1_haltNeverLongerThanHaltSeconds() public view {
        assertEq(handler.haltTooLong(), "");
    }

    function invariant_2_haltStartsSpaced() public view {
        assertEq(handler.haltsTooClose(), "");
    }

    function invariant_3_resolveNeverExtends() public view {
        assertEq(handler.resolveExtended(), "");
    }

    function invariant_4_liveness_noHookRevertOnTowardOrInBandOutsideHalt() public view {
        assertEq(handler.unjustifiedRevert(), "");
    }

    function invariant_5_priceAlwaysInsideBand() public view {
        assertEq(handler.priceOutsideBand(), "");
        ICurbHook.Status memory s = hook.status();
        assertTrue(s.tick >= s.lower && s.tick <= s.upper);
    }

    function invariant_6_collectAlwaysSucceeds() public view {
        assertEq(handler.collectFailed(), "");
    }

    function invariant_7_onlyPoolManager() public view {
        assertEq(handler.strangerCallback(), "");
    }

    function invariant_8_totalVolumeEqualsTradeSum() public view {
        assertEq(hook.totalVolume(), handler.tradeSum());
    }

    /// @dev A long seeded walk through the same handler, with every latch checked at the end and a
    /// floor on how often it reached the states the invariants are about.
    function test_soak_longRandomWalk() public {
        uint256 seed = 0xC0B;
        for (uint256 i = 0; i < 3000; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = seed % 8;
            if (action == 0) handler.swap(seed);
            else if (action == 1 || action == 2) handler.pressEdge(seed);
            else if (action == 3) handler.warp(seed);
            else if (action == 4 || action == 5) handler.waitAndSwap(seed);
            else if (action == 6) handler.resolve(seed);
            else handler.collect();
        }
        invariant_1_haltNeverLongerThanHaltSeconds();
        invariant_2_haltStartsSpaced();
        invariant_3_resolveNeverExtends();
        invariant_4_liveness_noHookRevertOnTowardOrInBandOutsideHalt();
        invariant_5_priceAlwaysInsideBand();
        invariant_6_collectAlwaysSucceeds();
        invariant_8_totalVolumeEqualsTradeSum();
        console.log(
            "soak: swaps %s refusals %s halted reverts %s", handler.swaps(), handler.refusals(), handler.haltedReverts()
        );
        console.log("soak: halts closed %s verdicts applied %s", handler.closes(), handler.resolves());
        assertGt(handler.refusals(), 50);
        assertGt(handler.haltedReverts(), 10);
        assertGt(handler.closes(), 10);
        assertGt(handler.resolves(), 5);
    }

    /// @dev Proof the run reached the states the invariants are about.
    function afterInvariant() public view {
        assertGt(handler.swaps(), 0);
        console.log(
            "swaps %s refusals %s halted reverts %s", handler.swaps(), handler.refusals(), handler.haltedReverts()
        );
        console.log("halts closed %s verdicts applied %s", handler.closes(), handler.resolves());
    }
}
