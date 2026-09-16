/**
 * Literal port of Uniswap v4 `TickMath.sol` to `bigint`.
 *
 * `getSqrtPriceAtTick` computes sqrt(1.0001^tick) * 2^96 with the exact same
 * Q128.128 constant ladder and rounding as the Solidity library, so results are
 * bit-identical. `getTickAtSqrtPrice` is the inverse with the same log2 refinement.
 */
import { MAX_UINT256, MathError } from './fullMath.js'

export const MIN_TICK = -887272
export const MAX_TICK = 887272
export const MIN_TICK_SPACING = 1
export const MAX_TICK_SPACING = 32767

/** getSqrtPriceAtTick(MIN_TICK) */
export const MIN_SQRT_PRICE = 4295128739n
/** getSqrtPriceAtTick(MAX_TICK) */
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n

/** Thrown when a tick is outside [MIN_TICK, MAX_TICK] (`TickMath.InvalidTick`). */
export class InvalidTickError extends MathError {
  constructor(public readonly tick: number) {
    super(`InvalidTick(${tick})`)
    this.name = 'InvalidTickError'
  }
}

/** Thrown when a sqrt price is outside [MIN_SQRT_PRICE, MAX_SQRT_PRICE) (`TickMath.InvalidSqrtPrice`). */
export class InvalidSqrtPriceError extends MathError {
  constructor(public readonly sqrtPriceX96: bigint) {
    super(`InvalidSqrtPrice(${sqrtPriceX96})`)
    this.name = 'InvalidSqrtPriceError'
  }
}

/** Largest tick usable for a given spacing: `(MAX_TICK / tickSpacing) * tickSpacing` (truncating). */
export function maxUsableTick(tickSpacing: number): number {
  return Math.trunc(MAX_TICK / tickSpacing) * tickSpacing
}

/** Smallest tick usable for a given spacing: `(MIN_TICK / tickSpacing) * tickSpacing` (truncating). */
export function minUsableTick(tickSpacing: number): number {
  return Math.trunc(MIN_TICK / tickSpacing) * tickSpacing
}

const TWO_128 = 1n << 128n
const U32_MAX = (1n << 32n) - 1n

/** Per-bit multipliers `2^128 / sqrt(1.0001^(2^i))`, Q128.128, rounded to nearest (from TickMath.sol). */
const LADDER: readonly (readonly [number, bigint])[] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]

/**
 * sqrt(1.0001^tick) * 2^96 as a Q64.96 fixed-point number (fits in 160 bits).
 * Throws `InvalidTickError` if |tick| > MAX_TICK.
 */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new InvalidTickError(tick)
  const absTick = tick < 0 ? -tick : tick

  let price = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : TWO_128
  for (const [bit, factor] of LADDER) {
    if ((absTick & bit) !== 0) price = (price * factor) >> 128n
  }
  if (tick > 0) price = MAX_UINT256 / price

  // Q128.128 -> Q128.96, rounding up so getTickAtSqrtPrice(output) is consistent.
  return (price + U32_MAX) >> 32n
}

/** Index of the most significant set bit of `x` (x > 0). */
export function mostSignificantBit(x: bigint): number {
  if (x <= 0n) throw new MathError('mostSignificantBit: x must be > 0')
  return x.toString(2).length - 1
}

/** Index of the least significant set bit of `x` (x > 0). */
export function leastSignificantBit(x: bigint): number {
  if (x <= 0n) throw new MathError('leastSignificantBit: x must be > 0')
  let r = 0
  while (((x >> BigInt(r)) & 1n) === 0n) r++
  return r
}

const LOG_SQRT10001_MULTIPLIER = 255738958999603826347141n
const TICK_LOW_ERROR = 3402992956809132418596140100660247210n
const TICK_HI_ERROR = 291339464771989622907027621153398088495n

/**
 * The greatest tick such that getSqrtPriceAtTick(tick) <= sqrtPriceX96.
 * Throws `InvalidSqrtPriceError` unless MIN_SQRT_PRICE <= sqrtPriceX96 < MAX_SQRT_PRICE.
 */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
    throw new InvalidSqrtPriceError(sqrtPriceX96)
  }
  const price = sqrtPriceX96 << 32n
  const msb = mostSignificantBit(price)

  let r = msb >= 128 ? price >> BigInt(msb - 127) : price << BigInt(127 - msb)
  let log2 = BigInt(msb - 128) << 64n

  // 14 refinement steps producing fractional bits 63..50 of log2(price).
  for (let bit = 63; bit >= 50; bit--) {
    r = (r * r) >> 127n
    const f = r >> 128n
    log2 |= f << BigInt(bit)
    if (bit > 50) r >>= f
  }

  const logSqrt10001 = log2 * LOG_SQRT10001_MULTIPLIER // Q22.128
  const tickLow = (logSqrt10001 - TICK_LOW_ERROR) >> 128n
  const tickHi = (logSqrt10001 + TICK_HI_ERROR) >> 128n

  if (tickLow === tickHi) return Number(tickLow)
  return getSqrtPriceAtTick(Number(tickHi)) <= sqrtPriceX96 ? Number(tickHi) : Number(tickLow)
}

/** Namespace object matching the module contract in docs/IMPLEMENTATION_SPEC.md. */
export const TickMath = {
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  maxUsableTick,
  minUsableTick,
} as const
