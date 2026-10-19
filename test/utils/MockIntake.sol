// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIntake} from "../../src/interfaces/IIntake.sol";

/// @dev The parts of IMD's Intake a desk touches: a price list, `request` and `requestWithFailure`
/// pulling the price to a treasury, and the writer's side, which calls the stored callback once
/// under the real 200,000 gas stipend.
contract MockIntake is IIntake {
    struct Stored {
        address payer;
        bytes32 action;
        bytes body;
        address target;
        bytes4 selector;
        bytes4 onFailure;
        address asset;
        uint256 amount;
    }

    address public constant TREASURY = address(0x7EA5);
    uint256 public constant CALLBACK_GAS = 200_000;

    mapping(bytes32 action => mapping(address asset => uint256)) public priceOf;
    mapping(bytes32 requestId => Stored) internal stored;
    bytes32 public lastRequestId;
    uint256 public pulled;
    uint256 public nonce;

    function setPrice(bytes32 action, address asset, uint256 amount) external {
        priceOf[action][asset] = amount;
    }

    function request(bytes32 action, bytes calldata body, Callback calldata callback, address asset, uint256 amount)
        external
        payable
        returns (bytes32)
    {
        return _request(action, body, callback, bytes4(0), asset, amount);
    }

    function requestWithFailure(
        bytes32 action,
        bytes calldata body,
        Callback calldata callback,
        bytes4 onFailure,
        address asset,
        uint256 amount
    ) external payable returns (bytes32) {
        return _request(action, body, callback, onFailure, asset, amount);
    }

    function _request(
        bytes32 action,
        bytes calldata body,
        Callback calldata callback,
        bytes4 onFailure,
        address asset,
        uint256 amount
    ) internal returns (bytes32 requestId) {
        uint256 price = priceOf[action][asset];
        require(price != 0, "ActionNotSold");
        require(amount >= price, "PriceNotMet");
        requestId = keccak256(abi.encode(block.chainid, address(this), ++nonce));
        stored[requestId] = Stored(msg.sender, action, body, callback.target, callback.selector, onFailure, asset, amount);
        lastRequestId = requestId;
        pulled += amount;
        require(IERC20(asset).transferFrom(msg.sender, TREASURY, amount), "pull");
    }

    function requestOf(bytes32 requestId) external view returns (Stored memory) {
        return stored[requestId];
    }

    /// @dev Status 0: the result's function with `args`, as the writer's `complete` calls it.
    function deliver(bytes32 requestId, bytes memory args) external returns (bool delivered) {
        Stored memory s = stored[requestId];
        (delivered,) = s.target.call{gas: CALLBACK_GAS}(bytes.concat(s.selector, args));
    }

    /// @dev Status 1 or 2: the failure function, unsigned, as `complete` calls it.
    function fail(bytes32 requestId, uint8 status, bytes32 reason) external returns (bool delivered) {
        Stored memory s = stored[requestId];
        bytes memory args = abi.encode(requestId, status, reason, uint16(0), uint16(0), bytes(""));
        (delivered,) = s.target.call{gas: CALLBACK_GAS}(bytes.concat(s.onFailure, args));
    }
}
