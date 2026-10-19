// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title The chain's own block number
/// @notice On an Arbitrum chain, which Robinhood Chain is, `block.number` is a recent Ethereum block
/// number. The oracle counts a question's window in the chain's own blocks, and logs are indexed by
/// them, so they come from ArbSys at `address(100)`.
/// @dev Read with a plain `staticcall` so a chain or a test without the precompile falls back to
/// `block.number` instead of reverting a swap: an address with no code answers with no data.
library L2Block {
    address internal constant ARB_SYS = address(100);

    function number(bool arbitrum) internal view returns (uint64) {
        if (arbitrum) {
            (bool ok, bytes memory data) = ARB_SYS.staticcall(abi.encodeWithSignature("arbBlockNumber()"));
            if (ok && data.length == 32) return uint64(abi.decode(data, (uint256)));
        }
        return uint64(block.number);
    }
}
