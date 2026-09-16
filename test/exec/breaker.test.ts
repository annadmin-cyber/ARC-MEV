import { describe, expect, it } from 'vitest'
import { CircuitBreaker, GasBudget, SendGate } from '../../src/exec/breaker.js'
import { testConfig } from './helpers.js'

const USDC = 10n ** 18n

describe('CircuitBreaker', () => {
  it('trips after maxConsecutive failures and pauses for pauseBlocks', () => {
    const b = new CircuitBreaker(3, 120)
    expect(b.allows(100n)).toBe(true)
    expect(b.recordFailure(100n)).toBe(false)
    expect(b.recordFailure(101n)).toBe(false)
    expect(b.allows(102n)).toBe(true)
    expect(b.recordFailure(102n)).toBe(true)
    expect(b.tripCount).toBe(1)
    expect(b.pausedUntilBlock()).toBe(222n)
    expect(b.allows(103n)).toBe(false)
    expect(b.allows(221n)).toBe(false)
    expect(b.allows(222n)).toBe(true)
    expect(b.pausedUntilBlock()).toBeUndefined()
    expect(b.consecutiveFailures).toBe(0)
  })

  it('a success resets the streak', () => {
    const b = new CircuitBreaker(2, 10)
    b.recordFailure(1n)
    b.recordSuccess()
    expect(b.recordFailure(2n)).toBe(false)
    expect(b.allows(3n)).toBe(true)
    expect(b.recordFailure(3n)).toBe(true)
    expect(b.allows(3n)).toBe(false)
  })

  it('validates its parameters', () => {
    expect(() => new CircuitBreaker(0, 1)).toThrow(RangeError)
    expect(() => new CircuitBreaker(1, 0)).toThrow(RangeError)
    expect(() => new CircuitBreaker(1.5, 1)).toThrow(RangeError)
  })
})

describe('GasBudget', () => {
  it('sums the window and blocks once the budget is reached, freeing when old spend rolls out', () => {
    const g = new GasBudget(5n * USDC, 100)
    g.record(1000n, 2n * USDC)
    g.record(1050n, 2n * USDC)
    expect(g.spent(1050n)).toBe(4n * USDC)
    expect(g.allows(1050n)).toBe(true)
    g.record(1060n, USDC)
    expect(g.spent(1060n)).toBe(5n * USDC)
    expect(g.allows(1060n)).toBe(false)
    // The block-1000 entry leaves the window at block 1100 (window is (block - 100, block]).
    expect(g.freesAt(1060n)).toBe(1100n)
    expect(g.allows(1099n)).toBe(false)
    expect(g.spent(1100n)).toBe(3n * USDC)
    expect(g.allows(1100n)).toBe(true)
    expect(g.freesAt(1100n)).toBe(1100n)
  })

  it('ignores non-positive costs and validates its parameters', () => {
    const g = new GasBudget(USDC, 10)
    g.record(1n, 0n)
    g.record(1n, -5n)
    expect(g.spent(1n)).toBe(0n)
    expect(() => new GasBudget(-1n, 10)).toThrow(RangeError)
    expect(() => new GasBudget(1n, 0)).toThrow(RangeError)
  })
})

describe('SendGate', () => {
  it('is built from config and reports why sending is blocked', () => {
    const gate = new SendGate(testConfig({ MAX_CONSECUTIVE_REVERTS: '2', BREAKER_PAUSE_BLOCKS: '5', GAS_BUDGET_USDC_WEI: (3n * USDC).toString(), GAS_BUDGET_WINDOW_BLOCKS: '50' }))
    expect(gate.check(10n)).toBeUndefined()

    expect(gate.onReceipt(10n, 'reverted', USDC)).toBe(false)
    expect(gate.onLost(11n)).toBe(true)
    expect(gate.check(12n)).toEqual({ kind: 'breaker', until: 16n })
    expect(gate.check(16n)).toBeUndefined()

    expect(gate.onReceipt(16n, 'success', USDC)).toBe(false)
    expect(gate.onReceipt(17n, 'success', USDC)).toBe(false)
    expect(gate.check(18n)).toEqual({ kind: 'gas-budget', spent: 3n * USDC, budget: 3n * USDC, freesAt: 60n })
    expect(gate.check(60n)).toBeUndefined()
  })

  it('uses the documented defaults: 3 reverts, 120 blocks, 5 USDC per 7200 blocks', () => {
    const gate = new SendGate(testConfig())
    expect(gate.breaker.maxConsecutive).toBe(3)
    expect(gate.breaker.pauseBlocks).toBe(120)
    expect(gate.budget.budget).toBe(5n * USDC)
    expect(gate.budget.windowBlocks).toBe(7200)
  })
})
