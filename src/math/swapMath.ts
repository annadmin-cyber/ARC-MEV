/**
 * Literal port of Uniswap v4 `SwapMath.sol`: one swap step inside a single tick range.
 */
import { mulDiv, mulDivRoundingUp } from './fullMath.js'
import {
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
} from './sqrtPriceMath.js'

/** The swap fee is in hundredths of a bip; 1e6 is 100%. */
export const MAX_SWAP_FEE = 1_000_000n

/** Output of `computeSwapStep`. */
export interface SwapStep {
  /** Price after the step, never beyond the target. */
  sqrtPriceNextX96: bigint
  /** Input consumed by the step, excluding the fee. */
  amountIn: bigint
  /** Output produced by the step. */
  amountOut: bigint
  /** Input taken as fee. */
  feeAmount: bigint
}

/**
 * Price target for the next step: the next initialised tick's price unless the limit is closer.
 * zeroForOne (price decreasing) -> max(next, limit); oneForZero -> min(next, limit).
 */
export function getSqrtPriceTarget(zeroForOne: boolean, sqrtPriceNextX96: bigint, sqrtPriceLimitX96: bigint): bigint {
  if (zeroForOne) return sqrtPriceNextX96 >= sqrtPriceLimitX96 ? sqrtPriceNextX96 : sqrtPriceLimitX96
  return sqrtPriceNextX96 < sqrtPriceLimitX96 ? sqrtPriceNextX96 : sqrtPriceLimitX96
}

/**
 * Computes the result of swapping within one tick range.
 *
 * @param sqrtPriceCurrentX96 current pool sqrt price
 * @param sqrtPriceTargetX96 price that cannot be exceeded; the direction is inferred from it
 * @param liquidity usable liquidity in the range
 * @param amountRemaining negative for exact input (amount still to swap in), positive for exact output
 * @param feePips total swap fee in hundredths of a bip (<= MAX_SWAP_FEE)
 */
export function computeSwapStep(
  sqrtPriceCurrentX96: bigint,
  sqrtPriceTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint | number,
): SwapStep {
  const fee = BigInt(feePips)
  const zeroForOne = sqrtPriceCurrentX96 >= sqrtPriceTargetX96
  const exactIn = amountRemaining < 0n

  if (exactIn) {
    const amountRemainingLessFee = mulDiv(-amountRemaining, MAX_SWAP_FEE - fee, MAX_SWAP_FEE)
    let amountIn = zeroForOne
      ? getAmount0Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, true)
      : getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, true)
    let sqrtPriceNextX96: bigint
    let feeAmount: bigint
    if (amountRemainingLessFee >= amountIn) {
      // amountIn is capped by the target price
      sqrtPriceNextX96 = sqrtPriceTargetX96
      feeAmount = fee === MAX_SWAP_FEE ? amountIn : mulDivRoundingUp(amountIn, fee, MAX_SWAP_FEE - fee)
    } else {
      // exhaust the remaining amount; the remainder of the maximum input is the fee
      amountIn = amountRemainingLessFee
      sqrtPriceNextX96 = getNextSqrtPriceFromInput(sqrtPriceCurrentX96, liquidity, amountRemainingLessFee, zeroForOne)
      feeAmount = -amountRemaining - amountIn
    }
    const amountOut = zeroForOne
      ? getAmount1Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, false)
    return { sqrtPriceNextX96, amountIn, amountOut, feeAmount }
  }

  let amountOut = zeroForOne
    ? getAmount1Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, false)
    : getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, false)
  let sqrtPriceNextX96: bigint
  if (amountRemaining >= amountOut) {
    sqrtPriceNextX96 = sqrtPriceTargetX96
  } else {
    amountOut = amountRemaining
    sqrtPriceNextX96 = getNextSqrtPriceFromOutput(sqrtPriceCurrentX96, liquidity, amountOut, zeroForOne)
  }
  const amountIn = zeroForOne
    ? getAmount0Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, true)
    : getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, true)
  // feePips cannot be MAX_SWAP_FEE for exact output (Pool.swap rejects it earlier).
  const feeAmount = mulDivRoundingUp(amountIn, fee, MAX_SWAP_FEE - fee)
  return { sqrtPriceNextX96, amountIn, amountOut, feeAmount }
}
