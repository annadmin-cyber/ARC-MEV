/**
 * Port of Uniswap v4 `FullMath.sol` and `UnsafeMath.sol` to native `bigint`.
 *
 * JavaScript bigints are arbitrary precision, so the 512-bit "phantom overflow"
 * tricks of the Solidity implementation are unnecessary: `a * b` is exact. What we
 * do preserve are the *observable* semantics of the Solidity functions: the result
 * must fit in a uint256 and the denominator must be non-zero, otherwise the EVM
 * reverts and we throw.
 */

/** 2^256 - 1 */
export const MAX_UINT256 = (1n << 256n) - 1n
/** 2^160 - 1 */
export const MAX_UINT160 = (1n << 160n) - 1n
/** 2^128 - 1 */
export const MAX_UINT128 = (1n << 128n) - 1n
/** 2^96, the fixed-point scale of sqrtPriceX96 (`FixedPoint96.Q96`). */
export const Q96 = 1n << 96n
/** `FixedPoint96.RESOLUTION` */
export const RESOLUTION = 96n

/** Thrown where the Solidity library would revert (overflow, division by zero, bad cast). */
export class MathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MathError'
  }
}

/**
 * floor(a * b / denominator) with full precision.
 * Throws if the result does not fit in a uint256 or the denominator is 0 (`FullMath.mulDiv`).
 */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MathError('mulDiv: denominator must be > 0')
  const result = (a * b) / denominator
  if (result > MAX_UINT256) throw new MathError('mulDiv: result overflows uint256')
  return result
}

/**
 * ceil(a * b / denominator) with full precision (`FullMath.mulDivRoundingUp`).
 * Throws if the result does not fit in a uint256 or the denominator is 0.
 */
export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  let result = mulDiv(a, b, denominator)
  if ((a * b) % denominator !== 0n) {
    result += 1n
    if (result > MAX_UINT256) throw new MathError('mulDivRoundingUp: result overflows uint256')
  }
  return result
}

/**
 * ceil(x / y) (`UnsafeMath.divRoundingUp`).
 * Like the Solidity version, division by zero returns 0 rather than reverting; callers
 * are responsible for checking the divisor.
 */
export function divRoundingUp(x: bigint, y: bigint): bigint {
  if (y === 0n) return 0n
  const q = x / y
  return x % y === 0n ? q : q + 1n
}

/** Casts to uint160, throwing like `SafeCast.toUint160` would on overflow. */
export function toUint160(x: bigint): bigint {
  if (x < 0n || x > MAX_UINT160) throw new MathError('toUint160: overflow')
  return x
}

/** Casts to uint128, throwing like `SafeCast.toUint128` would on overflow. */
export function toUint128(x: bigint): bigint {
  if (x < 0n || x > MAX_UINT128) throw new MathError('toUint128: overflow')
  return x
}
