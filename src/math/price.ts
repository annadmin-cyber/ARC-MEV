/**
 * Floating-point marginal prices for ranking. Never use these for amounts.
 */
import type { PoolState } from '../types.js'
import { swapFeeFor } from './protocolFee.js'

const TWO_96 = 2 ** 96

/** Marginal price of the pool as token1 per token0 (`(sqrtPriceX96 / 2^96)^2`), fee ignored. */
export function spotPrice1Per0(state: PoolState): number {
  const sqrt = Number(state.sqrtPriceX96) / TWO_96
  return sqrt * sqrt
}

/**
 * Marginal output per unit of input for an infinitesimal swap in the given direction, net of
 * the swap fee (LP + protocol) the pool charges for that direction.
 * Returns 0 for an uninitialised pool (sqrtPrice 0) so it ranks last.
 */
export function priceOf(state: PoolState, zeroForOne: boolean): number {
  if (state.sqrtPriceX96 <= 0n) return 0
  const p = spotPrice1Per0(state)
  const feeFraction = Number(swapFeeFor(state.protocolFee, state.lpFee, zeroForOne)) / 1e6
  const gross = zeroForOne ? p : 1 / p
  return gross * (1 - feeFraction)
}
