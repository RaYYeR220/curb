// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DRILL, the token of Curb's drill pool
/// @notice A throwaway fixed-supply token for a small DRILL/ETH pool on the same CurbHook code with
/// short timings, where refusals, halts and reopens can be shown live for cents.
contract DrillToken is ERC20 {
    constructor() ERC20("Curb Drill", "DRILL") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}
