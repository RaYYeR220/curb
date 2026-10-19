// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @dev Stand-in for the verifier's OwnerChecks. `ORIGIN_PROBE` plays the IMD launch wallet as
/// `tx.origin` while the hook is deployed; a hook owned by it, or by the factory, fails.
abstract contract OwnerChecks is Test {
    address internal constant ORIGIN_PROBE = address(0x0000000000000000000000000000000000000219);

    function checkOwner(string memory name, address target, address factory) internal view {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length != 32) return;
        address current = abi.decode(data, (address));
        assertTrue(current != factory, string.concat(name, " is owned by the launch factory"));
        assertTrue(current != ORIGIN_PROBE, string.concat(name, " is owned by the IMD launch wallet"));
        assertTrue(current != address(0), string.concat(name, " reports a zero owner"));
    }
}
