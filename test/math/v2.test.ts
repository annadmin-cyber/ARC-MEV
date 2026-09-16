import { describe, expect, it } from 'vitest'
import {
  MAX_UINT112,
  V2_PIPS,
  getV2AmountOut,
  isqrt,
  simulateV2ExactInput,
  v2Liquidity,
  v2SqrtPriceX96,
  v2Tick,
} from '../../src/math/v2.js'
import { MAX_SQRT_PRICE, MAX_TICK, MIN_SQRT_PRICE, MIN_TICK, getSqrtPriceAtTick, getTickAtSqrtPrice } from '../../src/math/tickMath.js'
import { rng } from './helpers.js'

const Q96 = 1n << 96n

/** `UniswapV2Library.getAmountOut` exactly as deployed (997 / 1000), the 0.30% reference. */
function getAmountOut997(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 997n
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee)
}

/** `UniswapV2Pair.swap`'s K check, generalised to a fee in pips: does the pair accept `out`? */
function pairAccepts(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, out: bigint, feePips: bigint): boolean {
  if (out >= reserveOut) return false
  const balanceIn = reserveIn + amountIn
  const balanceOut = reserveOut - out
  const adjustedIn = balanceIn * V2_PIPS - amountIn * feePips
  const adjustedOut = balanceOut * V2_PIPS
  return adjustedIn * adjustedOut >= reserveIn * reserveOut * V2_PIPS * V2_PIPS
}

describe('isqrt', () => {
  it('is the floor square root', () => {
    expect(isqrt(0n)).toBe(0n)
    expect(isqrt(1n)).toBe(1n)
    expect(isqrt(2n)).toBe(1n)
    expect(isqrt(3n)).toBe(1n)
    expect(isqrt(4n)).toBe(2n)
    expect(isqrt(99n)).toBe(9n)
    expect(isqrt(100n)).toBe(10n)
    expect(isqrt(10n ** 36n)).toBe(10n ** 18n)
    expect(isqrt(10n ** 36n - 1n)).toBe(10n ** 18n - 1n)
    expect(isqrt((1n << 256n) - 1n)).toBe((1n << 128n) - 1n)
    expect(() => isqrt(-1n)).toThrow(RangeError)
    const r = rng(11)
    for (let i = 0; i < 200; i++) {
      const n = BigInt(Math.floor(r() * 1e15)) * (1n << BigInt(Math.floor(r() * 120)))
      const s = isqrt(n)
      expect(s * s <= n && (s + 1n) * (s + 1n) > n, `isqrt(${n})`).toBe(true)
    }
  })
})

