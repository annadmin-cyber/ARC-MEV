/**
 * Literal port of Uniswap v4 `SqrtPriceMath.sol`.
 *
 * Every function keeps the Solidity rounding direction and the overflow / revert
 * conditions, expressed as explicit range checks against uint256 / uint160.
 */
import {
  MAX_UINT160,
  MAX_UINT256,
  MathError,
  Q96,
  RESOLUTION,
  divRoundingUp,
  mulDiv,
  mulDivRoundingUp,
  toUint160,
} from './fullMath.js'

/**
 * Next sqrt price after adding (`add`) or removing an `amount` of currency0. Always rounds up.
 * Formula: liquidity * sqrtP / (liquidity +- amount * sqrtP), falling back to
 * liquidity / (liquidity / sqrtP +- amount) when the product overflows.
 */
export function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (amount === 0n) return sqrtPX96
  const numerator1 = liquidity << RESOLUTION
  const product = amount * sqrtPX96

  if (add) {
    if (product <= MAX_UINT256) {
      const denominator = numerator1 + product
      if (denominator <= MAX_UINT256) {
        return mulDivRoundingUp(numerator1, sqrtPX96, denominator) // always fits in 160 bits
      }
    }
    if (sqrtPX96 === 0n) throw new MathError('getNextSqrtPriceFromAmount0RoundingUp: sqrtPX96 == 0')
    const denominator = numerator1 / sqrtPX96 + amount
    if (denominator > MAX_UINT256) throw new MathError('getNextSqrtPriceFromAmount0RoundingUp: overflow')
    return divRoundingUp(numerator1, denominator)
  }

  // Removing currency0: the product must not overflow and the denominator must not underflow.
  if (product > MAX_UINT256 || numerator1 <= product) throw new MathError('PriceOverflow()')
  return toUint160(mulDivRoundingUp(numerator1, sqrtPX96, numerator1 - product))
}

/**
 * Next sqrt price after adding (`add`) or removing an `amount` of currency1. Always rounds down.
 * Formula: sqrtP +- amount / liquidity.
 */
export function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (add) {
    if (liquidity === 0n) throw new MathError('getNextSqrtPriceFromAmount1RoundingDown: division by zero')
    const quotient = amount <= MAX_UINT160 ? (amount << RESOLUTION) / liquidity : mulDiv(amount, Q96, liquidity)
    return toUint160(sqrtPX96 + quotient)
  }
  const quotient =
    amount <= MAX_UINT160 ? divRoundingUp(amount << RESOLUTION, liquidity) : mulDivRoundingUp(amount, Q96, liquidity)
  if (sqrtPX96 <= quotient) throw new MathError('NotEnoughLiquidity()')
  return sqrtPX96 - quotient
}

/** Next sqrt price after swapping `amountIn` of currency0 (zeroForOne) or currency1 in. */
export function getNextSqrtPriceFromInput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPX96 === 0n || liquidity === 0n) throw new MathError('InvalidPriceOrLiquidity()')
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true)
}

/** Next sqrt price after swapping `amountOut` of currency1 (zeroForOne) or currency0 out. */
export function getNextSqrtPriceFromOutput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountOut: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPX96 === 0n || liquidity === 0n) throw new MathError('InvalidPriceOrLiquidity()')
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false)
}

/**
 * Amount of currency0 covering `liquidity` between two sqrt prices:
 * liquidity * (sqrtB - sqrtA) / (sqrtB * sqrtA), rounded per `roundUp`.
 */
export function getAmount0Delta(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  let lo = sqrtPriceAX96
  let hi = sqrtPriceBX96
  if (lo > hi) [lo, hi] = [hi, lo]
  if (lo === 0n) throw new MathError('InvalidPrice()')

  const numerator1 = liquidity << RESOLUTION
  const numerator2 = hi - lo
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, hi), lo)
    : mulDiv(numerator1, numerator2, hi) / lo
}

/**
 * Amount of currency1 covering `liquidity` between two sqrt prices:
 * liquidity * |sqrtB - sqrtA| / 2^96, rounded per `roundUp`.
 */
export function getAmount1Delta(
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const numerator = sqrtPriceAX96 >= sqrtPriceBX96 ? sqrtPriceAX96 - sqrtPriceBX96 : sqrtPriceBX96 - sqrtPriceAX96
  const product = liquidity * numerator
  const amount1 = product / Q96
  return roundUp && product % Q96 !== 0n ? amount1 + 1n : amount1
}
