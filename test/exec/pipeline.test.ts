import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { decodeExecute, toExecutorSteps, toGuards } from '../../src/exec/encode.js'
import {
  describeCycle,
  evaluateGroups,
  feePercent,
  formatFixed,
  formatUsdc,
  groupCycles,
  pickBest,
  planFor,
  quoteCandidates,
  TX_GAS_CAP,
  withHeadroom,
  type Candidate,
  type SimulatedCandidate,
} from '../../src/exec/pipeline.js'
import { NATIVE, type Cycle } from '../../src/types.js'
import { CYCLE, EXECUTOR, INFOS, P1, P2, STATES, testConfig } from './helpers.js'

const GWEI = 1_000_000_000n
const USDC_ERC20: Address = '0x3600000000000000000000000000000000000000'
const cfg = testConfig({ EXECUTOR_ADDRESS: EXECUTOR })

describe('groupCycles', () => {
  it('scales the input bounds to each start currency and drops unknown start currencies', () => {
    const erc20Cycle: Cycle = { ...CYCLE, id: 'erc20', start: USDC_ERC20 }
    const unknown: Cycle = { ...CYCLE, id: 'unknown', start: '0x00000000000000000000000000000000000000ab' }
    const groups = groupCycles(cfg, [CYCLE, erc20Cycle, unknown])
    expect(groups.map((g) => [g.start, g.decimals, g.cycles.length])).toEqual([
      [NATIVE, 18, 1],
      [USDC_ERC20, 6, 1],
    ])
    expect(groups[0]!.maxInput).toBe(cfg.MAX_INPUT_USDC_WEI)
    expect(groups[0]!.minInput).toBe(cfg.MIN_PROFIT_USDC_WEI)
    expect(groups[1]!.maxInput).toBe(cfg.MAX_INPUT_USDC_WEI / 10n ** 12n)
    expect(groups[1]!.minInput).toBe(cfg.MIN_PROFIT_USDC_WEI / 10n ** 12n)
    expect(groups[0]!.index.get(P1.poolId)).toEqual([CYCLE])
  })
})

describe('evaluateGroups', () => {
  const groups = groupCycles(cfg, [CYCLE])

  it('finds the fixture arbitrage with the exact simulator and prices it in USDC', () => {
    const opps = evaluateGroups(cfg, groups, STATES, INFOS, 200n)
    expect(opps).toHaveLength(1)
    const opp = opps[0]!
    expect(opp.cycle.id).toBe(CYCLE.id)
    expect(opp.grossProfit).toBeGreaterThan(0n)
    expect(opp.grossProfitUsdc).toBe(opp.grossProfit)
    expect(opp.amountIn).toBeGreaterThan(0n)
    expect(opp.amountIn).toBeLessThanOrEqual(cfg.MAX_INPUT_USDC_WEI)
    expect(opp.block).toBe(200)
  })

  it('evaluates only cycles touching the given pools', () => {
    expect(evaluateGroups(cfg, groups, STATES, INFOS, 200n, new Set())).toEqual([])
    expect(evaluateGroups(cfg, groups, STATES, INFOS, 200n, new Set([P2.poolId]))).toHaveLength(1)
  })
})

