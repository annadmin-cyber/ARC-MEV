import { describe, expect, it } from 'vitest'
import { feePolicy, parseNextBaseFee } from '../../src/exec/gas.js'
import { effectiveTip, quantile, TipMarket, topTips } from '../../src/exec/market.js'
import { quoteCandidates, type Candidate } from '../../src/exec/pipeline.js'
import type { EvaluatedOpportunity } from '../../src/strategy/index.js'
import { CYCLE, testConfig } from './helpers.js'

const GWEI = 1_000_000_000n
const USDC = 10n ** 18n

describe('effective tips and quantiles', () => {
  const baseFee = 20n * GWEI
  it('is min(priority, maxFee - baseFee) for 1559 transactions and gasPrice - baseFee for legacy ones', () => {
    expect(effectiveTip({ maxPriorityFeePerGas: 1000n * GWEI, maxFeePerGas: 5000n * GWEI }, baseFee)).toBe(1000n * GWEI)
    expect(effectiveTip({ maxPriorityFeePerGas: 1000n * GWEI, maxFeePerGas: 25n * GWEI }, baseFee)).toBe(5n * GWEI)
    expect(effectiveTip({ gasPrice: 30n * GWEI }, baseFee)).toBe(10n * GWEI)
    expect(effectiveTip({ gasPrice: 20n * GWEI }, baseFee)).toBe(0n)
    expect(effectiveTip({}, baseFee)).toBe(0n)
  })

  it('topTips returns the largest tips of a block, descending', () => {
    const txs = [{ gasPrice: 21n * GWEI }, { maxPriorityFeePerGas: 13022n * GWEI, maxFeePerGas: 20000n * GWEI }, { maxPriorityFeePerGas: 8214n * GWEI, maxFeePerGas: 20000n * GWEI }, { maxPriorityFeePerGas: 0n, maxFeePerGas: 20n * GWEI }]
    expect(topTips(txs, baseFee)).toEqual([13022n * GWEI, 8214n * GWEI, 1n * GWEI])
    expect(topTips([], baseFee)).toEqual([])
  })

  it('quantile is nearest-rank on the sorted values', () => {
    const v = [5n, 1n, 4n, 2n, 3n]
    expect(quantile(v, 0)).toBe(1n)
    expect(quantile(v, 0.5)).toBe(3n)
    expect(quantile(v, 0.75)).toBe(4n)
    expect(quantile(v, 1)).toBe(5n)
    expect(quantile([], 0.5)).toBeUndefined()
  })

  it('parseNextBaseFee carries the header transactions’ top tips (none for a hash-only header)', () => {
    const header = { number: 1n, baseFeePerGas: baseFee, extraData: '0x0000001e78249c77' as const }
    expect(parseNextBaseFee(header).topTips).toEqual([])
    expect(parseNextBaseFee({ ...header, transactions: ['0xabc' as const] }).topTips).toEqual([])
    const withTxs = { ...header, transactions: [{ maxPriorityFeePerGas: 500n * GWEI, maxFeePerGas: 1000n * GWEI }, { gasPrice: 25n * GWEI }] }
    expect(parseNextBaseFee(withTxs).topTips).toEqual([500n * GWEI, 5n * GWEI])
  })
})

describe('TipMarket', () => {
  const cfg = testConfig({ MARKET_TIP_BLOCKS: '4', MARKET_TIP_QUANTILE: '0.75', MARKET_TIP_MARGIN: '1.1' }) // explicit: the defaults are 0.9 / 1.25

  it('keeps the last N blocks’ top tips, ignores replays, and requires quantile x margin', () => {
    const m = new TipMarket(cfg)
    expect(m.requiredTip()).toBeUndefined()
    m.record(10n, 100n * GWEI)
    m.record(11n, undefined) // empty block counts as 0
    m.record(11n, 999n * GWEI) // replayed block: ignored
    m.record(12n, 3000n * GWEI)
    m.record(13n, 200n * GWEI)
    // window [100, 0, 3000, 200] -> p75 = 200 (nearest rank of 4 values: ceil(3) = index 2 of sorted [0,100,200,3000])
    expect(m.requiredTip()).toBe(220n * GWEI)
    m.record(14n, 5000n * GWEI) // window [0, 3000, 200, 5000] -> p75 = 3000
    expect(m.requiredTip()).toBe(3300n * GWEI)
    expect(m.snapshot()).toEqual({ blocks: 4, p50: 200n * GWEI, p75: 3000n * GWEI, p90: 5000n * GWEI, required: 3300n * GWEI })
  })

  it('is off when MARKET_TIP_GATE=false', () => {
    const m = new TipMarket(testConfig({ MARKET_TIP_GATE: 'false' }))
    m.record(1n, 5000n * GWEI)
    expect(m.requiredTip()).toBeUndefined()
    expect(m.snapshot().required).toBeNull()
  })
})

