// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {ICurbHook} from "./interfaces/ICurbHook.sol";
import {BandMath} from "./libraries/BandMath.sol";
import {Breaker} from "./libraries/Breaker.sol";
import {L2Block} from "./libraries/L2Block.sol";

/// @title Curb: circuit breakers for a Uniswap v4 pool
/// @notice Stock exchanges stop a price from leaving a band around where it has recently traded,
/// and pause trading when it presses against that band. This hook does the same for one pool:
///
/// - A swap that would end outside the band, further from the reference than it started, is
///   refused with `OutsideBand(ref, tickAfter, limit, zeroForOne)`. The band is symmetric and a
///   swap back toward the reference always passes, so a holder can always sell toward the price
///   the pool has been trading at.
/// - A price that stays in the band's edge zone for `limitSeconds` halts the pool in both
///   directions for at most `haltSeconds` (`Halted(nonce, reopensAt)`). The halt ends on its own.
/// - The owner, a desk contract, may end a halt early when an attested fact says the move was
///   organic, or keep the pre-move reference when one actor drove it. It cannot lengthen a halt,
///   change a parameter, touch liquidity or move any funds; `resolve` is its only power.
///
/// Every successful swap appends one `Trade(trader, volume)` to a tape: `tx.origin` and the amount
/// of the paired currency that moved. Contracts cannot read logs and per-trader storage would
/// tax every swap, so the tape is an event, and `totalVolume` with block-aligned snapshots lets a
/// reader check an aggregate over any incident window against the chain.
///
/// The hook takes no fee, returns no delta and has no liquidity callbacks, so adding, removing
/// and collecting fees on a position are untouched. It serves exactly one pool: the first
/// initialisation, from `initializer`, on a key holding `token` with the static 1.25% fee and tick
/// spacing 60. A pool on a hook calls only that hook, and a second initialisation is refused, so
/// the swap callbacks need no pool check of their own.
contract CurbHook is BaseHook, ICurbHook {
    using StateLibrary for IPoolManager;

    struct Snapshot {
        uint64 fromBlock;
        uint192 volume;
    }

    uint24 public constant LP_FEE = 12500;
    int24 public constant TICK_SPACING = 60;

    address public immutable token;
    address public immutable initializer;
    address public immutable owner;

    int24 internal immutable BAND;
    int24 internal immutable EDGE;
    uint32 internal immutable REF_WINDOW;
    uint32 internal immutable LIMIT_SECONDS;
    uint32 internal immutable HALT_SECONDS;
    uint32 internal immutable COOLDOWN_SECONDS;
    bool internal immutable ARB_BLOCKS;

    Breaker.State internal breaker;
    PoolId internal poolId;
    Currency internal paired;
    bool internal initialized;
    bool internal pairedIs0;

    /// @notice The paired currency moved by every successful swap, ever.
    uint256 public totalVolume;
    /// @dev The window in force and the one before it, each from the start of the block it began in.
    Snapshot internal current;
    Snapshot internal previous;
    uint64 internal lastSwapBlock;
    uint192 internal volumeAtBlockStart;

    constructor(
        IPoolManager poolManager_,
        address token_,
        address initializer_,
        address owner_,
        int24 bandTicks,
        int24 edgeTicks,
        uint32 refWindow,
        uint32 limitSeconds,
        uint32 haltSeconds,
        uint32 cooldownSeconds,
        bool arbBlocks
    ) BaseHook(poolManager_) {
        if (
            address(poolManager_) == address(0) || token_ == address(0) || initializer_ == address(0)
                || owner_ == address(0) || edgeTicks <= 0 || bandTicks - edgeTicks < 2 || bandTicks > 20_000
                || refWindow == 0 || limitSeconds == 0 || haltSeconds == 0 || cooldownSeconds == 0
        ) revert BadParams();
        token = token_;
        initializer = initializer_;
        owner = owner_;
        BAND = bandTicks;
        EDGE = edgeTicks;
        REF_WINDOW = refWindow;
        LIMIT_SECONDS = limitSeconds;
        HALT_SECONDS = haltSeconds;
        COOLDOWN_SECONDS = cooldownSeconds;
        ARB_BLOCKS = arbBlocks;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
    }

    // ---- the owner's one power ----

    /// @notice Applies a verdict to the halt in progress: `Organic` reopens now, `Concentrated`
    /// keeps the full halt and pins the pre-move reference through the cooldown.
    function resolve(uint32 nonce, Breaker.Verdict v) external returns (uint64 reopensAt) {
        if (msg.sender != owner) revert NotOwner();
        reopensAt = Breaker.resolve(breaker, _config(), uint64(block.timestamp), nonce, v);
        emit Resolved(nonce, v, reopensAt);
    }

    // ---- views ----

    function status() external view returns (Status memory s) {
        Breaker.Config memory c = _config();
        uint64 nowTs = uint64(block.timestamp);
        s.phase = Breaker.phase(breaker, c, nowTs);
        s.nonce = breaker.nonce;
        s.ref = breaker.ref;
        s.tick = breaker.lastTick;
        s.edgeSince = breaker.edgeSince;
        s.cooldownEnd = breaker.cooldownEnd;
        s.pinUntil = breaker.pinUntil;
        s.verdict = breaker.verdict;
        (s.haltStart, s.reopensAt) = Breaker.halt(breaker, c);
        if (s.edgeSince != 0 && nowTs >= s.reopensAt) {
            // Ended, not yet closed: show what the next swap will set.
            bool pin = breaker.verdict == Breaker.Verdict.Concentrated;
            s.cooldownEnd = s.haltStart + c.haltSeconds + c.cooldownSeconds;
            s.ref = pin ? BandMath.pinRef(breaker.edgeRef, breaker.lastTick, c.band) : breaker.lastTick;
            s.pinUntil = pin ? s.cooldownEnd : 0;
        }
        (s.lower, s.upper) = BandMath.limits(s.ref, c.band);
        (s.fromBlock, s.toBlock, s.windowVolume) = incidentWindow();
    }

    /// @notice The block range an incident filed now would ask about, and the paired volume traded
    /// in it: from the start of the previous reference window to the last successful swap.
    function incidentWindow() public view returns (uint64 fromBlock, uint64 toBlock, uint256 volume) {
        Snapshot memory p = previous;
        return (p.fromBlock, lastSwapBlock, totalVolume - p.volume);
    }

    function params() external view returns (Params memory) {
        return Params(BAND, EDGE, REF_WINDOW, LIMIT_SECONDS, HALT_SECONDS, COOLDOWN_SECONDS, ARB_BLOCKS);
    }

    function isLive() external view returns (bool) {
        return initialized && Breaker.phase(breaker, _config(), uint64(block.timestamp)) != Breaker.Phase.Halted;
    }

    function poolKey() external view returns (PoolKey memory) {
        Currency launched = Currency.wrap(token);
        (Currency c0, Currency c1) = pairedIs0 ? (paired, launched) : (launched, paired);
        return PoolKey(c0, c1, LP_FEE, TICK_SPACING, IHooks(address(this)));
    }

    // ---- callbacks ----

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override
        returns (bytes4)
    {
        if (sender != initializer) revert NotInitializer(sender);
        if (initialized) revert AlreadyInitialized();
        bool tokenIs0 = Currency.unwrap(key.currency0) == token;
        if (!tokenIs0 && Currency.unwrap(key.currency1) != token) revert WrongPool();
        if (key.fee != LP_FEE || key.tickSpacing != TICK_SPACING) revert WrongPool();

        initialized = true;
        poolId = key.toId();
        pairedIs0 = !tokenIs0;
        paired = tokenIs0 ? key.currency1 : key.currency0;
        Breaker.init(breaker, TickMath.getTickAtSqrtPrice(sqrtPriceX96), uint64(block.timestamp));
        uint64 blockNow = L2Block.number(ARB_BLOCKS);
        current = Snapshot(blockNow, 0);
        previous = current;
        lastSwapBlock = blockNow;
        return IHooks.beforeInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bool liquid = poolManager.getLiquidity(poolId) > 0;
        Breaker.Before memory b = Breaker.beforeSwap(breaker, _config(), uint64(block.timestamp), liquid);
        if (b.closed.happened) {
            Breaker.Closed memory c = b.closed;
            emit HaltClosed(c.nonce, c.haltStart, c.haltEnd, c.verdict, c.newRef, c.cooldownEnd);
            _shiftWindow();
        }
        if (b.rolled) {
            emit ReferenceRolled(breaker.nonce, breaker.ref, b.twap, breaker.lastTick);
            _shiftWindow();
        }
        if (b.limitCleared) emit LimitCleared(breaker.nonce, breaker.lastTick);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(address, PoolKey calldata, SwapParams calldata params_, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        (, int24 tickAfter,,) = poolManager.getSlot0(poolId);
        bool liquid = poolManager.getLiquidity(poolId) > 0;
        int24 ref = breaker.ref;
        Breaker.After memory a = Breaker.afterSwap(breaker, _config(), uint64(block.timestamp), tickAfter, liquid);
        if (a.refused) revert OutsideBand(ref, tickAfter, a.limit, params_.zeroForOne);

        int128 moved = pairedIs0 ? delta.amount0() : delta.amount1();
        uint256 volume = uint256(uint128(moved < 0 ? -moved : moved));
        uint64 blockNow = L2Block.number(ARB_BLOCKS);
        if (blockNow != lastSwapBlock) {
            lastSwapBlock = blockNow;
            volumeAtBlockStart = uint192(totalVolume);
        }
        totalVolume += volume;
        emit Trade(tx.origin, volume);

        if (a.limitEntered) emit LimitEntered(breaker.nonce, ref, tickAfter, a.haltsAt);
        if (a.limitCleared) emit LimitCleared(breaker.nonce, tickAfter);
        return (IHooks.afterSwap.selector, 0);
    }

    // ---- internals ----

    function _config() internal view returns (Breaker.Config memory) {
        return Breaker.Config(BAND, EDGE, REF_WINDOW, LIMIT_SECONDS, HALT_SECONDS, COOLDOWN_SECONDS);
    }

    /// @dev A new reference window begins at the start of this block: volume already traded in it
    /// counts toward the new window, matching what a log query over its blocks returns.
    function _shiftWindow() internal {
        uint64 blockNow = L2Block.number(ARB_BLOCKS);
        uint256 atStart = blockNow == lastSwapBlock ? volumeAtBlockStart : totalVolume;
        previous = current;
        current = Snapshot(blockNow, uint192(atStart));
    }
}
