import { describe, expect, it } from 'vitest'
import { MAX_SWAP_FEE, computeSwapStep, getSqrtPriceTarget } from '../../src/math/swapMath.js'
import { swapSteps } from './fixtures.js'

describe('SwapMath', () => {
  it('MAX_SWAP_FEE is 1e6', () => {
    expect(MAX_SWAP_FEE).toBe(1_000_000n)
  })

  it('getSqrtPriceTarget picks the nearer of next tick and limit', () => {
    expect(getSqrtPriceTarget(true, 100n, 50n)).toBe(100n)
    expect(getSqrtPriceTarget(true, 40n, 50n)).toBe(50n)
    expect(getSqrtPriceTarget(false, 100n, 150n)).toBe(100n)
    expect(getSqrtPriceTarget(false, 200n, 150n)).toBe(150n)
    expect(getSqrtPriceTarget(false, 150n, 150n)).toBe(150n)
    expect(getSqrtPriceTarget(true, 150n, 150n)).toBe(150n)
  })

  it('computeSwapStep matches Solidity vectors exactly', () => {
    expect(swapSteps.length).toBeGreaterThanOrEqual(12)
    for (const v of swapSteps) {
      const r = computeSwapStep(v.sqrtPriceCurrentX96, v.sqrtPriceTargetX96, v.liquidity, v.amountRemaining, v.feePips)
      const label = `cur=${v.sqrtPriceCurrentX96} target=${v.sqrtPriceTargetX96} L=${v.liquidity} amt=${v.amountRemaining} fee=${v.feePips}`
      expect(r.sqrtPriceNextX96, label).toBe(v.sqrtPriceNextX96)
      expect(r.amountIn, label).toBe(v.amountIn)
      expect(r.amountOut, label).toBe(v.amountOut)
      expect(r.feeAmount, label).toBe(v.feeAmount)
    }
  })

  it('exact input never consumes more than the remaining amount', () => {
    for (const v of swapSteps) {
      if (v.amountRemaining >= 0n) continue
      const r = computeSwapStep(v.sqrtPriceCurrentX96, v.sqrtPriceTargetX96, v.liquidity, v.amountRemaining, v.feePips)
      expect(r.amountIn + r.feeAmount <= -v.amountRemaining).toBe(true)
    }
  })

  it('accepts feePips as number or bigint', () => {
    const v = swapSteps[0]!
    const a = computeSwapStep(v.sqrtPriceCurrentX96, v.sqrtPriceTargetX96, v.liquidity, v.amountRemaining, Number(v.feePips))
    const b = computeSwapStep(v.sqrtPriceCurrentX96, v.sqrtPriceTargetX96, v.liquidity, v.amountRemaining, v.feePips)
    expect(a).toEqual(b)
  })
})
