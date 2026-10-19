// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Stands in for Arbitrum's ArbSys at `address(100)`. The offset keeps the chain's own block
/// number visibly apart from `block.number`, which on Robinhood Chain is Ethereum's.
contract MockArbSys {
    uint256 internal constant OFFSET = 1_000_000;

    function arbBlockNumber() external view returns (uint256) {
        return block.number + OFFSET;
    }
}
