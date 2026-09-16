import { describe, expect, it } from 'vitest'
import { MAX_UINT128, MAX_UINT256, MathError, mulDiv, mulDivRoundingUp, divRoundingUp, toUint160 } from '../../src/math/fullMath.js'
import {
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromAmount0RoundingUp,
  getNextSqrtPriceFromAmount1RoundingDown,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
} from '../../src/math/sqrtPriceMath.js'
import { amount0Deltas, amount1Deltas, nextFromInput, nextFromOutput } from './fixtures.js'

const P1 = 1n << 96n

describe('FullMath', () => {
  it('mulDiv / mulDivRoundingUp match uint256 semantics', () => {
    expect(mulDiv(MAX_UINT256, MAX_UINT256, MAX_UINT256)).toBe(MAX_UINT256)
    expect(mulDiv(7n, 3n, 2n)).toBe(10n)
    expect(mulDivRoundingUp(7n, 3n, 2n)).toBe(11n)
    expect(mulDivRoundingUp(6n, 3n, 2n)).toBe(9n)
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(MathError)
    expect(() => mulDiv(MAX_UINT256, 2n, 1n)).toThrow(MathError)
    expect(() => mulDivRoundingUp(MAX_UINT256, MAX_UINT256, MAX_UINT256 - 1n)).toThrow(MathError)
    expect(divRoundingUp(10n, 3n)).toBe(4n)
    expect(divRoundingUp(9n, 3n)).toBe(3n)
    expect(divRoundingUp(9n, 0n)).toBe(0n)
    expect(() => toUint160(1n << 160n)).toThrow(MathError)
  })
})

describe('SqrtPriceMath', () => {
  it('getAmount0Delta matches Solidity vectors (both roundings)', () => {
    for (const v of amount0Deltas) {
      expect(getAmount0Delta(v.a, v.b, v.liquidity, v.roundUp), `${v.a},${v.b},${v.liquidity},${v.roundUp}`).toBe(v.result)
    }
  })

  it('getAmount1Delta matches Solidity vectors (both roundings)', () => {
    for (const v of amount1Deltas) {
      expect(getAmount1Delta(v.a, v.b, v.liquidity, v.roundUp), `${v.a},${v.b},${v.liquidity},${v.roundUp}`).toBe(v.result)
    }
  })

  it('getNextSqrtPriceFromInput / Output match Solidity vectors', () => {
    for (const v of nextFromInput) {
      expect(getNextSqrtPriceFromInput(v.sqrtPX96, v.liquidity, v.amount, v.zeroForOne)).toBe(v.result)
    }
    for (const v of nextFromOutput) {
      expect(getNextSqrtPriceFromOutput(v.sqrtPX96, v.liquidity, v.amount, v.zeroForOne)).toBe(v.result)
    }
  })

  it('rounding directions: up never below down, deltas symmetric in price order', () => {
    const a = P1
    const b = P1 + 123456789n
    expect(getAmount0Delta(a, b, 1_000_000n, true) >= getAmount0Delta(a, b, 1_000_000n, false)).toBe(true)
    expect(getAmount0Delta(b, a, 1_000_000n, true)).toBe(getAmount0Delta(a, b, 1_000_000n, true))
    expect(getAmount1Delta(b, a, 1_000_000n, false)).toBe(getAmount1Delta(a, b, 1_000_000n, false))
    expect(getAmount1Delta(a, a, 5n, true)).toBe(0n)
    expect(getAmount0Delta(a, a, 5n, true)).toBe(0n)
  })

  it('reverts map to MathError', () => {
    expect(() => getNextSqrtPriceFromInput(0n, 1n, 1n, true)).toThrow('InvalidPriceOrLiquidity')
    expect(() => getNextSqrtPriceFromInput(P1, 0n, 1n, true)).toThrow('InvalidPriceOrLiquidity')
    expect(() => getNextSqrtPriceFromOutput(P1, 0n, 1n, true)).toThrow('InvalidPriceOrLiquidity')
    expect(() => getAmount0Delta(0n, P1, 1n, true)).toThrow('InvalidPrice')
    // removing more currency1 than the price allows
    expect(() => getNextSqrtPriceFromAmount1RoundingDown(P1, 1n, 2n, false)).toThrow('NotEnoughLiquidity')
    // removing more currency0 than the virtual reserves hold
    expect(() => getNextSqrtPriceFromAmount0RoundingUp(P1, 1n, 2n, false)).toThrow('PriceOverflow')
    // adding currency1 past uint160
    expect(() => getNextSqrtPriceFromAmount1RoundingDown(P1, 1n, 1n << 100n, true)).toThrow(MathError)
    expect(getNextSqrtPriceFromAmount0RoundingUp(P1, 5n, 0n, true)).toBe(P1)
  })

  it('getNextSqrtPriceFromAmount0RoundingUp uses the overflow fallback consistently', () => {
    // amount * sqrtP overflows uint256 -> liquidity / (liquidity / sqrtP + amount) path
    const huge = 1n << 200n
    const r = getNextSqrtPriceFromAmount0RoundingUp(P1, MAX_UINT128, huge, true)
    expect(r).toBe(divRoundingUp(MAX_UINT128 << 96n, (MAX_UINT128 << 96n) / P1 + huge))
  })
})
