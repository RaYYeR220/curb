// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {CurbHook} from "../src/CurbHook.sol";
import {ICurbHook} from "../src/interfaces/ICurbHook.sol";
import {Breaker} from "../src/libraries/Breaker.sol";
import {CurbFixture} from "./utils/CurbFixture.sol";

abstract contract CurbHookTest is CurbFixture {
    address internal alice = makeAddr("alice");

    // ---- permissions and callers ----

    function test_permissions_are_0x20C0() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.beforeSwap && p.afterSwap);
        assertFalse(p.afterInitialize || p.beforeAddLiquidity || p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity || p.afterRemoveLiquidity || p.beforeDonate || p.afterDonate);
        assertFalse(p.beforeSwapReturnDelta || p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta || p.afterRemoveLiquidityReturnDelta);
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, 0x20C0);
    }

    function test_callbacks_refuseNonPoolManager() public {
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeInitialize(FACTORY, key, SQRT_PRICE_1_1);
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), BalanceDelta.wrap(0), "");
    }

    // ---- initialize ----

    function test_init_acceptsInitializerOnLaunchKey() public view {
        ICurbHook.Status memory s = hook.status();
        assertEq(uint8(s.phase), uint8(Breaker.Phase.Open));
        assertEq(s.ref, 0);
        assertEq(s.lower, -1000);
        assertEq(s.upper, 1000);
        PoolKey memory k = hook.poolKey();
        assertEq(keccak256(abi.encode(k)), keccak256(abi.encode(key)));
        assertTrue(hook.isLive());
    }

    function _initFresh(uint256 seed, PoolKey memory k, address as_) internal returns (bytes memory) {
        vm.prank(as_);
        try manager.initialize(k, SQRT_PRICE_1_1) {
            return "";
        } catch (bytes memory reason) {
            return reason;
        }
    }

    function _freshKey(uint256 seed) internal returns (CurbHook h, PoolKey memory k) {
        h = deployHook(address(curb), FACTORY, OWNER, seed);
        k = keyFor(h);
    }

    function _expectInitRefusal(CurbHook h, PoolKey memory k, address as_, bytes memory err) internal {
        bytes memory got = _initFresh(0, k, as_);
        bytes memory want = abi.encodeWithSelector(
            bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)")),
            address(h),
            IHooks.beforeInitialize.selector,
            err,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
        assertEq(got, want);
    }

    function test_init_refusesOtherSender() public {
        (CurbHook h, PoolKey memory k) = _freshKey(11);
        _expectInitRefusal(h, k, alice, abi.encodeWithSelector(ICurbHook.NotInitializer.selector, alice));
    }

    function test_init_refusesWrongFee() public {
        (CurbHook h, PoolKey memory k) = _freshKey(12);
        k.fee = 3000;
        _expectInitRefusal(h, k, FACTORY, abi.encodeWithSelector(ICurbHook.WrongPool.selector));
    }

    function test_init_refusesDynamicFee() public {
        (CurbHook h, PoolKey memory k) = _freshKey(13);
        k.fee = 0x800000;
        _expectInitRefusal(h, k, FACTORY, abi.encodeWithSelector(ICurbHook.WrongPool.selector));
    }

    function test_init_refusesWrongSpacing() public {
        (CurbHook h, PoolKey memory k) = _freshKey(14);
        k.tickSpacing = 10;
        _expectInitRefusal(h, k, FACTORY, abi.encodeWithSelector(ICurbHook.WrongPool.selector));
    }

    function test_init_refusesKeyWithoutToken() public {
        (CurbHook h,) = _freshKey(15);
        MockERC20 x = new MockERC20("X", "X", 18);
        (address c0, address c1) = address(x) < address(imd) ? (address(x), address(imd)) : (address(imd), address(x));
        PoolKey memory k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 12500, 60, IHooks(address(h)));
        _expectInitRefusal(h, k, FACTORY, abi.encodeWithSelector(ICurbHook.WrongPool.selector));
    }

    function test_init_refusesSecondPool() public {
        MockERC20 x = new MockERC20("X", "X", 18);
        (address c0, address c1) =
            address(x) < address(curb) ? (address(x), address(curb)) : (address(curb), address(x));
        PoolKey memory k = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 12500, 60, IHooks(address(hook)));
        _expectInitRefusal(hook, k, FACTORY, abi.encodeWithSelector(ICurbHook.AlreadyInitialized.selector));
    }

    function test_constructor_refusesBadParams() public {
        address at = hookAddress(16);
        vm.expectRevert(ICurbHook.BadParams.selector);
        deployCodeTo(
            "CurbHook.sol:CurbHook",
            abi.encode(
                manager,
                address(curb),
                FACTORY,
                OWNER,
                int24(100),
                int24(99),
                WINDOW,
                LIMIT,
                HALT,
                COOLDOWN,
                MIN_LIQUIDITY_E18,
                true
            ),
            at
        );
        vm.expectRevert(ICurbHook.BadParams.selector);
        deployCodeTo(
            "CurbHook.sol:CurbHook",
            abi.encode(
                manager, address(0), FACTORY, OWNER, BAND, EDGE, WINDOW, LIMIT, HALT, COOLDOWN, MIN_LIQUIDITY_E18, true
            ),
            at
        );
    }

    // ---- the band ----

    function test_band_refusesPastUpper_withWrappedOutsideBand() public {
        (bool ok, bytes memory data) = trySwap(swapParams(1001, -1e29));
        assertFalse(ok);
        assertEq(
            data,
            wrapped(
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(ICurbHook.OutsideBand.selector, int24(0), int24(1001), int24(1000), false)
            )
        );
    }

    function test_band_refusesPastLower() public {
        (bool ok, bytes memory data) = trySwap(swapParams(-1001, -1e29));
        assertFalse(ok);
        assertEq(
            data,
            wrapped(
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(ICurbHook.OutsideBand.selector, int24(0), int24(-1001), int24(-1000), true)
            )
        );
    }

    function test_band_exactOutputPastBand_refused() public {
        // Exact output with no useful price limit: ask for far more than the band holds.
        (bool ok, bytes memory data) = trySwap(SwapParams(false, 1e23, TickMath.MAX_SQRT_PRICE - 1));
        assertFalse(ok);
        assertEq(bytes4(innerError(data)), ICurbHook.OutsideBand.selector);
    }

    function test_band_maxLimitSell_refused() public {
        // A router-style exact-input sell with the price limit at the end of the curve.
        (bool ok, bytes memory data) = trySwap(SwapParams(true, -1e23, TickMath.MIN_SQRT_PRICE + 1));
        assertFalse(ok);
        assertEq(bytes4(innerError(data)), ICurbHook.OutsideBand.selector);
    }

    function test_band_insideAndTowardReference_pass() public {
        moveTo(900);
        moveTo(-500);
        moveTo(1000);
        assertEq(tick(), 1000);
    }

    // ---- the volume tape ----

    function test_trade_emitsOriginAndPairedVolume_exactIn() public {
        _fund(alice);
        SwapParams memory p = swapParams(400, -1e21);
        vm.recordLogs();
        vm.prank(alice, alice);
        BalanceDelta d = swapRouter.swap(key, p, PoolSwapTest.TestSettings(false, false), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("Trade(address,uint256)");
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == topic) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(alice))));
                assertEq(abi.decode(logs[i].data, (uint256)), pairedVolume(d));
                seen = true;
            }
        }
        assertTrue(seen);
        assertGt(pairedVolume(d), 0);
        assertEq(hook.totalVolume(), pairedVolume(d));
    }

    function test_trade_exactOut_countsPairedSide() public {
        vm.recordLogs();
        BalanceDelta d = swapRouter.swap(key, swapParams(-400, 1e20), PoolSwapTest.TestSettings(false, false), "");
        (uint256 sum, uint256 count) = tradeVolumes(vm.getRecordedLogs());
        assertEq(count, 1);
        assertEq(sum, pairedVolume(d));
        assertEq(hook.totalVolume(), sum);
    }

    function test_volume_sameBlockRoll() public {
        vm.recordLogs();
        vm.roll(105);
        vm.warp(block.timestamp + 10);
        moveTo(100);
        // Same block, past the window: this swap rolls, and the window it opens starts at this
        // block, which already holds the swap above.
        vm.warp(block.timestamp + WINDOW);
        moveTo(200);
        vm.roll(109);
        vm.warp(block.timestamp + WINDOW);
        moveTo(300);
        (uint256 sum,) = tradeVolumes(vm.getRecordedLogs());
        (uint64 fromBlock, uint64 toBlock, uint256 volume) = hook.incidentWindow();
        assertEq(fromBlock, 105 + 1_000_000);
        assertEq(toBlock, 109 + 1_000_000);
        assertEq(volume, sum);
    }

    function test_incidentWindow_usesArbSysBlocks() public view {
        (uint64 fromBlock, uint64 toBlock, uint256 volume) = hook.incidentWindow();
        assertEq(fromBlock, 100 + 1_000_000);
        assertEq(toBlock, 100 + 1_000_000);
        assertEq(volume, 0);
    }

    function test_l2Block_fallsBackWithoutArbSys() public {
        vm.etch(address(100), "");
        hook = deployHook(address(curb), FACTORY, OWNER, 21);
        key = keyFor(hook);
        vm.prank(FACTORY);
        manager.initialize(key, SQRT_PRICE_1_1);
        (uint64 fromBlock,,) = hook.incidentWindow();
        assertEq(fromBlock, block.number);
    }

    /// @dev Arbitrum RPCs report `0xfe` as ArbSys's code. On a fork that is INVALID, which burns
    /// all the gas a call forwards; the read must forward only a little and fall back.
    function test_l2Block_forkedArbSysCostsBoundedGas() public {
        vm.etch(address(100), hex"fe");
        uint256 before = gasleft();
        moveTo(100);
        assertLt(before - gasleft(), 500_000);
        (, uint64 toBlock,) = hook.incidentWindow();
        assertEq(toBlock, block.number);
    }

    // ---- zero liquidity in range ----

    function _launchLikePool() internal {
        hook = deployHook(address(curb), FACTORY, OWNER, 31);
        key = keyFor(hook);
        vm.prank(FACTORY);
        manager.initialize(key, SQRT_PRICE_1_1);
        // Single-sided below the price, as a launch seeds it: nothing in range above tick 0.
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(FULL_LOWER, -60, int256(uint256(LIQUIDITY)), 0), "");
    }

    function test_zeroLiquidity_freePushCannotHalt() public {
        _launchLikePool();
        moveTo(950);
        assertEq(hook.status().edgeSince, 0);
        vm.warp(block.timestamp + LIMIT + 5);
        moveTo(960);
        assertTrue(hook.isLive());
        assertEq(uint8(hook.status().phase), uint8(Breaker.Phase.Open));
    }

    function test_zeroLiquidity_freePushCannotWalkReference() public {
        _launchLikePool();
        moveTo(950);
        vm.warp(block.timestamp + WINDOW + 1);
        moveTo(960);
        assertEq(hook.status().ref, 0);
        (bool ok, bytes memory data) = trySwap(swapParams(1001, -1e29));
        assertFalse(ok);
        assertEq(bytes4(innerError(data)), ICurbHook.OutsideBand.selector);
    }

    /// @dev Someone's own liquidity in the empty range lets the reference roll up into it; once it
    /// is pulled, the reference sits where nothing trades. A buyer crossing back into the launch's
    /// liquidity is judged from where that liquidity begins, and passes.
    function test_voidStart_strandedReferenceIsEscapable() public {
        _launchLikePool();
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(0, 3000, 1e21, bytes32(uint256(1))), "");
        moveTo(890);
        vm.warp(block.timestamp + WINDOW);
        moveTo(891);
        moveTo(1780);
        vm.warp(block.timestamp + WINDOW);
        moveTo(1781);
        moveTo(2670);
        vm.warp(block.timestamp + WINDOW);
        moveTo(2671);
        assertEq(hook.status().ref, 2670);
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(0, 3000, -1e21, bytes32(uint256(1))), "");
        moveTo(-500);
        assertEq(tick(), -500);
        assertEq(hook.status().ref, 399);
    }

    function test_voidStart_stillCapsMovesWithinTheVoid() public {
        _launchLikePool();
        // From the empty range further into it: no liquidity crossed, the band applies.
        moveTo(900);
        (bool ok, bytes memory data) = trySwap(swapParams(1001, -1e29));
        assertFalse(ok);
        assertEq(bytes4(innerError(data)), ICurbHook.OutsideBand.selector);
    }

    function test_closeIlliquid_keepsReference() public {
        _launchLikePool();
        moveTo(-950); // into the launch liquidity, at the lower edge: the limit clock starts
        moveTo(1000); // back through it and out into the empty range, still at a band edge
        assertGt(hook.status().edgeSince, 0);
        vm.warp(block.timestamp + LIMIT + HALT);
        moveTo(990);
        assertEq(hook.status().nonce, 1);
        assertEq(hook.status().ref, 0);
        moveTo(-500);
        assertEq(tick(), -500);
    }

    /// @dev Waiting in the empty range is free: sampled into the reference, a window of it would
    /// drag the next roll toward a price nobody traded, halting buyers a second after they return.
    function test_voidTime_isNotSampled_cannotHaltReturningBuyers() public {
        _launchLikePool();
        moveTo(999);
        vm.warp(block.timestamp + WINDOW);
        moveTo(-100);
        vm.warp(block.timestamp + 1);
        moveTo(-101);
        assertEq(hook.status().ref, 0);
        assertEq(hook.status().edgeSince, 0);
        vm.warp(block.timestamp + LIMIT);
        assertEq(uint8(hook.status().phase), uint8(Breaker.Phase.Open));
    }

    function test_voidTime_isNotSampled_cannotCapBuyers() public {
        _launchLikePool();
        moveTo(999);
        vm.warp(block.timestamp + WINDOW);
        moveTo(-100);
        vm.warp(block.timestamp + 1);
        moveTo(-99);
        assertEq(hook.status().ref, 0);
        moveTo(-300);
        assertEq(tick(), -300);
    }

    function test_voidTime_rollUsesOnlyLiquidTime() public {
        _launchLikePool();
        moveTo(-200);
        vm.warp(block.timestamp + WINDOW / 2);
        moveTo(999);
        vm.warp(block.timestamp + WINDOW);
        moveTo(-200);
        vm.warp(block.timestamp + WINDOW / 2);
        moveTo(-201);
        assertEq(hook.status().ref, -200);
    }

    function test_dustBelowMinimum_isNotLiquidity() public {
        _launchLikePool();
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(900, 960, 1, bytes32(uint256(2))), "");
        moveTo(930);
        assertEq(hook.status().edgeSince, 0);
        vm.warp(block.timestamp + LIMIT + 5);
        moveTo(940);
        assertTrue(hook.isLive());
    }

    // ---- limit, halt, verdicts ----

    function test_status_phases() public {
        moveTo(950);
        ICurbHook.Status memory s = hook.status();
        assertEq(uint8(s.phase), uint8(Breaker.Phase.Limit));
        uint64 start = uint64(block.timestamp) + LIMIT;
        assertEq(s.haltStart, start);
        vm.warp(start);
        s = hook.status();
        assertEq(uint8(s.phase), uint8(Breaker.Phase.Halted));
        assertEq(s.reopensAt, start + HALT);
        assertFalse(hook.isLive());
        vm.warp(start + HALT);
        s = hook.status();
        assertEq(uint8(s.phase), uint8(Breaker.Phase.Cooldown));
        assertEq(s.cooldownEnd, start + HALT + COOLDOWN);
        assertEq(s.ref, 950);
        vm.warp(start + HALT + COOLDOWN);
        assertEq(uint8(hook.status().phase), uint8(Breaker.Phase.Open));
    }

    function test_halted_swapRevertsWrapped() public {
        moveTo(950);
        uint64 start = uint64(block.timestamp) + LIMIT;
        vm.warp(start);
        (bool ok, bytes memory data) = trySwap(swapParams(900, -1e29));
        assertFalse(ok);
        assertEq(
            data,
            wrapped(
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(Breaker.Halted.selector, uint32(0), uint64(start + HALT))
            )
        );
    }

    function test_haltClosed_emittedOnFirstSwapAfter() public {
        moveTo(950);
        uint64 start = uint64(block.timestamp) + LIMIT;
        vm.warp(start + HALT);
        vm.expectEmit(address(hook));
        emit ICurbHook.HaltClosed(0, start, start + HALT, Breaker.Verdict.None, 950, start + HALT + COOLDOWN);
        moveTo(900);
        assertEq(hook.status().nonce, 1);
    }

    function test_resolve_onlyOwner() public {
        moveTo(950);
        uint64 start = uint64(block.timestamp) + LIMIT;
        vm.warp(start + 60);
        vm.expectRevert(ICurbHook.NotOwner.selector);
        vm.prank(alice);
        hook.resolve(0, Breaker.Verdict.Organic);
        vm.expectEmit(address(hook));
        emit ICurbHook.Resolved(0, Breaker.Verdict.Organic, start + 60);
        vm.prank(OWNER);
        hook.resolve(0, Breaker.Verdict.Organic);
        assertTrue(hook.isLive());
        moveTo(900);
        assertEq(hook.status().nonce, 1);
    }

    function test_params() public view {
        ICurbHook.Params memory p = hook.params();
        assertEq(p.bandTicks, BAND);
        assertEq(p.edgeTicks, EDGE);
        assertEq(p.refWindow, WINDOW);
        assertEq(p.limitSeconds, LIMIT);
        assertEq(p.haltSeconds, HALT);
        assertEq(p.cooldownSeconds, COOLDOWN);
        assertEq(p.minLiquidity, MIN_LIQUIDITY);
        assertTrue(p.arbBlocks);
        assertEq(hook.owner(), OWNER);
    }

    // ---- bytecode ----

    function test_runtimeSize_under_24576() public view {
        assertLe(address(hook).code.length, 24_576);
    }

    function test_noForbiddenOpcodes() public view {
        bytes memory code = address(hook).code;
        for (uint256 i = 0; i < code.length; i++) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x60 + 1;
                continue;
            }
            assertTrue(op != 0xff && op != 0xf4 && op != 0xf2);
        }
    }
}