describe('feePolicy with a market tip', () => {
  // TIP_SHARE 0.3 of 1 USDC over 200k gas = 1500 gwei; MAX_TIP_SHARE 0.8 affords 4000 gwei.
  const cfg = testConfig({ TIP_SHARE: '0.3', MAX_TIP_SHARE: '0.8', MIN_PRIORITY_FEE_WEI: '100000000000', MAX_PRIORITY_FEE_WEI: '15000000000000' })
  const baseFee = 20n * GWEI
  const gas = 200_000n

  it('bids TIP_SHARE when the market is below it', () => {
    const q = feePolicy(cfg, baseFee, USDC, gas, 1000n * GWEI)!
    expect(q.maxPriorityFeePerGas).toBe(1500n * GWEI)
    expect(q.outbid).toBe(false)
    expect(q.marketTip).toBe(1000n * GWEI)
  })

  it('raises the bid to the market rate while MAX_TIP_SHARE affords it', () => {
    const q = feePolicy(cfg, baseFee, USDC, gas, 3500n * GWEI)!
    expect(q.maxPriorityFeePerGas).toBe(3500n * GWEI)
    expect(q.outbid).toBe(false)
    expect(q.gasCost).toBe(gas * (baseFee + 3500n * GWEI))
  })

  it('flags outbid (bidding the affordable maximum) when the market rate is beyond MAX_TIP_SHARE', () => {
    const q = feePolicy(cfg, baseFee, USDC, gas, 8000n * GWEI)!
    expect(q.maxPriorityFeePerGas).toBe(4000n * GWEI)
    expect(q.outbid).toBe(true)
  })

  it('never exceeds MAX_PRIORITY_FEE_WEI even for a rich opportunity', () => {
    const q = feePolicy(cfg, baseFee, 100n * USDC, gas, 20_000n * GWEI)!
    expect(q.maxPriorityFeePerGas).toBe(15_000n * GWEI)
    expect(q.outbid).toBe(true)
  })

  it('behaves as before without a market tip', () => {
    const q = feePolicy(cfg, baseFee, USDC, gas)!
    expect(q.maxPriorityFeePerGas).toBe(1500n * GWEI)
    expect(q.outbid).toBe(false)
    expect(q.marketTip).toBeUndefined()
  })
})

describe('quoteCandidates with a market tip', () => {
  const cfg = testConfig({ TIP_SHARE: '0.3', MAX_TIP_SHARE: '0.8', QUOTE_GAS: '200000', MIN_PROFIT_USDC_WEI: '10000000000000000', GAS_SAFETY: '1' })
  const opp = (gross: bigint): EvaluatedOpportunity => ({
    cycle: CYCLE,
    amountIn: 10n ** 6n,
    amountOut: 10n ** 6n + gross / 10n ** 12n,
    grossProfit: gross / 10n ** 12n,
    grossProfitUsdc: gross,
    block: 200,
    truncated: false,
    evaluations: 1,
  })

  it('drops outbid opportunities from the candidates and reports them separately', () => {
    const outbid: Candidate[] = []
    // 1 USDC affords 4000 gwei (0.8 share / 200k gas): at that tip the safe gas cost still clears
    // MIN_PROFIT (GAS_SAFETY 1), so it is dropped for being outbid, not for being unprofitable.
    // 5 USDC affords 20000 gwei -> capped at 15000, above the market: raised to the market rate.
    const candidates = quoteCandidates(cfg, [opp(USDC), opp(5n * USDC)], 20n * GWEI, 3, 8000n * GWEI, outbid)
    expect(candidates.map((c) => c.expected18)).toEqual([5n * USDC])
    expect(candidates[0]!.quote.maxPriorityFeePerGas).toBe(8000n * GWEI)
    expect(outbid.map((c) => c.expected18)).toEqual([USDC])
    expect(outbid[0]!.quote.outbid).toBe(true)
  })

  it('is unchanged without a market tip', () => {
    const outbid: Candidate[] = []
    const candidates = quoteCandidates(cfg, [opp(USDC)], 20n * GWEI, 3, undefined, outbid)
    expect(candidates).toHaveLength(1)
    expect(outbid).toHaveLength(0)
  })
})
