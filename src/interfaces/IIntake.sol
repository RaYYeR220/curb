// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title The parts of IMD's Intake (v2) a paying contract calls
/// @notice Deployed at `0xa43e6f75ee006411f79ac1c84120606c2330de82` on Ethereum, Robinhood Chain and
/// Sepolia. One call buys one action; the price is forwarded to IMD's treasury in the same call and
/// the result comes back through the named callback, once, under a 200,000 gas stipend.
interface IIntake {
    struct Callback {
        address target;
        bytes4 selector;
    }

    function priceOf(bytes32 action, address asset) external view returns (uint256);

    function request(bytes32 action, bytes calldata body, Callback calldata callback, address asset, uint256 amount)
        external
        payable
        returns (bytes32 requestId);

    function requestWithFailure(
        bytes32 action,
        bytes calldata body,
        Callback calldata callback,
        bytes4 onFailure,
        address asset,
        uint256 amount
    ) external payable returns (bytes32 requestId);
}
