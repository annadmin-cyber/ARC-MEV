/**
 * Port of Uniswap v4 `LiquidityMath.sol`.
 */
import { MAX_UINT128, MathError } from './fullMath.js'

/**
 * `x + y` where `x` is a uint128 and `y` an int128; throws (`SafeCastOverflow`) if the
 * result leaves the uint128 range, exactly like the Solidity library.
 */
export function addDelta(x: bigint, y: bigint): bigint {
  const z = x + y
  if (z < 0n || z > MAX_UINT128) throw new MathError('SafeCastOverflow()')
  return z
}
