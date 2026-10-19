// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {CurbRouter} from "../src/tools/CurbRouter.sol";
import {DrillToken} from "../src/tools/DrillToken.sol";
import {ICurbHook} from "../src/interfaces/ICurbHook.sol";
import {CurbFixture} from "./utils/CurbFixture.sol";

contract CurbRouterTest is CurbFixture {
    CurbRouter router;
    address nobody = makeAddr("nobody");

    function curbIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        router = new CurbRouter(IPoolManager(address(manager)));
        curb.approve(address(router), type(uint256).max);
        imd.approve(address(router), type(uint256).max);
    }

    function test_swap_bothDirections_erc20() public {
        uint256 curbBefore = curb.balanceOf(address(this));
        uint256 imdBefore = imd.balanceOf(address(this));
        (int128 a0, int128 a1) = router.swap(key, true, -1e18, TickMath.MIN_SQRT_PRICE + 1);
        assertEq(a0, -1e18);
        assertGt(a1, 0);
        assertEq(curb.balanceOf(address(this)), curbBefore - 1e18);
        assertEq(imd.balanceOf(address(this)), imdBefore + uint128(a1));
        (a0, a1) = router.swap(key, false, -1e18, TickMath.MAX_SQRT_PRICE - 1);
        assertEq(a1, -1e18);
        assertGt(a0, 0);
    }

    function test_swap_native_refundsExcessEth() public {
        DrillToken drill = new DrillToken();
        hook = deployHook(address(drill), address(this), address(this), 61);
        PoolKey memory k =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(drill)), 12500, 60, IHooks(address(hook)));
        manager.initialize(k, SQRT_PRICE_1_1);
        drill.approve(address(router), type(uint256).max);
        vm.deal(address(this), 10 ether);
        router.addLiquidity{value: 5 ether}(k, FULL_LOWER, FULL_UPPER, 1e18);
        uint256 before = address(this).balance;
        (int128 a0,) = router.swap{value: 2 ether}(k, true, -0.01 ether, TickMath.MIN_SQRT_PRICE + 1);
        assertEq(a0, -0.01 ether);
        assertEq(address(this).balance, before - 0.01 ether);
        assertEq(address(router).balance, 0);
    }

    function test_simulate_returnsDeltas() public {
        try router.simulate(key, true, -1e18, TickMath.MIN_SQRT_PRICE + 1) {
            fail();
        } catch (bytes memory data) {
            assertEq(bytes4(data), CurbRouter.Simulated.selector);
            (int128 a0, int128 a1, int24 tickAfter) = abi.decode(_tail(data), (int128, int128, int24));
            assertEq(a0, -1e18);
            assertGt(a1, 0);
            assertLt(tickAfter, 0);
        }
        // Nothing happened.
        assertEq(tick(), 0);
    }

    function test_simulate_bubblesOutsideBand() public {
        try router.simulate(key, false, -1e29, TickMath.getSqrtPriceAtTick(1001)) {
            fail();
        } catch (bytes memory data) {
            assertEq(
                data,
                wrapped(
                    IHooks.afterSwap.selector,
                    abi.encodeWithSelector(ICurbHook.OutsideBand.selector, int24(0), int24(1001), int24(1000), false)
                )
            );
        }
    }

    function test_refusedSwap_needsNoBalance() public {
        assertEq(curb.balanceOf(nobody), 0);
        vm.prank(nobody);
        try router.swap(key, false, -1e29, TickMath.getSqrtPriceAtTick(1001)) {
            fail();
        } catch (bytes memory data) {
            assertEq(bytes4(innerError(data)), ICurbHook.OutsideBand.selector);
        }
    }

    function test_addLiquidity() public {
        uint256 before = imd.balanceOf(address(this));
        router.addLiquidity(key, -600, 600, 1e18);
        assertLt(imd.balanceOf(address(this)), before);
    }

    function test_unlockCallback_onlyManager() public {
        vm.expectRevert(CurbRouter.NotManager.selector);
        router.unlockCallback("");
    }

    function test_drillToken() public {
        DrillToken drill = new DrillToken();
        assertEq(drill.name(), "Curb Drill");
        assertEq(drill.symbol(), "DRILL");
        assertEq(drill.totalSupply(), 1_000_000_000 ether);
        assertEq(drill.balanceOf(address(this)), 1_000_000_000 ether);
    }

    receive() external payable {}

    function _tail(bytes memory data) internal pure returns (bytes memory body) {
        body = new bytes(data.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = data[i + 4];
        }
    }
}
