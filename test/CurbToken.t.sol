// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurbToken} from "../src/CurbToken.sol";

contract CurbTokenTest is Test {
    address internal deployer = makeAddr("deployer");
    CurbToken internal token;

    function setUp() public {
        vm.prank(deployer);
        token = new CurbToken();
    }

    function test_mintsWholeSupplyToDeployer() public view {
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertEq(token.balanceOf(deployer), 1_000_000_000 ether);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Curb");
        assertEq(token.symbol(), "CURB");
        assertEq(token.decimals(), 18);
    }

    function testFuzz_transferIsExact(address to, uint256 amount) public {
        vm.assume(to != deployer && to != address(0));
        amount = bound(amount, 0, 1_000_000_000 ether);
        vm.prank(deployer);
        assertTrue(token.transfer(to, amount));
        assertEq(token.balanceOf(to), amount);
        assertEq(token.balanceOf(deployer), 1_000_000_000 ether - amount);
        assertEq(token.totalSupply(), 1_000_000_000 ether);
    }

    function test_noMintSelector() public {
        vm.startPrank(deployer);
        (bool a,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", deployer, 1));
        (bool b,) = address(token).call(abi.encodeWithSignature("mint(uint256)", 1));
        vm.stopPrank();
        assertFalse(a);
        assertFalse(b);
        assertEq(token.totalSupply(), 1_000_000_000 ether);
    }
}
