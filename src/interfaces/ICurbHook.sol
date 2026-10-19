// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Breaker} from "../libraries/Breaker.sol";

/// @title What a circuit-breaker hook tells the world about its pool
interface ICurbHook {
    struct Params {
        int24 bandTicks;
        int24 edgeTicks;
        uint32 refWindow;
        uint32 limitSeconds;
        uint32 haltSeconds;
        uint32 cooldownSeconds;
        bool arbBlocks;
    }

    /// @dev Everything a trader, a keeper or a desk needs to know right now, without a swap. While
    /// a halt has ended but no swap has closed it yet, `ref`, `cooldownEnd` and `pinUntil` already
    /// show what the close will set.
    struct Status {
        Breaker.Phase phase;
        uint32 nonce;
        int24 ref;
        int24 lower;
        int24 upper;
        int24 tick;
        uint64 edgeSince;
        uint64 haltStart;
        uint64 reopensAt;
        uint64 cooldownEnd;
        uint64 pinUntil;
        Breaker.Verdict verdict;
        uint64 fromBlock;
        uint64 toBlock;
        uint256 windowVolume;
    }

    error NotInitializer(address sender);
    error WrongPool();
    error AlreadyInitialized();
    error OutsideBand(int24 ref, int24 tickAfter, int24 limit, bool zeroForOne);
    error NotOwner();
    error BadParams();

    /// @notice One per successful swap: who traded and how much of the paired currency moved. The
    /// tape the oracle ranks when an incident is filed.
    event Trade(address indexed trader, uint256 volume);
    event ReferenceRolled(uint32 indexed nonce, int24 ref, int24 twap, int24 tick);
    event LimitEntered(uint32 indexed nonce, int24 ref, int24 tick, uint64 haltsAt);
    event LimitCleared(uint32 indexed nonce, int24 tick);
    event Resolved(uint32 indexed nonce, Breaker.Verdict verdict, uint64 reopensAt);
    event HaltClosed(
        uint32 indexed nonce,
        uint64 haltStart,
        uint64 haltEnd,
        Breaker.Verdict verdict,
        int24 newRef,
        uint64 cooldownEnd
    );

    function owner() external view returns (address);
    function resolve(uint32 nonce, Breaker.Verdict v) external returns (uint64 reopensAt);
    function status() external view returns (Status memory);
    function params() external view returns (Params memory);
    function isLive() external view returns (bool);
    function poolKey() external view returns (PoolKey memory);
    function totalVolume() external view returns (uint256);
    function incidentWindow() external view returns (uint64 fromBlock, uint64 toBlock, uint256 volume);
}
