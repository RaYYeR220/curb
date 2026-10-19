// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {CurbHook} from "../../src/CurbHook.sol";
import {MockArbSys} from "./MockArbSys.sol";

/// @dev A real PoolManager, a CURB/IMD pool on a CurbHook at a 0x20C0 address, initialised from the
/// launch factory's address at tick 0 with full-range liquidity, and swap helpers that land on an
/// exact tick. `curbIsCurrency0` chooses the token order, so every test runs both ways.
abstract contract CurbFixture is Test {
    using StateLibrary for IPoolManager;

    address internal constant FACTORY = address(0xFAC7);
    address internal constant OWNER = address(0xD35C);
    uint160 internal constant FLAGS = 0x20C0;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint128 internal constant LIQUIDITY = 1e24;
    int24 internal constant FULL_LOWER = -887220;
    int24 internal constant FULL_UPPER = 887220;

    int24 internal constant BAND = 1000;
    int24 internal constant EDGE = 100;
    uint32 internal constant WINDOW = 300;
    uint32 internal constant LIMIT = 15;
    uint32 internal constant HALT = 900;
    uint32 internal constant COOLDOWN = 1800;

    PoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    MockERC20 internal curb;
    MockERC20 internal imd;
    CurbHook internal hook;
    PoolKey internal key;

    function curbIsCurrency0() internal pure virtual returns (bool);

    function setUp() public virtual {
        vm.etch(address(100), address(new MockArbSys()).code);
        vm.warp(1_000_000);
        vm.roll(100);
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (MockERC20 lo, MockERC20 hi) = address(a) < address(b) ? (a, b) : (b, a);
        (curb, imd) = curbIsCurrency0() ? (lo, hi) : (hi, lo);
        _fund(address(this));
        hook = deployHook(address(curb), FACTORY, OWNER, 1);
        key = keyFor(hook);
        vm.prank(FACTORY);
        manager.initialize(key, SQRT_PRICE_1_1);
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(FULL_LOWER, FULL_UPPER, int256(uint256(LIQUIDITY)), 0), "");
    }

    function _fund(address who) internal {
        curb.mint(who, 1e30);
        imd.mint(who, 1e30);
        vm.startPrank(who);
        curb.approve(address(swapRouter), type(uint256).max);
        imd.approve(address(swapRouter), type(uint256).max);
        curb.approve(address(lpRouter), type(uint256).max);
        imd.approve(address(lpRouter), type(uint256).max);
        vm.stopPrank();
    }

    function hookAddress(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("curb", seed)))) & ~uint160(Hooks.ALL_HOOK_MASK);
        return address(high | FLAGS);
    }

    function deployHook(address token, address initializer, address owner, uint256 seed) internal returns (CurbHook) {
        address at = hookAddress(seed);
        deployCodeTo(
            "CurbHook.sol:CurbHook",
            abi.encode(manager, token, initializer, owner, BAND, EDGE, WINDOW, LIMIT, HALT, COOLDOWN, true),
            at
        );
        return CurbHook(at);
    }

    function keyFor(CurbHook h) internal view returns (PoolKey memory) {
        (address c0, address c1) = address(curb) < address(imd) ? (address(curb), address(imd)) : (address(imd), address(curb));
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 12500, 60, IHooks(address(h)));
    }

    function tick() internal view returns (int24 t) {
        (, t,,) = IPoolManager(address(manager)).getSlot0(key.toId());
    }

    function swapParams(int24 target, int256 amount) internal view returns (SwapParams memory) {
        bool zeroForOne = target < tick();
        return SwapParams(zeroForOne, amount, TickMath.getSqrtPriceAtTick(target));
    }

    /// @dev Exact-in swap large enough to reach `target`, stopped there by the price limit.
    function moveTo(int24 target) internal returns (BalanceDelta) {
        return swapRouter.swap(key, swapParams(target, -1e29), PoolSwapTest.TestSettings(false, false), "");
    }

    function trySwap(SwapParams memory p) internal returns (bool ok, bytes memory data) {
        try swapRouter.swap(key, p, PoolSwapTest.TestSettings(false, false), "") {
            ok = true;
        } catch (bytes memory reason) {
            data = reason;
        }
    }

    function wrapped(bytes4 hookSelector, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookSelector,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    /// @dev The hook's own error inside v4's WrappedError, or empty when the revert was not the hook's.
    function innerError(bytes memory data) internal pure returns (bytes memory reason) {
        if (data.length < 4 || bytes4(data) != CustomRevert.WrappedError.selector) return "";
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = data[i + 4];
        }
        (,, reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
    }

    function pairedVolume(BalanceDelta delta) internal view returns (uint256) {
        int128 v = address(imd) < address(curb) ? delta.amount0() : delta.amount1();
        return uint256(uint128(v < 0 ? -v : v));
    }

    function tradeVolumes(Vm.Log[] memory logs) internal view returns (uint256 sum, uint256 count) {
        bytes32 topic = keccak256("Trade(address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == topic) {
                sum += abi.decode(logs[i].data, (uint256));
                count++;
            }
        }
    }
}