describe('getV2AmountOut', () => {
  it('reproduces hand-computed vectors', () => {
    // 100 in against 1000/1000 at 0.30%: 100 * 997 * 1000 / (1000 * 1000 + 100 * 997) = 90.66 -> 90
    expect(getV2AmountOut(100n, 1000n, 1000n, 3000)).toBe(90n)
    // fee-free: 100 * 10000 / (10000 + 100) = 99.0099 -> 99
    expect(getV2AmountOut(100n, 10_000n, 10_000n, 0)).toBe(99n)
    // 1 USDC (6 dec) into a 130k USDC / 130k 18-dec token pair at 0.30% (the Arc USDC/'USDT' pair shape)
    expect(getV2AmountOut(1_000_000n, 130_000_000_000n, 130_000n * 10n ** 18n, 3000)).toBe(996_992_353_835_563_276n)
    // 100% fee eats everything; empty reserves give nothing
    expect(getV2AmountOut(10n ** 18n, 10n ** 18n, 10n ** 18n, 1_000_000)).toBe(0n)
    expect(getV2AmountOut(10n ** 18n, 0n, 10n ** 18n, 3000)).toBe(0n)
    expect(getV2AmountOut(10n ** 18n, 10n ** 18n, 0n, 3000)).toBe(0n)
    expect(getV2AmountOut(0n, 10n ** 18n, 10n ** 18n, 3000)).toBe(0n)
    expect(() => getV2AmountOut(1n, 1n, 1n, 1_000_001)).toThrow(RangeError)
    expect(() => getV2AmountOut(1n, 1n, 1n, -1)).toThrow(RangeError)
  })

  it('is bit-identical to the deployed 997/1000 form for the canonical fee', () => {
    const r = rng(3)
    for (let i = 0; i < 500; i++) {
      const reserveIn = 1n + BigInt(Math.floor(r() * 1e12)) * 10n ** BigInt(Math.floor(r() * 10))
      const reserveOut = 1n + BigInt(Math.floor(r() * 1e12)) * 10n ** BigInt(Math.floor(r() * 10))
      const amountIn = 1n + BigInt(Math.floor(r() * 1e9)) * 10n ** BigInt(Math.floor(r() * 12))
      expect(getV2AmountOut(amountIn, reserveIn, reserveOut, 3000)).toBe(getAmountOut997(amountIn, reserveIn, reserveOut))
    }
  })

  it('returns the largest output the pair\'s K invariant accepts (any fee)', () => {
    const r = rng(5)
    const fees = [0, 100, 500, 2500, 3000, 10_000, 30_000]
    for (let i = 0; i < 400; i++) {
      const fee = fees[Math.floor(r() * fees.length)]!
      const reserveIn = 1n + BigInt(Math.floor(r() * 1e9)) * 10n ** BigInt(Math.floor(r() * 12))
      const reserveOut = 1n + BigInt(Math.floor(r() * 1e9)) * 10n ** BigInt(Math.floor(r() * 12))
      const amountIn = 1n + BigInt(Math.floor(r() * 1e9)) * 10n ** BigInt(Math.floor(r() * 10))
      const out = getV2AmountOut(amountIn, reserveIn, reserveOut, fee)
      expect(pairAccepts(amountIn, reserveIn, reserveOut, out, BigInt(fee)), `accepts ${out}`).toBe(true)
      expect(pairAccepts(amountIn, reserveIn, reserveOut, out + 1n, BigInt(fee)), `rejects ${out + 1n}`).toBe(false)
    }
  })
})

describe('v2 derivations', () => {
  it('sqrtPriceX96, tick and liquidity from known reserves', () => {
    // 1e6 USDC-6 against 1e18 of an 18-dec token: price 1e12 token1 per token0, sqrt 1e6, exactly representable
    const reserves = { reserve0: 1_000_000n, reserve1: 10n ** 18n }
    expect(v2SqrtPriceX96(reserves)).toBe(1_000_000n * Q96)
    expect(v2Tick(1_000_000n * Q96)).toBe(276324)
    expect(getTickAtSqrtPrice(1_000_000n * Q96)).toBe(276324)
    expect(v2Liquidity(reserves)).toBe(10n ** 12n)
    // 1:1 pair
    expect(v2SqrtPriceX96({ reserve0: 5n * 10n ** 18n, reserve1: 5n * 10n ** 18n })).toBe(Q96)
    expect(v2Tick(Q96)).toBe(0)
    // empty pair
    expect(v2SqrtPriceX96({ reserve0: 0n, reserve1: 10n })).toBe(0n)
    expect(v2SqrtPriceX96({ reserve0: 10n, reserve1: 0n })).toBe(0n)
    expect(v2Liquidity({ reserve0: 0n, reserve1: 10n })).toBe(0n)
    expect(v2Tick(0n)).toBe(0)
  })

  it('clamps the tick at the price bounds and stays inside uint160 for any uint112 reserves', () => {
    expect(v2Tick(MIN_SQRT_PRICE - 1n)).toBe(MIN_TICK)
    expect(v2Tick(MIN_SQRT_PRICE)).toBe(MIN_TICK)
    expect(v2Tick(MAX_SQRT_PRICE)).toBe(MAX_TICK)
    expect(v2Tick(getSqrtPriceAtTick(1234))).toBe(1234)
    const extreme = v2SqrtPriceX96({ reserve0: 1n, reserve1: MAX_UINT112 })
    expect(extreme < 1n << 160n).toBe(true)
    expect(extreme < MAX_SQRT_PRICE).toBe(true)
    const tiny = v2SqrtPriceX96({ reserve0: MAX_UINT112, reserve1: 1n })
    expect(tiny > MIN_SQRT_PRICE).toBe(true)
  })
})

