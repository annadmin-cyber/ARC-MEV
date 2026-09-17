import { describe, expect, it } from 'vitest'
import { createPublicClient, custom, type PublicClient } from 'viem'
import { feePolicy, median, mulRatio, parseNextBaseFee, readNextBaseFee } from '../../src/exec/gas.js'
import { formatFixed } from '../../src/exec/pipeline.js'
import { rpcHeader, testConfig } from './helpers.js'

const GWEI = 1_000_000_000n
const USDC = 10n ** 18n
// The arithmetic cases below pin explicit fee parameters so they do not drift with the defaults.
const cfg = testConfig({ TIP_SHARE: '0.5', MIN_PRIORITY_FEE_WEI: '25000000000', MAX_PRIORITY_FEE_WEI: '10000000000000' })

describe('feePolicy', () => {
  it('ships defaults tuned to launch-day economics: TIP_SHARE 0.3, 100 gwei floor, 5000 gwei tip cap, 25000 gwei fee cap, 0.15 USDC min profit', () => {
    const defaults = testConfig()
    expect(defaults.TIP_SHARE).toBe(0.3)
    expect(defaults.MIN_PRIORITY_FEE_WEI).toBe(100n * GWEI)
    expect(defaults.MAX_PRIORITY_FEE_WEI).toBe(5_000n * GWEI)
    expect(defaults.MAX_FEE_PER_GAS_WEI).toBe(25_000n * GWEI)
    expect(defaults.GAS_SAFETY).toBe(1.5)
    expect(defaults.MIN_PROFIT_USDC_WEI).toBe(15n * 10n ** 16n)
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

describe('readNextBaseFee', () => {
  /** Header fields of an Arc mainnet block whose extraData announces the next base fee (130.86 gwei). */
  const ARC_HEADER = { number: 21_112_099n, baseFeePerGas: 121_598_711_914n, extraData: '0x0000001e78249c77' as const }

  it('parses the 8-byte big-endian extraData as the next base fee', () => {
    const parsed = parseNextBaseFee(ARC_HEADER)
    expect(parsed).toEqual({ nextBaseFee: 130_864_684_151n, baseFee: 121_598_711_914n, block: 21_112_099n, source: 'extraData' })
    expect(formatFixed(parsed.nextBaseFee, 9, 2)).toBe('130.86')
  })

  it('falls back to baseFee * 1125 / 1000 when extraData is not exactly 8 bytes', () => {
    expect(parseNextBaseFee({ ...ARC_HEADER, extraData: '0x' })).toMatchObject({ nextBaseFee: 136_798_550_903n, source: 'fallback' })
    expect(parseNextBaseFee({ ...ARC_HEADER, extraData: '0x0000001e78249c7700' })).toMatchObject({ source: 'fallback' })
    expect(parseNextBaseFee({ ...ARC_HEADER, extraData: undefined })).toMatchObject({ source: 'fallback' })
    expect(() => parseNextBaseFee({ ...ARC_HEADER, baseFeePerGas: null })).toThrow(/baseFeePerGas/)
  })

  it('reads the header of the given block and retries while the node has not served it', async () => {
    let attempts = 0
    const calls: unknown[] = []
    const client = createPublicClient({
      transport: custom(
        {
          request: async ({ method, params }: { method: string; params: unknown[] }) => {
            calls.push([method, params])
            if (method !== 'eth_getBlockByNumber') throw new Error(`unexpected ${method}`)
            attempts++
            if (attempts < 3) throw { code: -32001, message: 'block not found' }
            return rpcHeader(21_112_099n, '0x0000001e78249c77')
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient
    const fee = await readNextBaseFee({ http: client }, 21_112_099n)
    expect(fee).toEqual({ nextBaseFee: 130_864_684_151n, baseFee: 121_598_711_914n, block: 21_112_099n, source: 'extraData' })
    expect(attempts).toBe(3)
    expect(calls[0]).toEqual(['eth_getBlockByNumber', ['0x1422523', false]])
  })
})
