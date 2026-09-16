/**
 * Uniswap v2 constant-product math and the derivations that let a v2 pair live in a `PoolState`
 * next to concentrated-liquidity pools (sqrtPriceX96, tick and a comparable "liquidity").
 *
 * The exact-input formula is `UniswapV2Library.getAmountOut` generalised to a fee in pips:
 * `amountInWithFee = amountIn * (1e6 - fee)`, `out = amountInWithFee * rOut / (rIn * 1e6 + amountInWithFee)`.
 * For the canonical 0.30% fee this is bit-identical to the 997/1000 form (numerator and
 * denominator are both scaled by 1000), and `out` is the largest integer that satisfies the pair's
 * own `K` check in `UniswapV2Pair.swap`. The executor's `_swapV2` computes exactly this.
 */
import type { SwapResult } from '../types.js'
import { MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK, getTickAtSqrtPrice } from './tickMath.js'

/** Fee denominator (1e6 pips = 100%). */
export const V2_PIPS = 1_000_000n
/** `uint112` upper bound of v2 reserves; a swap that would push a reserve above it reverts on chain. */
export const MAX_UINT112 = (1n << 112n) - 1n

/** Reserves of a v2-style pair. */
export interface V2Reserves {
  reserve0: bigint
  reserve1: bigint
}

/** Integer square root, rounded down (Newton's method from a power-of-two upper bound). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError(`isqrt: negative input ${n}`)
  if (n < 2n) return n
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1)
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

/** `UniswapV2Library.getAmountOut` with the fee in pips. 0 when either reserve is empty. */
export function getV2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePips: number): bigint {
  assertFee(feePips)
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * (V2_PIPS - BigInt(feePips))
  return (amountInWithFee * reserveOut) / (reserveIn * V2_PIPS + amountInWithFee)
}

/** `sqrt(reserve1 / reserve0) * 2^96` = `isqrt(reserve1 * 2^192 / reserve0)`; 0 for an empty pair. */
export function v2SqrtPriceX96(reserves: V2Reserves): bigint {
  if (reserves.reserve0 <= 0n || reserves.reserve1 <= 0n) return 0n
  return isqrt((reserves.reserve1 << 192n) / reserves.reserve0)
}

/** `isqrt(reserve0 * reserve1)`: the v2 "liquidity" comparable with a full-range v3/v4 position. */
export function v2Liquidity(reserves: V2Reserves): bigint {
  if (reserves.reserve0 <= 0n || reserves.reserve1 <= 0n) return 0n
  return isqrt(reserves.reserve0 * reserves.reserve1)
}

/** Tick of a derived sqrt price, clamped to the tick range; 0 for an empty pair (sqrt price 0). */
export function v2Tick(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) return 0
  if (sqrtPriceX96 < MIN_SQRT_PRICE) return MIN_TICK
  if (sqrtPriceX96 >= MAX_SQRT_PRICE) return MAX_TICK
  return getTickAtSqrtPrice(sqrtPriceX96)
}

/**
 * Simulate an exact-input swap against a v2-style pair. Never throws for well-formed input:
 * an empty reserve, or an input that would overflow the pair's `uint112` reserve (the pair would
 * revert), returns `truncated: true` with zero output. `feeAmount` is `amountIn * fee / 1e6`.
 */
export function simulateV2ExactInput(reserves: V2Reserves, feePips: number, zeroForOne: boolean, amountIn: bigint): SwapResult {
  if (amountIn < 0n) throw new RangeError(`simulateV2ExactInput: amountIn must be >= 0, got ${amountIn}`)
  assertFee(feePips)
  const { reserve0, reserve1 } = reserves
  const reserveIn = zeroForOne ? reserve0 : reserve1
  const reserveOut = zeroForOne ? reserve1 : reserve0
  const untouched = (truncated: boolean): SwapResult => {
    const sqrtPriceX96After = v2SqrtPriceX96(reserves)
    return {
      amountIn: 0n,
      amountOut: 0n,
      sqrtPriceX96After,
      tickAfter: v2Tick(sqrtPriceX96After),
      liquidityAfter: v2Liquidity(reserves),
      truncated,
      feeAmount: 0n,
    }
  }
  if (amountIn === 0n) return untouched(false)
  if (reserveIn <= 0n || reserveOut <= 0n || reserveIn + amountIn > MAX_UINT112) return untouched(true)

  const amountOut = getV2AmountOut(amountIn, reserveIn, reserveOut, feePips)
  const after: V2Reserves = zeroForOne
    ? { reserve0: reserve0 + amountIn, reserve1: reserve1 - amountOut }
    : { reserve0: reserve0 - amountOut, reserve1: reserve1 + amountIn }
  const sqrtPriceX96After = v2SqrtPriceX96(after)
  return {
    amountIn,
    amountOut,
    sqrtPriceX96After,
    tickAfter: v2Tick(sqrtPriceX96After),
    liquidityAfter: v2Liquidity(after),
    truncated: false,
    feeAmount: (amountIn * BigInt(feePips)) / V2_PIPS,
  }
}

function assertFee(feePips: number): void {
  if (!Number.isInteger(feePips) || feePips < 0 || feePips > 1_000_000) {
    throw new RangeError(`v2 fee must be an integer in [0, 1e6] pips, got ${feePips}`)
  }
}
