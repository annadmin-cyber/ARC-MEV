/**
 * Local re-implementation of Uniswap v4 `Pool.swap` over a `PoolState` snapshot.
 *
 * The walk is the same as on chain: pick the next initialised tick within one bitmap
 * word, clamp to MIN/MAX tick, compute one `computeSwapStep` towards it (or the price
 * limit), account the amounts, cross the tick (applying `liquidityNet`, negated when
 * moving left) when the step reached it, and repeat until the input is consumed or the
 * price limit is hit.
 *
 * Differences from chain are limited to what a snapshot cannot know:
 * - Only ticks inside `state.tickWindow` are known. If a step would need to move the price
 *   beyond the window edge, the walk stops there and the result is flagged `truncated`.
 * - Reaching the price limit with input left over (e.g. all liquidity exhausted) is also
 *   reported as `truncated` rather than a partial fill.
 * - Anything the Solidity libraries would revert on (overflow, inconsistent tick data) is
 *   caught and reported as `truncated` with the state reached before the failing step.
 */
import type { PoolState, SwapResult } from '../types.js'
import { addDelta } from './liquidityMath.js'
import { protocolFeeForDirection, protocolFeeShare, swapFeeFor } from './protocolFee.js'
import { MAX_SWAP_FEE, computeSwapStep, getSqrtPriceTarget } from './swapMath.js'
import { nextInitializedTickWithinOneWord, type TickWindow } from './tickBitmap.js'
import { MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK, getSqrtPriceAtTick, getTickAtSqrtPrice } from './tickMath.js'

/** Price limits used by the executor and the v4 test router: one past the absolute bounds. */
export const MIN_PRICE_LIMIT = MIN_SQRT_PRICE + 1n
export const MAX_PRICE_LIMIT = MAX_SQRT_PRICE - 1n

/** Mutable walk state; committed only after each step succeeds so a throw leaves it consistent. */
interface Walk {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  /** Remaining specified amount: negative for exact input, positive for exact output. */
  amountRemaining: bigint
  /** Calculated amount: output so far (exact input) or negative input so far (exact output). */
  amountCalculated: bigint
  /** Fee paid to LPs (protocol share removed), in the input currency. */
  lpFee: bigint
  truncated: boolean
}

/** Options for the simulator. */
export interface SimulateOptions {
  /**
   * Pool tick spacing. Defaults to `state.tickSpacing` when the state carries one, otherwise it is
   * inferred from the initialised ticks (see `inferTickSpacing`).
   */
  tickSpacing?: number
  /** Override the price limit (defaults to MIN_PRICE_LIMIT / MAX_PRICE_LIMIT per direction). */
  sqrtPriceLimitX96?: bigint
}

/**
 * Greatest common divisor of all initialised tick positions, which is a multiple of the true
 * tick spacing. When the map is empty the spacing is irrelevant for the walk (no tick can be
 * crossed) and 1 is returned.
 *
 * A multiple of the true spacing finds every initialised tick, but bitmap word boundaries (every
 * 256 * spacing ticks) land in different places, which can change per-step rounding by a wei when
 * a swap crosses one. Pass the real spacing whenever it is known.
 */
export function inferTickSpacing(state: PoolState): number {
  let g = 0
  for (const t of state.ticks.keys()) {
    let a = Math.abs(t)
    let b = g
    while (b !== 0) [a, b] = [b, a % b]
    g = a
  }
  return g === 0 ? 1 : g
}

/** The tick spacing to walk with: explicit option, then `state.tickSpacing` if present, then inferred. */
function resolveTickSpacing(state: PoolState, opts: SimulateOptions): number {
  if (opts.tickSpacing !== undefined) return opts.tickSpacing
  const fromState = (state as PoolState & { tickSpacing?: unknown }).tickSpacing
  if (typeof fromState === 'number' && Number.isInteger(fromState) && fromState >= 1) return fromState
  return inferTickSpacing(state)
}

function isOutsideWindow(tick: number, window: TickWindow): boolean {
  return tick < window.lower || tick > window.upper
}

function finish(w: Walk, exactIn: boolean, amountSpecified: bigint): SwapResult {
  const consumed = amountSpecified - w.amountRemaining
  return {
    amountIn: exactIn ? -consumed : -w.amountCalculated,
    amountOut: exactIn ? w.amountCalculated : consumed,
    sqrtPriceX96After: w.sqrtPriceX96,
    tickAfter: w.tick,
    liquidityAfter: w.liquidity,
    truncated: w.truncated,
    feeAmount: w.lpFee,
  }
}

/**
 * Applies `liquidityNet` of `tickNext` to the walk (negated when moving left), like `Pool.crossTick`
 * followed by `LiquidityMath.addDelta`. Returns false instead of throwing when the tick data is
 * missing or inconsistent (liquidity would leave the uint128 range).
 */
function crossTick(state: PoolState, w: Walk, tickNext: number, zeroForOne: boolean): boolean {
  const data = state.ticks.get(tickNext)
  if (data === undefined) return false
  const liquidityNet = zeroForOne ? -data.liquidityNet : data.liquidityNet
  try {
    w.liquidity = addDelta(w.liquidity, liquidityNet)
  } catch {
    return false
  }
  return true
}

/**
 * Core walk shared by exact-input and exact-output simulation.
 * `amountSpecified` is negative for exact input and positive for exact output (v4 convention).
 */
