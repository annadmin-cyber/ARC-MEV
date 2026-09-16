import { describe, expect, it } from 'vitest'
import { feePolicy, median, mulRatio } from '../../src/exec/gas.js'
import { testConfig } from './helpers.js'

const GWEI = 1_000_000_000n
const USDC = 10n ** 18n
const cfg = testConfig()

describe('feePolicy', () => {
  it('uses the defaults: TIP_SHARE 0.5, 25 gwei floor, 10000 gwei tip cap, 25000 gwei fee cap, safety 1.5', () => {
    expect(cfg.TIP_SHARE).toBe(0.5)
    expect(cfg.MIN_PRIORITY_FEE_WEI).toBe(25n * GWEI)
    expect(cfg.MAX_PRIORITY_FEE_WEI).toBe(10_000n * GWEI)
    expect(cfg.MAX_FEE_PER_GAS_WEI).toBe(25_000n * GWEI)
    expect(cfg.GAS_SAFETY).toBe(1.5)
  })

  it('bids TIP_SHARE of the profit per gas unit and prices the transaction', () => {
    const gasLimit = 1_500_000n
    const baseFee = 75n * GWEI
    const q = feePolicy(cfg, baseFee, USDC, gasLimit)
    expect(q).not.toBeNull()
    // floor(0.5e18 / 1.5e6) = 333_333_333_333 wei per gas
    expect(q!.maxPriorityFeePerGas).toBe(333_333_333_333n)
    expect(q!.maxFeePerGas).toBe(2n * baseFee + 333_333_333_333n)
    expect(q!.gasCost).toBe(gasLimit * (baseFee + 333_333_333_333n))
    expect(q!.safeGasCost).toBe((q!.gasCost * 3n) / 2n)
    expect(q!.net).toBe(USDC - q!.safeGasCost)
    expect(q!.net).toBeGreaterThan(0n)
  })

  it('clamps the tip to the floor for tiny profits and to the cap for huge ones', () => {
    const small = feePolicy(cfg, 20n * GWEI, 1_000_000n, 1_500_000n)
    expect(small!.maxPriorityFeePerGas).toBe(25n * GWEI)
    const zero = feePolicy(cfg, 20n * GWEI, 0n, 1_500_000n)
    expect(zero!.maxPriorityFeePerGas).toBe(25n * GWEI)
    const negative = feePolicy(cfg, 20n * GWEI, -USDC, 1_500_000n)
    expect(negative!.maxPriorityFeePerGas).toBe(25n * GWEI)
    expect(negative!.net).toBeLessThan(-USDC)
    const huge = feePolicy(cfg, 20n * GWEI, 1_000_000n * USDC, 1_500_000n)
    expect(huge!.maxPriorityFeePerGas).toBe(10_000n * GWEI)
  })

  it('caps maxFeePerGas at MAX_FEE_PER_GAS_WEI while baseFee + tip still fits', () => {
    const q = feePolicy(cfg, 13_000n * GWEI, USDC, 1_500_000n)
    // 2 * 13000 + 333 > 25000 -> capped; 13000 + 333 fits.
    expect(q!.maxFeePerGas).toBe(25_000n * GWEI)
    expect(q!.maxPriorityFeePerGas).toBe(333_333_333_333n)
    const under = feePolicy(cfg, 12_000n * GWEI, 1_000_000n, 1_500_000n)
    expect(under!.maxFeePerGas).toBe(24_025n * GWEI)
  })

  it('returns null when even baseFee + tip exceeds the cap (cannot bid)', () => {
    expect(feePolicy(cfg, 20_000n * GWEI, 1_000_000n * USDC, 1_500_000n)).toBeNull()
    expect(feePolicy(cfg, 24_990n * GWEI, 0n, 1_500_000n)).toBeNull()
    expect(feePolicy(cfg, 24_975n * GWEI, 0n, 1_500_000n)).not.toBeNull()
  })

  it('never lets the floor push the tip above the cap and honours a custom share', () => {
    const custom = testConfig({ MIN_PRIORITY_FEE_WEI: '20000000000000', MAX_PRIORITY_FEE_WEI: '10000000000000', TIP_SHARE: '0.1' })
    expect(feePolicy(custom, 20n * GWEI, 0n, 1_000_000n)!.maxPriorityFeePerGas).toBe(10_000n * GWEI)
    const share = testConfig({ TIP_SHARE: '0.1' })
    expect(feePolicy(share, 20n * GWEI, 10n * USDC, 1_000_000n)!.maxPriorityFeePerGas).toBe(USDC / 1_000_000n)
  })

  it('rejects a non-positive gas limit and a negative base fee', () => {
    expect(() => feePolicy(cfg, 20n * GWEI, USDC, 0n)).toThrow(RangeError)
    expect(() => feePolicy(cfg, -1n, USDC, 1n)).toThrow(RangeError)
  })
})

describe('helpers', () => {
  it('mulRatio rounds down and rejects invalid ratios', () => {
    expect(mulRatio(1000n, 1.5)).toBe(1500n)
    expect(mulRatio(7n, 0.5)).toBe(3n)
    expect(mulRatio(10n ** 30n, 0.123456)).toBe(123456n * 10n ** 24n)
    expect(() => mulRatio(1n, -1)).toThrow(RangeError)
    expect(() => mulRatio(1n, Number.NaN)).toThrow(RangeError)
  })

  it('median picks the lower middle element', () => {
    expect(median([])).toBeUndefined()
    expect(median([5n])).toBe(5n)
    expect(median([9n, 1n, 5n])).toBe(5n)
    expect(median([4n, 1n, 3n, 2n])).toBe(2n)
  })
})