describe('quoteCandidates and planning', () => {
  const opps = evaluateGroups(cfg, groupCycles(cfg, [CYCLE]), STATES, INFOS, 200n)
  const baseFee = 20n * GWEI

  it('keeps opportunities whose net after gas clears MIN_PROFIT, up to max', () => {
    const candidates = quoteCandidates(cfg, opps, baseFee)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.expected18).toBe(opps[0]!.grossProfitUsdc)
    expect(candidates[0]!.quote.net).toBeGreaterThan(cfg.MIN_PROFIT_USDC_WEI)
    expect(quoteCandidates(cfg, opps, baseFee, 0)).toEqual([])
    const strict = testConfig({ MIN_PROFIT_USDC_WEI: (10n ** 24n).toString() })
    expect(quoteCandidates(strict, opps, baseFee)).toEqual([])
    const unpriced = opps.map((o) => {
      const { grossProfitUsdc: _drop, ...rest } = o
      return rest
    })
    expect(quoteCandidates(cfg, unpriced, baseFee)).toEqual([])
  })

  function simulated(candidate: Candidate, result: SimulatedCandidate['result']): SimulatedCandidate {
    return { candidate, steps: toExecutorSteps(CYCLE, INFOS), guards: toGuards(CYCLE, STATES, 1), result }
  }

  it('planFor re-prices with the simulated profit and estimated gas and encodes minProfit', () => {
    const candidate = quoteCandidates(cfg, opps, baseFee)[0]!
    const simProfit = candidate.opp.grossProfit / 2n
    const plan = planFor(cfg, simulated(candidate, { ok: true, profit: simProfit, gas: 300_000n, gasSource: 'estimate' }), baseFee)
    expect(plan).toBeDefined()
    expect(plan!.gas).toBe(360_000n)
    expect(plan!.gasSource).toBe('estimate')
    expect(plan!.simulatedProfit).toBe(simProfit)
    expect(plan!.simulatedProfit18).toBe(simProfit)
    expect(plan!.minProfit).toBe(cfg.MIN_PROFIT_USDC_WEI + plan!.quote.safeGasCost)
    expect(plan!.minProfit).toBeLessThan(simProfit)
    expect(plan!.tx.to).toBe(EXECUTOR)
    expect(plan!.tx.gas).toBe(360_000n)
    expect(plan!.tx.maxFeePerGas).toBe(plan!.quote.maxFeePerGas)
    const decoded = decodeExecute(plan!.tx.data)
    expect(decoded.amountIn).toBe(candidate.opp.amountIn)
    expect(decoded.minProfit).toBe(plan!.minProfit)
    expect(decoded.steps).toEqual(plan!.steps)
    expect(decoded.guards).toEqual(plan!.guards)
  })

  it('planFor uses GAS_LIMIT verbatim for config gas and rejects failed or unprofitable simulations', () => {
    const candidate = quoteCandidates(cfg, opps, baseFee)[0]!
    const viaConfig = planFor(cfg, simulated(candidate, { ok: true, profit: candidate.opp.grossProfit, gas: 1n, gasSource: 'config' }), baseFee)
    expect(viaConfig!.gas).toBe(BigInt(cfg.GAS_LIMIT))
    expect(planFor(cfg, simulated(candidate, { ok: false, reason: 'Unprofitable(-1, 0)' }), baseFee)).toBeUndefined()
    expect(planFor(cfg, simulated(candidate, { ok: true, profit: 1n, gas: 1n, gasSource: 'estimate' }), baseFee)).toBeUndefined()
    const noExecutor = testConfig()
    expect(planFor(noExecutor, simulated(candidate, { ok: true, profit: candidate.opp.grossProfit, gas: 1n, gasSource: 'config' }), baseFee)).toBeUndefined()
  })

  it('pickBest chooses the highest net among successful simulations', () => {
    const candidate = quoteCandidates(cfg, opps, baseFee)[0]!
    const low = simulated(candidate, { ok: true, profit: candidate.opp.grossProfit / 2n, gas: 300_000n, gasSource: 'estimate' })
    const high = simulated(candidate, { ok: true, profit: candidate.opp.grossProfit, gas: 300_000n, gasSource: 'estimate' })
    const failed = simulated(candidate, { ok: false, reason: 'StaleState(0, 1)' })
    expect(pickBest(cfg, [low, failed, high], baseFee)?.simulatedProfit).toBe(candidate.opp.grossProfit)
    expect(pickBest(cfg, [failed], baseFee)).toBeUndefined()
  })
})

describe('formatting', () => {
  it('withHeadroom adds 20 % and caps at the tx gas limit', () => {
    expect(withHeadroom(1_000_000n)).toBe(1_200_000n)
    expect(withHeadroom(TX_GAS_CAP)).toBe(TX_GAS_CAP)
  })

  it('formats USDC, fixed amounts, fees and cycles', () => {
    expect(formatUsdc(1_234_567_890_000_000_000n)).toBe('1.234567')
    expect(formatUsdc(0n)).toBe('0')
    expect(formatUsdc(5n * 10n ** 18n)).toBe('5')
    expect(formatFixed(1_500_000n, 6, 2)).toBe('1.5')
    expect(feePercent(3000)).toBe('0.3%')
    expect(feePercent(10000)).toBe('1%')
    expect(feePercent(0x800000)).toBe('dyn')
    // Fixture pool ids are 0x000…0a1 / 0x000…0a2, so their first 8 hex digits are zeros.
    expect(describeCycle(CYCLE, INFOS)).toBe('native -[00000000 0.3%]-> 0xc8c2…3e22 -[00000000 1%]-> native')
    expect(describeCycle(CYCLE, new Map())).toBe('native -[00000000 ?]-> ? -[00000000 ?]-> ?')
    const realId = { ...CYCLE, hops: [{ poolId: '0xba2b9bdf04fd659448a44ac6cabc27f8565bcdf00f58028ec9a07ccf31286514' as const, zeroForOne: true }] }
    expect(describeCycle(realId, new Map())).toBe('native -[ba2b9bdf ?]-> ?')
  })
})
