// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ILaunchFactory} from "../../src/interfaces/ILaunchFactory.sol";

/// @dev A launch record and a fee claim that can pay, or revert, on demand.
contract MockLaunchFactory is ILaunchFactory {
    struct Position {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        address requester;
    }

    mapping(uint64 => Position) internal positions;
    IERC20 public feeToken;
    uint256 public feeAmount;
    bool public claimReverts;
    uint256 public claims;
    address public reenterDesk;
    address public reenterHook;
    bool public reentered;

    function setPosition(uint64 n, PoolKey memory key, address requester) external {
        positions[n] = Position(key, -887220, 128940, requester);
    }

    function setFees(IERC20 token, uint256 amount, bool reverts) external {
        feeToken = token;
        feeAmount = amount;
        claimReverts = reverts;
    }

    /// @dev Makes the next fee claim call back into `desk.fileIncident(hook)`, as a hostile token
    /// or factory could.
    function setReenter(address desk, address hook) external {
        reenterDesk = desk;
        reenterHook = hook;
    }

    function positionOf(uint64 n) external view returns (PoolKey memory, int24, int24, address) {
        Position memory p = positions[n];
        return (p.key, p.tickLower, p.tickUpper, p.requester);
    }

    function claimFees(uint64 n) external returns (uint256, uint256) {
        require(!claimReverts, "claim failed");
        claims++;
        if (reenterDesk != address(0)) {
            (bool ok,) = reenterDesk.call(abi.encodeWithSignature("fileIncident(address)", reenterHook));
            reentered = ok;
        }
        if (feeAmount > 0) {
            feeToken.transfer(positions[n].requester, feeAmount);
            feeAmount = 0;
        }
        return (0, 0);
    }
}
