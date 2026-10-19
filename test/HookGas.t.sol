// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {CurbFixture} from "./utils/CurbFixture.sol";

/// @dev What Curb adds to a swap: the same exact-input swap on the Curb pool and on an identical
/// pool with no hook, in a fresh block each, with no roll due.
contract HookGasTest is CurbFixture {
    PoolKey internal bare;

    function curbIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        bare = key;
        bare.hooks = IHooks(address(0));
        manager.initialize(bare, SQRT_PRICE_1_1);
        lpRouter.modifyLiquidity(bare, ModifyLiquidityParams(FULL_LOWER, FULL_UPPER, int256(uint256(LIQUIDITY)), 0), "");
        // Warm both pools the same way.
        swapRouter.swap(
            key, SwapParams(true, -1e18, TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), ""
        );
        swapRouter.swap(
            bare, SwapParams(true, -1e18, TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), ""
        );
    }

    function _measure(PoolKey memory k) internal returns (uint256 used) {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        SwapParams memory p = SwapParams(false, -1e20, TickMath.MAX_SQRT_PRICE - 1);
        uint256 before = gasleft();
        swapRouter.swap(k, p, PoolSwapTest.TestSettings(false, false), "");
        used = before - gasleft();
    }

    function test_swapOverhead() public {
        uint256 withHook = _measure(key);
        uint256 without = _measure(bare);
        console.log("swap with CurbHook", withHook);
        console.log("swap without hook ", without);
        console.log("overhead          ", withHook - without);
        // A regression guard, not a budget: see docs/GAS.md for what the overhead buys.
        assertLt(withHook - without, 70_000);
    }
}
