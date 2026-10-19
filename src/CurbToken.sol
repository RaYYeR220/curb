// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title CURB, the token of the first pool Curb guards
/// @notice A plain fixed-supply ERC-20: one billion tokens minted once to whoever deploys it, which
/// on launch is the IMD launch factory. No owner, no mint, no burn, no fee, no pause. Everything
/// Curb does happens in the pool's hook; the token itself is deliberately unremarkable.
contract CurbToken is ERC20 {
    constructor() ERC20("Curb", "CURB") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}