contract CurbHookCurbIsCurrency0Test is CurbHookTest {
    function curbIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract CurbHookCurbIsCurrency1Test is CurbHookTest {
    function curbIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

/// @dev The drill pool pairs with native ETH: the tape must count the ETH side.
contract CurbHookNativePairTest is CurbFixture {
    function curbIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function setUp() public override {
        super.setUp();
        hook = deployHook(address(curb), FACTORY, OWNER, 41);
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(curb)), 12500, 60, IHooks(address(hook)));
        vm.prank(FACTORY);
        manager.initialize(key, SQRT_PRICE_1_1);
        vm.deal(address(this), 1e30);
        lpRouter.modifyLiquidity{value: 1e25}(key, ModifyLiquidityParams(FULL_LOWER, FULL_UPPER, 1e21, 0), "");
    }

    receive() external payable {}

    function test_nativePair_tapeCountsEth() public {
        vm.recordLogs();
        BalanceDelta d = swapRouter.swap{value: 1e18}(
            key, SwapParams(true, -1e18, TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), ""
        );
        (uint256 sum, uint256 count) = tradeVolumes(vm.getRecordedLogs());
        assertEq(count, 1);
        assertEq(sum, uint256(uint128(-d.amount0())));
        assertEq(sum, 1e18);
    }
}
