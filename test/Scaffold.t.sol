// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {HookFlags} from "../src/HookFlags.sol";

contract ScaffoldTest is Test {
    function test_toolchain() public pure {
        assertEq(HookFlags.BEFORE_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP, 0x20C0);
        assertEq(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG), 0x20C0);
        assertEq(type(BaseHook).name, "BaseHook");
        assertTrue(type(PoolManager).creationCode.length > 0);
    }
}