describe('simulateV2ExactInput', () => {
  const reserves = { reserve0: 130_000_000_000n, reserve1: 130_000n * 10n ** 18n }

  it('applies the formula in both directions and reports the post-swap state', () => {
    const zfo = simulateV2ExactInput(reserves, 3000, true, 1_000_000_000n)
    expect(zfo.amountIn).toBe(1_000_000_000n)
    expect(zfo.amountOut).toBe(getV2AmountOut(1_000_000_000n, reserves.reserve0, reserves.reserve1, 3000))
    expect(zfo.feeAmount).toBe(3_000_000n)
    expect(zfo.truncated).toBe(false)
    const after = { reserve0: reserves.reserve0 + 1_000_000_000n, reserve1: reserves.reserve1 - zfo.amountOut }
    expect(zfo.sqrtPriceX96After).toBe(v2SqrtPriceX96(after))
    expect(zfo.tickAfter).toBe(v2Tick(zfo.sqrtPriceX96After))
    expect(zfo.liquidityAfter).toBe(v2Liquidity(after))
    // price of token1 per token0 falls when token0 is sold; k (liquidity) grows with the fee
    expect(zfo.sqrtPriceX96After < v2SqrtPriceX96(reserves)).toBe(true)
    expect(zfo.liquidityAfter > v2Liquidity(reserves)).toBe(true)

    const ofz = simulateV2ExactInput(reserves, 3000, false, 10n ** 21n)
    expect(ofz.amountOut).toBe(getV2AmountOut(10n ** 21n, reserves.reserve1, reserves.reserve0, 3000))
    expect(ofz.sqrtPriceX96After > v2SqrtPriceX96(reserves)).toBe(true)
    expect(ofz.feeAmount).toBe(3n * 10n ** 18n)
  })

  it('never throws for well-formed input: zero input, empty reserves and uint112 overflow are truncated results', () => {
    const zero = simulateV2ExactInput(reserves, 3000, true, 0n)
    expect(zero).toEqual({
      amountIn: 0n,
      amountOut: 0n,
      sqrtPriceX96After: v2SqrtPriceX96(reserves),
      tickAfter: v2Tick(v2SqrtPriceX96(reserves)),
      liquidityAfter: v2Liquidity(reserves),
      truncated: false,
      feeAmount: 0n,
    })
    const empty = simulateV2ExactInput({ reserve0: 0n, reserve1: 0n }, 3000, true, 10n)
    expect(empty.truncated).toBe(true)
    expect(empty.amountOut).toBe(0n)
    expect(empty.sqrtPriceX96After).toBe(0n)
    const overflow = simulateV2ExactInput({ reserve0: MAX_UINT112 - 5n, reserve1: 10n ** 18n }, 3000, true, 6n)
    expect(overflow.truncated).toBe(true)
    expect(overflow.amountOut).toBe(0n)
    const justFits = simulateV2ExactInput({ reserve0: MAX_UINT112 - 5n, reserve1: 10n ** 18n }, 3000, true, 5n)
    expect(justFits.truncated).toBe(false)
    expect(() => simulateV2ExactInput(reserves, 3000, true, -1n)).toThrow(RangeError)
    expect(() => simulateV2ExactInput(reserves, 1_000_001, true, 1n)).toThrow(RangeError)
  })

  it('output is monotone in the input and bounded by the output reserve', () => {
    let prev = 0n
    for (let amountIn = 1n; amountIn < 10n ** 30n; amountIn = amountIn * 7n + 3n) {
      const r = simulateV2ExactInput(reserves, 3000, false, amountIn)
      if (r.truncated) break
      expect(r.amountOut >= prev).toBe(true)
      expect(r.amountOut < reserves.reserve0).toBe(true)
      prev = r.amountOut
    }
  })
})
