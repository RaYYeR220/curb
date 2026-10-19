// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {CurbHook} from "../../src/CurbHook.sol";
import {ICurbHook} from "../../src/interfaces/ICurbHook.sol";
import {Breaker} from "../../src/libraries/Breaker.sol";
import {BandMath} from "../../src/libraries/BandMath.sol";

/// @dev Random swaps, clock moves, verdicts, fee collects and stray callback calls against one
/// CurbHook pool. Every outcome is checked as it happens and a violation is latched for the
/// invariant functions to report.
contract HookHandler is Test {
    using StateLibrary for IPoolManager;

    IPoolManager internal immutable manager;
    PoolSwapTest internal immutable swapRouter;
    PoolModifyLiquidityTest internal immutable lpRouter;
    CurbHook internal immutable hook;
    address internal immutable owner;
    int24 internal immutable band;
    int24 internal immutable edge;
    uint32 internal immutable haltSeconds;
    uint32 internal immutable cooldownSeconds;
    uint32 internal immutable limitSeconds;
    PoolKey internal key;

    // Latched violations, one per invariant.
    string public haltTooLong;
    string public haltsTooClose;
    string public resolveExtended;
    string public unjustifiedRevert;
    string public priceOutsideBand;
    string public collectFailed;
    string public strangerCallback;

    uint256 public tradeSum;
    uint256[] internal haltStarts;

    // Coverage counters.
    uint256 public swaps;
    uint256 public refusals;
    uint256 public haltedReverts;
    uint256 public closes;
    uint256 public resolves;

    constructor(
        IPoolManager manager_,
        PoolSwapTest swapRouter_,
        PoolModifyLiquidityTest lpRouter_,
        CurbHook hook_,
        PoolKey memory key_,
        address owner_
    ) {
        manager = manager_;
        swapRouter = swapRouter_;
        lpRouter = lpRouter_;
        hook = hook_;
        key = key_;
        owner = owner_;
        ICurbHook.Params memory p = hook_.params();
        band = p.bandTicks;
        edge = p.edgeTicks;
        haltSeconds = p.haltSeconds;
        cooldownSeconds = p.cooldownSeconds;
        limitSeconds = p.limitSeconds;
    }

    function approve(MockERC20 a, MockERC20 b) external {
        a.approve(address(swapRouter), type(uint256).max);
        b.approve(address(swapRouter), type(uint256).max);
        a.approve(address(lpRouter), type(uint256).max);
        b.approve(address(lpRouter), type(uint256).max);
    }

    // ---- actions ----

    function swap(uint256 seed) external {
        ICurbHook.Status memory s = hook.status();
        int256 offset = int256(bound(seed, 0, uint256(int256(band) * 3))) - int256(band) * 3 / 2;
        int24 target = _clampTick(int256(s.ref) + offset);
        _swapTo(target, seed);
    }

    /// @dev Drives the price into the edge zone, where halts come from.
    function pressEdge(uint256 seed) external {
        ICurbHook.Status memory s = hook.status();
        int24 depth = int24(int256(bound(seed, 0, uint256(int256(edge)))));
        int24 target = seed % 2 == 0 ? s.ref + band - depth : s.ref - band + depth;
        _swapTo(_clampTick(target), seed);
    }

    /// @dev Waits out a limit state or a halt, then trades: how halts get observed and closed.
    function waitAndSwap(uint256 seed) external {
        uint256 dt = bound(seed, limitSeconds, haltSeconds + 120);
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1 + dt / 4);
        this.swap(uint256(keccak256(abi.encode(seed))));
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 1, 1200);
        vm.warp(block.timestamp + dt);
        vm.roll(block.number + 1 + dt / 4);
    }

    function resolve(uint256 seed) external {
        ICurbHook.Status memory s = hook.status();
        if (s.phase != Breaker.Phase.Halted) return;
        Breaker.Verdict v = seed % 2 == 0 ? Breaker.Verdict.Organic : Breaker.Verdict.Concentrated;
        vm.prank(owner);
        try hook.resolve(s.nonce, v) returns (uint64 reopensAt) {
            resolves++;
            if (reopensAt > s.reopensAt) resolveExtended = "resolve moved the reopen time later";
            ICurbHook.Status memory t = hook.status();
            if (t.reopensAt > s.reopensAt) resolveExtended = "status reopensAt grew after resolve";
        } catch {}
    }

    function collect() external {
        try lpRouter.modifyLiquidity(key, ModifyLiquidityParams(-887220, 887220, 0, 0), "") {}
        catch {
            collectFailed = "a zero-liquidity collect reverted";
        }
    }

    function strayCallback(uint256 which) external {
        bool ok;
        if (which % 3 == 0) {
            (ok,) = address(hook).call(abi.encodeCall(IHooks.beforeInitialize, (address(this), key, uint160(1 << 96))));
        } else if (which % 3 == 1) {
            (ok,) = address(hook).call(
                abi.encodeCall(IHooks.beforeSwap, (address(this), key, SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), ""))
            );
        } else {
            (ok,) = address(hook).call(
                abi.encodeCall(
                    IHooks.afterSwap,
                    (address(this), key, SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), BalanceDelta.wrap(0), "")
                )
            );
        }
        if (ok) strangerCallback = "a callback accepted a caller other than the PoolManager";
    }

    // ---- views for the invariants ----

    function haltCount() external view returns (uint256) {
        return haltStarts.length;
    }

    // ---- internals ----

    function _swapTo(int24 target, uint256 seed) internal {
        (, int24 before,,) = manager.getSlot0(key.toId());
        if (target == before) return;
        bool zeroForOne = target < before;
        SwapParams memory p;
        if (seed % 5 == 0) {
            // Exact output with no useful limit: where it ends is the pool's business.
            p = SwapParams(zeroForOne, int256(bound(seed, 1e18, 1e23)), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        } else {
            p = SwapParams(zeroForOne, -1e29, TickMath.getSqrtPriceAtTick(target));
        }
        ICurbHook.Status memory pre = hook.status();
        vm.recordLogs();
        try swapRouter.swap(key, p, PoolSwapTest.TestSettings(false, false), "") {
            swaps++;
            _readLogs(vm.getRecordedLogs());
            ICurbHook.Status memory s = hook.status();
            if (s.tick < s.lower || s.tick > s.upper) priceOutsideBand = "a successful swap left the price outside the band";
            if (s.haltStart != 0 && s.reopensAt - s.haltStart > haltSeconds) haltTooLong = "a halt longer than haltSeconds";
        } catch (bytes memory data) {
            vm.getRecordedLogs();
            _judgeRevert(data, before, pre);
        }
    }

    /// @dev A revert is the hook's fault only when it is the hook's error, and then it must be one of
    /// two: a halt inside its window, or a refusal of a swap that ends outside the band further from
    /// the reference than it started.
    function _judgeRevert(bytes memory data, int24 before, ICurbHook.Status memory pre) internal {
        if (data.length < 4 || bytes4(data) != CustomRevert.WrappedError.selector) return;
        (address target,, bytes memory reason,) = abi.decode(_tail(data), (address, bytes4, bytes, bytes));
        if (target != address(hook)) return;
        bytes4 sel = bytes4(reason);
        if (sel == Breaker.Halted.selector) {
            haltedReverts++;
            if (pre.phase != Breaker.Phase.Halted) unjustifiedRevert = "Halted outside a halt window";
            if (pre.reopensAt - pre.haltStart > haltSeconds) haltTooLong = "a halt longer than haltSeconds";
            return;
        }
        if (sel == ICurbHook.OutsideBand.selector) {
            refusals++;
            (int24 ref, int24 tickAfter, int24 limit,) = abi.decode(_tail(reason), (int24, int24, int24, bool));
            (int24 lower, int24 upper) = BandMath.limits(ref, band);
            bool outside = tickAfter < lower || tickAfter > upper;
            bool further = BandMath.dist(tickAfter, ref) > BandMath.dist(before, ref);
            if (!outside || !further) unjustifiedRevert = "OutsideBand for a swap inside the band or toward the reference";
            if (limit != (tickAfter < ref ? lower : upper)) unjustifiedRevert = "OutsideBand named the wrong limit";
            return;
        }
        unjustifiedRevert = "the hook reverted with an unexpected error";
    }

    function _readLogs(Vm.Log[] memory logs) internal {
        bytes32 trade = keccak256("Trade(address,uint256)");
        bytes32 closed = ICurbHook.HaltClosed.selector;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(hook)) continue;
            if (logs[i].topics[0] == trade) tradeSum += abi.decode(logs[i].data, (uint256));
            if (logs[i].topics[0] == closed) {
                closes++;
                (uint64 start, uint64 end,,,) = abi.decode(logs[i].data, (uint64, uint64, Breaker.Verdict, int24, uint64));
                if (end - start > haltSeconds) haltTooLong = "a closed halt lasted longer than haltSeconds";
                uint256 n = haltStarts.length;
                if (n > 0 && start - haltStarts[n - 1] < haltSeconds + cooldownSeconds + limitSeconds) {
                    haltsTooClose = "two halts started closer than halt + cooldown + limit";
                }
                haltStarts.push(start);
            }
        }
    }

    function _clampTick(int256 t) internal pure returns (int24) {
        if (t < TickMath.MIN_TICK + 1) return TickMath.MIN_TICK + 1;
        if (t > TickMath.MAX_TICK - 1) return TickMath.MAX_TICK - 1;
        return int24(t);
    }

    function _tail(bytes memory data) internal pure returns (bytes memory body) {
        body = new bytes(data.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = data[i + 4];
        }
    }
}
