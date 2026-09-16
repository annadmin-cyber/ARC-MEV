import { describe, expect, it } from 'vitest'
import { fromLog, isBetterSample, optimizeInput, type ProfitSample } from '../../src/strategy/optimize.js'
import { analyticTwoHopOptimum, cpmmSimulator, pid, reservesOf, stateFromReserves } from './helpers.js'

const E18 = 10n ** 18n

describe('optimizeInput', () => {
  it('finds the analytic optimum for two constant-product pools within 0.1%', () => {
    // Pool 1: 1,000,000 A vs 1,100,000 B (A is cheap here). Pool 2: 1,000,000 B vs 1,000,000 A.
    const p1 = stateFromReserves(pid(1), 1_000_000n * E18, 1_100_000n * E18, 3000)
    const p2 = stateFromReserves(pid(2), 1_000_000n * E18, 1_000_000n * E18, 500)
    const r1 = reservesOf(p1)
    const r2 = reservesOf(p2)
    // A -> B in p1 (zeroForOne), B -> A in p2 (B is currency0 of p2 in this fixture: zeroForOne).
    const profit = (x: bigint): ProfitSample => {
      const out1 = cpmmSimulator(p1, true, x).amountOut
      const out2 = cpmmSimulator(p2, true, out1).amountOut
      return { amountIn: x, amountOut: out2, profit: out2 - x, truncated: false }
    }
    const res = optimizeInput(profit, { minInput: E18 / 1000n, maxInput: 1_000_000n * E18 })
    expect(res).not.toBeNull()
    const best = (res as NonNullable<typeof res>).best
    const expected = analyticTwoHopOptimum(r1.r0, r1.r1, r2.r0, r2.r1, 0.003, 0.0005)
    const relErr = Math.abs(Number(best.amountIn) - expected) / expected
    expect(relErr).toBeLessThan(1e-3)
    expect(best.profit).toBeGreaterThan(0n)
    // Nothing nearby yields more profit (the curve is flat to integer precision within ~1e12 wei
    // of the optimum, so equality is allowed; strictly more is not).
    for (const dx of [1n, 1000n, 10n ** 15n, E18, 100n * E18]) {
      expect(profit(best.amountIn + dx).profit).toBeLessThanOrEqual(best.profit)
      expect(profit(best.amountIn - dx).profit).toBeLessThanOrEqual(best.profit)
    }
    expect(profit(best.amountIn + 100n * E18).profit).toBeLessThan(best.profit)
    expect(profit(best.amountIn - 100n * E18).profit).toBeLessThan(best.profit)
    expect((res as NonNullable<typeof res>).evaluations).toBeLessThan(120)
  })

  it('handles a non-concave curve via the coarse grid', () => {
    // Two bumps: a small one near 1e6 and the global maximum near 1e12.
    const bump = (x: number, c: number, h: number): number => h * Math.exp(-((Math.log(x) - Math.log(c)) ** 2) / 0.5)
    const f = (x: bigint): ProfitSample => {
      const v = Number(x)
      const p = BigInt(Math.round(bump(v, 1e6, 1e5) + bump(v, 1e12, 1e11)))
      return { amountIn: x, amountOut: x + p, profit: p, truncated: false }
    }
    const res = optimizeInput(f, { minInput: 1n, maxInput: 10n ** 15n })
    const best = (res as NonNullable<typeof res>).best
    const relErr = Math.abs(Number(best.amountIn) - 1e12) / 1e12
    expect(relErr).toBeLessThan(1e-3)
  })

  it('degenerate intervals', () => {
    const f = (x: bigint): ProfitSample => ({ amountIn: x, amountOut: x, profit: 0n, truncated: false })
    expect(optimizeInput(f, { minInput: 10n, maxInput: 5n })).toBeNull()
    const single = optimizeInput(f, { minInput: 7n, maxInput: 7n })
    expect(single?.best.amountIn).toBe(7n)
    expect(single?.evaluations).toBe(1)
  })

  it('prefers exact over truncated and smaller inputs on ties', () => {
    const a: ProfitSample = { amountIn: 10n, amountOut: 15n, profit: 5n, truncated: false }
    const b: ProfitSample = { amountIn: 10n, amountOut: 15n, profit: 5n, truncated: true }
    const c: ProfitSample = { amountIn: 9n, amountOut: 14n, profit: 5n, truncated: false }
    expect(isBetterSample(a, b)).toBe(true)
    expect(isBetterSample(b, a)).toBe(false)
    expect(isBetterSample(c, a)).toBe(true)
    expect(isBetterSample({ ...b, profit: 6n }, a)).toBe(true)
  })

  it('fromLog clamps into range', () => {
    expect(fromLog(-100, 5n, 10n)).toBe(5n)
    expect(fromLog(100, 5n, 10n)).toBe(10n)
    expect(fromLog(Math.log(7), 5n, 10n)).toBe(7n)
    expect(fromLog(1e6, 5n, 10n)).toBe(10n)
  })
})
