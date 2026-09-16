// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Reference-vector generator for the TypeScript port in src/math/.
/// Run: forge test --match-path 'test/vectors/*' -vv
/// Every line starting with "V|" is parsed into test/math/fixtures.ts (see the header of that
/// file for the generator command). Not a test of behaviour: it only prints library outputs.
import {Test, console} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {SwapMath} from "@uniswap/v4-core/src/libraries/SwapMath.sol";
import {TickBitmap} from "@uniswap/v4-core/src/libraries/TickBitmap.sol";
import {ProtocolFeeLibrary} from "@uniswap/v4-core/src/libraries/ProtocolFeeLibrary.sol";

contract MathVectors is Test {
    uint160 constant P1 = 79228162514264337593543950336; // 2^96, price 1:1

    function s(uint256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function s(int256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function s(bool v) internal pure returns (string memory) {
        return v ? "1" : "0";
    }

    function test_tickMathVectors() public pure {
        int24[11] memory ticks = [
            TickMath.MIN_TICK, -887271, -100000, -60, -1, 0, 1, 60, 100000, 887271, TickMath.MAX_TICK
        ];
        for (uint256 i = 0; i < ticks.length; i++) {
            uint160 p = TickMath.getSqrtPriceAtTick(ticks[i]);
            console.log(string.concat("V|sqrtAtTick|", s(int256(ticks[i])), "|", s(uint256(p))));
            for (int256 d = -1; d <= 1; d++) {
                int256 q = int256(uint256(p)) + d;
                if (q < int256(uint256(TickMath.MIN_SQRT_PRICE)) || q >= int256(uint256(TickMath.MAX_SQRT_PRICE))) continue;
                int24 t = TickMath.getTickAtSqrtPrice(uint160(uint256(q)));
                console.log(string.concat("V|tickAtSqrt|", s(uint256(q)), "|", s(int256(t))));
            }
        }
        // a few arbitrary prices as well
        uint160[4] memory prices = [
            uint160(533968626430913993175880612), // live pool 0xba2b9bdf04, tick -100001
            uint160(71976280159915846857433054512), // live pool 0x27effa630d, tick -1921
            uint160(3973128855837938857806917),
            uint160(P1 * 3 + 777)
        ];
        for (uint256 i = 0; i < prices.length; i++) {
            console.log(string.concat("V|tickAtSqrt|", s(uint256(prices[i])), "|", s(int256(TickMath.getTickAtSqrtPrice(prices[i])))));
        }
    }

    function logStep(uint160 cur, uint160 target, uint128 liquidity, int256 amountRemaining, uint24 fee) internal pure {
        (uint160 next, uint256 amountIn, uint256 amountOut, uint256 feeAmount) =
            SwapMath.computeSwapStep(cur, target, liquidity, amountRemaining, fee);
        console.log(
            string.concat(
                "V|step|", s(uint256(cur)), "|", s(uint256(target)), "|", s(uint256(liquidity)), "|", s(amountRemaining), "|",
                s(uint256(fee)), "|", s(uint256(next)), "|", s(amountIn), "|", s(amountOut), "|", s(feeAmount)
            )
        );
    }

    function test_swapStepVectors() public pure {
        uint160 down = TickMath.getSqrtPriceAtTick(-60);
        uint160 up = TickMath.getSqrtPriceAtTick(60);
        uint128 L = 1e21;
        // exact input, both directions, not reaching / reaching target, various fees
        logStep(P1, down, L, -1e18, 3000);
        logStep(P1, down, L, -1e24, 3000);
        logStep(P1, up, L, -1e18, 500);
        logStep(P1, up, L, -1e24, 500);
        logStep(P1, down, L, -1e18, 0);
        logStep(P1, up, L, -1e24, 10000);
        logStep(P1, down, L, -1e18, 999999);
        logStep(P1, down, L, -1e18, 1000000);
        logStep(P1, up, L, -1e18, 1000000);
        // tiny liquidity
        logStep(P1, down, 1, -1000, 3000);
        logStep(P1, up, 1, -1000, 3000);
        logStep(P1, up, 1, -1, 3000);
        // huge liquidity
        logStep(P1, TickMath.MIN_SQRT_PRICE + 1, type(uint128).max, -1e30, 3000);
        logStep(P1, TickMath.MAX_SQRT_PRICE - 1, type(uint128).max, -1e30, 3000);
        // zero-width step (target == current)
        logStep(P1, P1, L, -1e18, 3000);
        // exact output
        logStep(P1, down, L, 1e18, 3000);
        logStep(P1, down, L, 1e24, 3000);
        logStep(P1, up, L, 1e18, 500);
        logStep(P1, up, L, 1e24, 500);
        // live-pool-like prices
        logStep(533968626430913993175880612, TickMath.getSqrtPriceAtTick(-100025), 156110757352674480799197329519, -5e18, 30000);
        logStep(71976280159915846857433054512, TickMath.getSqrtPriceAtTick(-1920), 1100788910709095788945967942, -2e18, 10000);
    }

    function logDelta0(uint160 a, uint160 b, uint128 L) internal pure {
        console.log(string.concat("V|amount0|", s(uint256(a)), "|", s(uint256(b)), "|", s(uint256(L)), "|1|", s(SqrtPriceMath.getAmount0Delta(a, b, L, true))));
        console.log(string.concat("V|amount0|", s(uint256(a)), "|", s(uint256(b)), "|", s(uint256(L)), "|0|", s(SqrtPriceMath.getAmount0Delta(a, b, L, false))));
    }

    function logDelta1(uint160 a, uint160 b, uint128 L) internal pure {
        console.log(string.concat("V|amount1|", s(uint256(a)), "|", s(uint256(b)), "|", s(uint256(L)), "|1|", s(SqrtPriceMath.getAmount1Delta(a, b, L, true))));
        console.log(string.concat("V|amount1|", s(uint256(a)), "|", s(uint256(b)), "|", s(uint256(L)), "|0|", s(SqrtPriceMath.getAmount1Delta(a, b, L, false))));
    }

    function test_sqrtPriceMathVectors() public pure {
        uint160 down = TickMath.getSqrtPriceAtTick(-60);
        uint160 up = TickMath.getSqrtPriceAtTick(60);
        logDelta0(P1, down, 1e18);
        logDelta0(down, P1, 1e18);
        logDelta0(P1 + 12345, P1 * 3 + 777, 987654321987654321);
        logDelta0(TickMath.MIN_SQRT_PRICE, P1, 1);
        logDelta0(P1, TickMath.MAX_SQRT_PRICE, type(uint128).max);
        logDelta1(P1, up, 1e18);
        logDelta1(up, P1, 1e18);
        logDelta1(P1 + 12345, P1 * 3 + 777, 987654321987654321);
        logDelta1(TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE, type(uint128).max);
        logDelta1(P1, P1 + 1, 1);

        uint160[3] memory prices = [P1, uint160(533968626430913993175880612), uint160(P1 * 3 + 777)];
        uint128[3] memory liq = [uint128(1e21), uint128(156110757352674480799197329519), uint128(7)];
        uint256[3] memory amounts = [uint256(1e18), uint256(12345678901234567890123), uint256(3)];
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = 0; j < 3; j++) {
                for (uint256 k = 0; k < 2; k++) {
                    bool zfo = k == 0;
                    // oneForZero with a tiny pool overflows uint160 (reverts on chain too); skip those
                    if (!zfo && amounts[i] > uint256(liq[j]) * 1e18) continue;
                    uint160 ni = SqrtPriceMath.getNextSqrtPriceFromInput(prices[i], liq[j], amounts[i], zfo);
                    console.log(string.concat("V|nextFromInput|", s(uint256(prices[i])), "|", s(uint256(liq[j])), "|", s(amounts[i]), "|", s(zfo), "|", s(uint256(ni))));
                    // exact output can revert (NotEnoughLiquidity / PriceOverflow) for large amounts; only log feasible ones
                    if (amounts[i] < uint256(liq[j]) / 4) {
                        uint160 no = SqrtPriceMath.getNextSqrtPriceFromOutput(prices[i], liq[j], amounts[i], zfo);
                        console.log(string.concat("V|nextFromOutput|", s(uint256(prices[i])), "|", s(uint256(liq[j])), "|", s(amounts[i]), "|", s(zfo), "|", s(uint256(no))));
                    }
                }
            }
        }
    }

    function test_miscVectors() public pure {
        int24[7] memory ticks = [int24(-887272), -601, -600, -1, 0, 59, 887272];
        int24[3] memory spacings = [int24(1), 60, 25];
        for (uint256 i = 0; i < ticks.length; i++) {
            for (uint256 j = 0; j < spacings.length; j++) {
                int24 c = TickBitmap.compress(ticks[i], spacings[j]);
                (int16 wordPos, uint8 bitPos) = TickBitmap.position(c);
                console.log(string.concat("V|compress|", s(int256(ticks[i])), "|", s(int256(spacings[j])), "|", s(int256(c)), "|", s(int256(wordPos)), "|", s(uint256(bitPos))));
            }
        }
        uint16[4] memory pf = [uint16(0), 500, 1000, 1];
        uint24[4] memory lp = [uint24(0), 3000, 999999, 1000000];
        for (uint256 i = 0; i < pf.length; i++) {
            for (uint256 j = 0; j < lp.length; j++) {
                console.log(string.concat("V|swapFee|", s(uint256(pf[i])), "|", s(uint256(lp[j])), "|", s(uint256(ProtocolFeeLibrary.calculateSwapFee(pf[i], lp[j])))));
            }
        }
    }
}
