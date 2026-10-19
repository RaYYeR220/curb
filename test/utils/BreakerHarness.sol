// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Breaker} from "../../src/libraries/Breaker.sol";

/// @dev Drives the breaker over one storage struct the way CurbHook does, with time and liquidity
/// passed in. `swap` runs both halves and reverts on a refusal, so a refused swap leaves no trace,
/// exactly as the hook's revert does.
contract BreakerHarness {
    error Refused(int24 limit);

    Breaker.State internal s;
    Breaker.Config internal c;

    constructor(Breaker.Config memory config) {
        c = config;
    }

    function init(int24 tick, uint64 nowTs) external {
        Breaker.init(s, tick, nowTs);
    }

    function swap(uint64 nowTs, int24 tickAfter, bool liquid)
        external
        returns (Breaker.Before memory b, Breaker.After memory a)
    {
        return _swap(nowTs, tickAfter, liquid, liquid, false, 0);
    }

    /// @dev The full hook path: liquidity before and after, and the first liquid boundary the swap
    /// crossed, if any, which the hook finds in the PoolManager's tick bitmap.
    function swapFull(uint64 nowTs, int24 tickAfter, bool liquidBefore, bool liquidAfter, bool crossed, int24 boundary)
        external
        returns (Breaker.Before memory b, Breaker.After memory a)
    {
        return _swap(nowTs, tickAfter, liquidBefore, liquidAfter, crossed, boundary);
    }

    function _swap(uint64 nowTs, int24 tickAfter, bool liquidBefore, bool liquidAfter, bool crossed, int24 boundary)
        internal
        returns (Breaker.Before memory b, Breaker.After memory a)
    {
        b = Breaker.beforeSwap(s, c, nowTs, liquidBefore);
        a = Breaker.afterSwap(s, c, nowTs, tickAfter, liquidAfter);
        if (a.refused) {
            if (crossed && Breaker.admissibleFromVoid(s, c, tickAfter, boundary)) {
                a = Breaker.admitFromVoid(s, c, nowTs, tickAfter, liquidAfter);
            } else {
                revert Refused(a.limit);
            }
        }
    }

    function resolve(uint64 nowTs, uint32 nonce, Breaker.Verdict v) external returns (uint64) {
        return Breaker.resolve(s, c, nowTs, nonce, v);
    }

    function phase(uint64 nowTs) external view returns (Breaker.Phase) {
        return Breaker.phase(s, c, nowTs);
    }

    function halt() external view returns (uint64 start, uint64 end) {
        return Breaker.halt(s, c);
    }

    function state() external view returns (Breaker.State memory) {
        return s;
    }
}
