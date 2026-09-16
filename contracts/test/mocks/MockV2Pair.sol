// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @dev Minimal Uniswap-v2-style pair: reserves tracked from balances, swap enforces the
///      constant-product invariant with the configured fee, exactly like UniswapV2Pair.swap.
contract MockV2Pair {
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;
    uint256 public immutable feePips;
    uint112 private reserve0;
    uint112 private reserve1;

    constructor(MockERC20 _token0, MockERC20 _token1, uint256 _feePips) {
        token0 = _token0;
        token1 = _token1;
        feePips = _feePips;
    }

    function sync() external {
        reserve0 = uint112(token0.balanceOf(address(this)));
        reserve1 = uint112(token1.balanceOf(address(this)));
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out < reserve0 && amount1Out < reserve1, "insufficient liquidity");
        if (amount0Out > 0) token0.transfer(to, amount0Out);
        if (amount1Out > 0) token1.transfer(to, amount1Out);
        uint256 balance0 = token0.balanceOf(address(this));
        uint256 balance1 = token1.balanceOf(address(this));
        uint256 amount0In = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "insufficient input");
        uint256 adjusted0 = balance0 * 1_000_000 - amount0In * feePips;
        uint256 adjusted1 = balance1 * 1_000_000 - amount1In * feePips;
        require(adjusted0 * adjusted1 >= uint256(reserve0) * uint256(reserve1) * 1_000_000 ** 2, "K");
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
    }
}
