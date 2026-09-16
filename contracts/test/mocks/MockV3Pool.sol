// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @dev Constant-product stand-in for a Uniswap-v3-style pool: same external surface
///      (`swap` with exact input, callback that must pay), simplified pricing.
///      Uses a configurable callback selector so the executor's fork-agnostic callback is tested.
contract MockV3Pool {
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;
    uint24 public immutable fee; // pips
    bytes4 public callbackSelector;

    constructor(MockERC20 _token0, MockERC20 _token1, uint24 _fee, bytes4 _callbackSelector) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        callbackSelector = _callbackSelector;
    }

    /// @dev Only the first return word (sqrtPriceX96) is meaningful; derived from reserves.
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool unlocked)
    {
        uint256 r0 = token0.balanceOf(address(this));
        uint256 r1 = token1.balanceOf(address(this));
        // sqrt(r1 / r0) * 2^96
        sqrtPriceX96 = uint160(_sqrt((r1 << 192) / r0));
        return (sqrtPriceX96, tick, a, b, c, d, true);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact input only");
        uint256 amountIn = uint256(amountSpecified);
        (MockERC20 tokenIn, MockERC20 tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 reserveIn = tokenIn.balanceOf(address(this));
        uint256 reserveOut = tokenOut.balanceOf(address(this));
        uint256 amountWithFee = amountIn * (1_000_000 - fee);
        uint256 amountOut = (amountWithFee * reserveOut) / (reserveIn * 1_000_000 + amountWithFee);

        tokenOut.transfer(recipient, amountOut);
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(amountOut)) : (-int256(amountOut), int256(amountIn));

        (bool ok,) = msg.sender.call(abi.encodeWithSelector(callbackSelector, amount0, amount1, data));
        require(ok, "callback failed");
        require(tokenIn.balanceOf(address(this)) >= reserveIn + amountIn, "not paid");
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
