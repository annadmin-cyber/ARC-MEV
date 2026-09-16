/**
 * Test helpers for the strategy module: a constant-product mock simulator that is independent of
 * `src/math`, plus fixture builders. The mock derives virtual reserves from `(liquidity, sqrtPrice)`
 * exactly as a single full-range v4 position would: `r0 = L * Q96 / sqrtP`, `r1 = L * sqrtP / Q96`.
 */
import type { Address, Hex } from 'viem'
import type { PoolInfo, PoolState, Simulator, SwapResult } from '../../src/types.js'

export const Q96 = 1n << 96n
const FEE_DENOMINATOR = 1_000_000n

/** Integer square root (floor). Newton's method from a seed that is guaranteed >= the root. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of negative')
  if (n < 2n) return n
  // Float seed scaled up slightly so it is above the true root; Newton then descends monotonically.
  let x = BigInt(Math.ceil(Math.sqrt(Number(n)) * (1 + 1e-9))) + 1n
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

/** Fake 32-byte pool id from a small integer. */
export function pid(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex
}

/** Fake 20-byte address from a small integer. */
export function addr(n: number): Address {
  return `0x${n.toString(16).padStart(40, '0')}` as Address
}

export const ZERO_ADDRESS = addr(0)

export function poolInfo(id: number, c0: Address, c1: Address, fee = 3000, tickSpacing = 60): PoolInfo {
  const [currency0, currency1] = c0 < c1 ? [c0, c1] : [c1, c0]
  return { poolId: pid(id), currency0, currency1, fee, tickSpacing, hooks: ZERO_ADDRESS, block: 1 }
}

/** Virtual reserves implied by a state (as the mock simulator sees them). */
export function reservesOf(state: PoolState): { r0: bigint; r1: bigint } {
  return {
    r0: (state.liquidity * Q96) / state.sqrtPriceX96,
    r1: (state.liquidity * state.sqrtPriceX96) / Q96,
  }
}

function tickFromSqrtPrice(sqrtPriceX96: bigint): number {
  const p = Number(sqrtPriceX96) / Number(Q96)
  return Math.floor(Math.log(p * p) / Math.log(1.0001))
}

/** A pool state whose virtual reserves are approximately (reserve0, reserve1). */
export function stateFromReserves(poolId: Hex, reserve0: bigint, reserve1: bigint, lpFee = 3000, block = 1): PoolState {
  const liquidity = isqrt(reserve0 * reserve1)
  const sqrtPriceX96 = isqrt((reserve1 * Q96 * Q96) / reserve0)
  return {
    poolId,
    block,
    sqrtPriceX96,
    tick: tickFromSqrtPrice(sqrtPriceX96),
    lpFee,
    protocolFee: 0,
    liquidity,
    tickSpacing: 1,
    ticks: new Map(),
    tickWindow: { lower: -887272, upper: 887272 },
  }
}

/** Constant-product exact-input swap with the pool's lpFee taken from the input. Never truncates. */
export const cpmmSimulator: Simulator = (state, zeroForOne, amountIn): SwapResult => {
  const { r0, r1 } = reservesOf(state)
  const [rIn, rOut] = zeroForOne ? [r0, r1] : [r1, r0]
  const fee = BigInt(state.lpFee)
  const feeAmount = (amountIn * fee + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR
  const inNet = amountIn - feeAmount
  const amountOut = inNet <= 0n ? 0n : (rOut * inNet) / (rIn + inNet)
  const r0After = zeroForOne ? r0 + inNet : r0 - amountOut
  const r1After = zeroForOne ? r1 - amountOut : r1 + inNet
  const sqrtPriceX96After = r0After === 0n ? state.sqrtPriceX96 : isqrt((r1After * Q96 * Q96) / r0After)
  return {
    amountIn,
    amountOut,
    sqrtPriceX96After,
    tickAfter: tickFromSqrtPrice(sqrtPriceX96After),
    liquidityAfter: state.liquidity,
    truncated: false,
    feeAmount,
  }
}

/**
 * Wrap a simulator so that inputs above `limit` are only partially consumed: the result is the
 * swap of `limit` marked `truncated`, mimicking a tick walk that leaves the known window.
 */
export function truncatingAbove(inner: Simulator, limit: bigint): Simulator {
  return (state, zeroForOne, amountIn) => {
    if (amountIn <= limit) return inner(state, zeroForOne, amountIn)
    const partial = inner(state, zeroForOne, limit)
    return { ...partial, amountIn: limit, truncated: true }
  }
}

/**
 * Analytic optimum input for a 2-hop constant-product cycle: hop 1 has reserves (a1 in, b1 out),
 * hop 2 has (a2 in, b2 out), with fee fractions f1, f2. Derived from
 * out(x) = K x / (C + D x), K = b1 b2 g1 g2, C = a1 a2, D = a2 g1 + b1 g1 g2, so
 * x* = (sqrt(K C) - C) / D.
 */
export function analyticTwoHopOptimum(a1: bigint, b1: bigint, a2: bigint, b2: bigint, f1: number, f2: number): number {
  const g1 = 1 - f1
  const g2 = 1 - f2
  const A1 = Number(a1)
  const B1 = Number(b1)
  const A2 = Number(a2)
  const B2 = Number(b2)
  const K = B1 * B2 * g1 * g2
  const C = A1 * A2
  const D = A2 * g1 + B1 * g1 * g2
  return (Math.sqrt(K * C) - C) / D
}
