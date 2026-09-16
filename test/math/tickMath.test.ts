import { describe, expect, it } from 'vitest'
import {
  InvalidSqrtPriceError,
  InvalidTickError,
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  TickMath,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  leastSignificantBit,
  maxUsableTick,
  minUsableTick,
  mostSignificantBit,
} from '../../src/math/tickMath.js'
import { sqrtAtTick, tickAtSqrt } from './fixtures.js'
import { rng } from './helpers.js'

describe('TickMath', () => {
  it('constants match v4-core', () => {
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE)
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE)
    expect(TickMath.MIN_SQRT_PRICE).toBe(4295128739n)
    expect(TickMath.MAX_SQRT_PRICE).toBe(1461446703485210103287273052203988822378723970342n)
    expect(getSqrtPriceAtTick(0)).toBe(1n << 96n)
  })

  it('getSqrtPriceAtTick matches Solidity vectors', () => {
    for (const v of sqrtAtTick) expect(getSqrtPriceAtTick(v.tick), `tick ${v.tick}`).toBe(v.sqrtPriceX96)
  })

  it('getTickAtSqrtPrice matches Solidity vectors (boundary prices and +/- 1)', () => {
    for (const v of tickAtSqrt) expect(getTickAtSqrtPrice(v.sqrtPriceX96), `price ${v.sqrtPriceX96}`).toBe(v.tick)
  })

  it('round-trips every tick in a dense band and many random ticks', () => {
    const check = (t: number) => {
      const p = getSqrtPriceAtTick(t)
      // MAX_SQRT_PRICE itself is not a valid input to getTickAtSqrtPrice (the price can never reach it)
      if (t < MAX_TICK) expect(getTickAtSqrtPrice(p), `tick ${t}`).toBe(t)
      if (t < MAX_TICK) {
        // p is the smallest price mapping to t, p-1 maps to t-1; the next tick's price - 1 still maps to t
        expect(getTickAtSqrtPrice(getSqrtPriceAtTick(t + 1) - 1n), `tick ${t} upper edge`).toBe(t)
        if (t > MIN_TICK) expect(getTickAtSqrtPrice(p - 1n), `tick ${t} lower edge`).toBe(t - 1)
      }
    }
    for (let t = -2000; t <= 2000; t++) check(t)
    const r = rng(42)
    for (let i = 0; i < 3000; i++) check(Math.floor(r() * (MAX_TICK - MIN_TICK + 1)) + MIN_TICK)
    for (const t of [MIN_TICK, MIN_TICK + 1, MAX_TICK - 1, MAX_TICK]) check(t)
  })

  it('getSqrtPriceAtTick is strictly increasing', () => {
    let prev = getSqrtPriceAtTick(MIN_TICK)
    for (let t = MIN_TICK + 1; t <= MIN_TICK + 500; t++) {
      const p = getSqrtPriceAtTick(t)
      expect(p > prev).toBe(true)
      prev = p
    }
    prev = getSqrtPriceAtTick(-300)
    for (let t = -299; t <= 300; t++) {
      const p = getSqrtPriceAtTick(t)
      expect(p > prev).toBe(true)
      prev = p
    }
  })

  it('rejects out-of-range inputs like the Solidity library', () => {
    expect(() => getSqrtPriceAtTick(MIN_TICK - 1)).toThrow(InvalidTickError)
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow(InvalidTickError)
    expect(() => getSqrtPriceAtTick(1.5)).toThrow(InvalidTickError)
    expect(() => getTickAtSqrtPrice(MIN_SQRT_PRICE - 1n)).toThrow(InvalidSqrtPriceError)
    expect(() => getTickAtSqrtPrice(MAX_SQRT_PRICE)).toThrow(InvalidSqrtPriceError)
    expect(getTickAtSqrtPrice(MAX_SQRT_PRICE - 1n)).toBe(MAX_TICK - 1)
    expect(getTickAtSqrtPrice(MIN_SQRT_PRICE)).toBe(MIN_TICK)
  })

  it('usable ticks and bit helpers', () => {
    expect(maxUsableTick(60)).toBe(887220)
    expect(minUsableTick(60)).toBe(-887220)
    expect(maxUsableTick(1)).toBe(MAX_TICK)
    expect(mostSignificantBit(1n)).toBe(0)
    expect(mostSignificantBit((1n << 255n) + 5n)).toBe(255)
    expect(leastSignificantBit(1n << 200n)).toBe(200)
    expect(leastSignificantBit(6n)).toBe(1)
    expect(() => mostSignificantBit(0n)).toThrow()
  })
})
