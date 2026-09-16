import { describe, expect, it } from 'vitest'
import {
  calculateSwapFee,
  getOneForZeroFee,
  getZeroForOneFee,
  protocolFeeShare,
  swapFeeFor,
} from '../../src/math/protocolFee.js'
import { priceOf, spotPrice1Per0 } from '../../src/math/price.js'
import { swapFees } from './fixtures.js'
import { fixtureState } from './helpers.js'

describe('ProtocolFee', () => {
  it('calculateSwapFee matches Solidity vectors', () => {
    for (const v of swapFees) expect(calculateSwapFee(v.protocolFee, v.lpFee), `${v.protocolFee}/${v.lpFee}`).toBe(v.swapFee)
  })

  it('extracts the per-direction protocol fee from the packed uint24', () => {
    const packed = 500 | (1000 << 12)
    expect(getZeroForOneFee(packed)).toBe(500)
    expect(getOneForZeroFee(packed)).toBe(1000)
    expect(swapFeeFor(packed, 3000, true)).toBe(500n + 3000n - 1n)
    expect(swapFeeFor(packed, 3000, false)).toBe(1000n + 3000n - 3n)
    expect(swapFeeFor(0, 3000, true)).toBe(3000n)
    expect(swapFeeFor(0, 3000, false)).toBe(3000n)
  })

  it('protocol share follows Pool.swap', () => {
    expect(protocolFeeShare(100n, 10n, 3000n, 0)).toBe(0n)
    expect(protocolFeeShare(1_000_000n, 500n, 500n, 500)).toBe(500n) // lp fee 0 -> everything to the protocol
    expect(protocolFeeShare(997_000n, 3_000n, 3499n, 500)).toBe(500n) // (997000 + 3000) * 500 / 1e6
  })
})

describe('priceOf', () => {
  it('returns fee-adjusted marginal prices that are reciprocal across directions', () => {
    const state = fixtureState('main')
    expect(spotPrice1Per0(state)).toBeCloseTo(1, 12)
    expect(priceOf(state, true)).toBeCloseTo(0.997, 12)
    expect(priceOf(state, false)).toBeCloseTo(0.997, 12)
    const pf = fixtureState('pf')
    // calculateSwapFee(500, 500) = 1000, calculateSwapFee(1000, 500) = 1500
    expect(priceOf(pf, true)).toBeCloseTo(1 - 1000 / 1e6, 12)
    expect(priceOf(pf, false)).toBeCloseTo(1 - 1500 / 1e6, 12)
    expect(priceOf({ ...state, sqrtPriceX96: 0n }, true)).toBe(0)
    const skewed = { ...state, sqrtPriceX96: 2n ** 96n * 2n, lpFee: 0 }
    expect(priceOf(skewed, true)).toBeCloseTo(4, 12)
    expect(priceOf(skewed, false)).toBeCloseTo(0.25, 12)
  })
})
