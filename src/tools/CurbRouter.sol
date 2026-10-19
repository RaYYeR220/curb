// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @title A minimal v4 router for Curb's tools
/// @notice Swaps and adds liquidity, paid by the caller, and simulates a swap without moving
/// anything: `simulate` always reverts, with `Simulated(amount0, amount1, tickAfter)` when the swap
/// would pass and with the pool's own error when it would not. Called with `eth_call`, it tells a
/// trader what a Curb pool will do with an order before it is sent, including the hook's reason
/// for refusing it. A refused swap reverts inside the hook, before anything is paid, so finding out
/// needs no balance and no approval.
contract CurbRouter is IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    enum Op {
        Swap,
        Simulate,
        AddLiquidity
    }

    error NotManager();
    error Simulated(int128 amount0, int128 amount1, int24 tickAfter);
    error RefundFailed();

    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)
        external
        payable
        returns (int128 amount0, int128 amount1)
    {
        bytes memory out = manager.unlock(
            abi.encode(
                Op.Swap, msg.sender, key, SwapParams(zeroForOne, amountSpecified, sqrtPriceLimitX96), _noLiquidity()
            )
        );
        BalanceDelta delta = abi.decode(out, (BalanceDelta));
        _refund();
        return (delta.amount0(), delta.amount1());
    }

    function simulate(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)
        external
    {
        manager.unlock(
            abi.encode(
                Op.Simulate, msg.sender, key, SwapParams(zeroForOne, amountSpecified, sqrtPriceLimitX96), _noLiquidity()
            )
        );
    }

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity) external payable {
        manager.unlock(
            abi.encode(
                Op.AddLiquidity,
                msg.sender,
                key,
                SwapParams(false, 0, 0),
                ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(liquidity)), bytes32(0))
            )
        );
        _refund();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (Op op, address payer, PoolKey memory key, SwapParams memory params, ModifyLiquidityParams memory liq) =
            abi.decode(data, (Op, address, PoolKey, SwapParams, ModifyLiquidityParams));
        BalanceDelta delta;
        if (op == Op.AddLiquidity) {
            (delta,) = manager.modifyLiquidity(key, liq, "");
        } else {
            delta = manager.swap(key, params, "");
            if (op == Op.Simulate) {
                (, int24 tickAfter,,) = manager.getSlot0(key.toId());
                revert Simulated(delta.amount0(), delta.amount1(), tickAfter);
            }
        }
        _settle(key.currency0, delta.amount0(), payer);
        _settle(key.currency1, delta.amount1(), payer);
        return abi.encode(delta);
    }

    function _settle(Currency currency, int128 amount, address payer) private {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            manager.sync(currency);
            if (currency.isAddressZero()) {
                manager.settle{value: owed}();
            } else {
                // `payer` is always the caller of `swap` or `addLiquidity`: the PoolManager calls
                // back only the contract that called `unlock`, with the data that contract passed.
                // slither-disable-start arbitrary-send-erc20
                // forge-lint: disable-next-line(arbitrary-send-erc20)
                IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(manager), owed);
                // slither-disable-end arbitrary-send-erc20
                manager.settle();
            }
        } else if (amount > 0) {
            manager.take(currency, payer, uint256(uint128(amount)));
        }
    }

    /// @dev Returns whatever ETH the caller sent beyond what the pool took. The router holds
    /// nothing between calls, so the whole balance is the caller's.
    function _refund() private {
        uint256 left = address(this).balance;
        if (left != 0) _send(msg.sender, left);
    }

    function _send(address to, uint256 amount) private {
        // slither-disable-next-line arbitrary-send-eth
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    function _noLiquidity() private pure returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams(0, 0, 0, bytes32(0));
    }
}