function walk(state: PoolState, zeroForOne: boolean, amountSpecified: bigint, opts: SimulateOptions): SwapResult {
  const exactIn = amountSpecified < 0n
  const w: Walk = {
    sqrtPriceX96: state.sqrtPriceX96,
    tick: state.tick,
    liquidity: state.liquidity,
    amountRemaining: amountSpecified,
    amountCalculated: 0n,
    lpFee: 0n,
    truncated: false,
  }
  if (amountSpecified === 0n) return finish(w, exactIn, amountSpecified)

  const protocolFee = protocolFeeForDirection(state.protocolFee, zeroForOne)
  const swapFee = swapFeeFor(state.protocolFee, state.lpFee, zeroForOne)
  const limit = opts.sqrtPriceLimitX96 ?? (zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT)
  const tickSpacing = resolveTickSpacing(state, opts)
  const window = state.tickWindow

  // Conditions under which Pool.swap reverts outright.
  const badFee = swapFee > MAX_SWAP_FEE || (!exactIn && swapFee >= MAX_SWAP_FEE)
  const badLimit = zeroForOne
    ? limit >= state.sqrtPriceX96 || limit <= MIN_SQRT_PRICE
    : limit <= state.sqrtPriceX96 || limit >= MAX_SQRT_PRICE
  if (badFee || badLimit || tickSpacing < 1 || isOutsideWindow(w.tick, window)) {
    w.truncated = true
    return finish(w, exactIn, amountSpecified)
  }

  try {
    while (w.amountRemaining !== 0n && w.sqrtPriceX96 !== limit) {
      if (isOutsideWindow(w.tick, window)) {
        w.truncated = true
        break
      }
      const sqrtPriceStart = w.sqrtPriceX96
      const found = nextInitializedTickWithinOneWord(state.ticks, w.tick, tickSpacing, zeroForOne, window)
      let tickNext = found.next
      let initialized = found.initialized

      // The bitmap word extends past what we know: only walk up to the window edge.
      let atWindowEdge = false
      if (isOutsideWindow(tickNext, window)) {
        tickNext = zeroForOne ? window.lower : window.upper
        initialized = false
        atWindowEdge = true
      }
      // Never overshoot the absolute tick bounds (the bitmap is not aware of them).
      if (tickNext <= MIN_TICK) tickNext = MIN_TICK
      if (tickNext >= MAX_TICK) tickNext = MAX_TICK

      const sqrtPriceNext = getSqrtPriceAtTick(tickNext)
      const step = computeSwapStep(
        w.sqrtPriceX96,
        getSqrtPriceTarget(zeroForOne, sqrtPriceNext, limit),
        w.liquidity,
        w.amountRemaining,
        swapFee,
      )

      const feeAmount = step.feeAmount - protocolFeeShare(step.amountIn, step.feeAmount, swapFee, protocolFee)

      // Commit the step's price and amounts before dealing with the tick transition.
      w.sqrtPriceX96 = step.sqrtPriceNextX96
      w.lpFee += feeAmount
      if (exactIn) {
        w.amountRemaining += step.amountIn + step.feeAmount
        w.amountCalculated += step.amountOut
      } else {
        w.amountRemaining -= step.amountOut
        w.amountCalculated -= step.amountIn + step.feeAmount
      }

      if (step.sqrtPriceNextX96 === sqrtPriceNext) {
        w.tick = zeroForOne ? tickNext - 1 : tickNext
        if (atWindowEdge) {
          w.truncated = true
          break
        }
        if (initialized && !crossTick(state, w, tickNext, zeroForOne)) {
          w.truncated = true
          break
        }
      } else if (step.sqrtPriceNextX96 !== sqrtPriceStart) {
        w.tick = getTickAtSqrtPrice(step.sqrtPriceNextX96)
      }
    }
  } catch {
    // A library revert (overflow, inconsistent tick data): report what was committed so far.
    w.truncated = true
  }

  // Hitting the price limit with input left is a partial fill on chain; the bot treats it as truncated.
  if (w.amountRemaining !== 0n) w.truncated = true
  return finish(w, exactIn, amountSpecified)
}

/**
 * Simulates an exact-input swap of `amountIn` against `state`, faithful to `Pool.swap`.
 * Never throws for well-formed state; `truncated` is set when the walk leaves the known tick
 * window, runs out of liquidity, or hits the price limit before consuming the input.
 * `feeAmount` is the LP share of the fee (protocol fee removed), in the input currency.
 */
export function simulateExactInput(
  state: PoolState,
  zeroForOne: boolean,
  amountIn: bigint,
  opts: SimulateOptions = {},
): SwapResult {
  if (amountIn < 0n) throw new RangeError(`simulateExactInput: amountIn must be >= 0, got ${amountIn}`)
  return walk(state, zeroForOne, -amountIn, opts)
}

/**
 * Simulates an exact-output swap for `amountOut`, faithful to `Pool.swap`. The returned
 * `amountIn` is the total input required (fee included); `amountOut` is what could actually be
 * produced (equal to the request unless `truncated`).
 */
export function simulateExactOutput(
  state: PoolState,
  zeroForOne: boolean,
  amountOut: bigint,
  opts: SimulateOptions = {},
): SwapResult {
  if (amountOut < 0n) throw new RangeError(`simulateExactOutput: amountOut must be >= 0, got ${amountOut}`)
  return walk(state, zeroForOne, amountOut, opts)
}
