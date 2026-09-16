import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type Address, type Hex } from 'viem'
import { poolManagerAbi, v4QuoterAbi } from '../../src/abi/index.js'
import type { StoredPool } from '../../src/discovery/store.js'
import type { RawLog } from '../../src/rpc/logs.js'
import {
  decodeQuote,
  encodeQuoteExactInput,
  HookedProbe,
  logGrid,
  selectProbePools,
  spotPrice,
  spreadBps,
  type InputBounds,
  type ProbeIo,
  type ProbeSettings,
  type QuoteCall,
  type QuoteOutcome,
} from '../../src/strategy/probe.js'
import { NATIVE, type PoolInfo, type PoolState } from '../../src/types.js'
import { addr, cpmmSimulator, isqrt, pid, Q96, stateFromReserves } from './helpers.js'

const E18 = 10n ** 18n
const USDC: Address = '0x3600000000000000000000000000000000000000'
const TOKEN: Address = addr(0xbb)
const HOOK: Address = addr(0xc0)
const QUOTER: Address = addr(0x9999)

/** Tracked hookless v4 pool on (native, TOKEN) and a v2 pair on the same pair. */
const Q1: PoolInfo = { poolId: pid(1), currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE, block: 1 }
const Q2: PoolInfo = { poolId: pid(2), currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 0, hooks: NATIVE, block: 1, kind: 2, pool: addr(0x22), venue: 'uniswap-v2' }
/** Hooked v4 pools on the same pair, plus one on an unrelated pair. */
const H1: PoolInfo = { poolId: pid(0xa1), currency0: NATIVE, currency1: TOKEN, fee: 0, tickSpacing: 1, hooks: HOOK, block: 2 }
const H2: PoolInfo = { poolId: pid(0xa2), currency0: NATIVE, currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks: HOOK, block: 2 }
const H3: PoolInfo = { poolId: pid(0xa3), currency0: USDC, currency1: addr(0xcc), fee: 0, tickSpacing: 1, hooks: HOOK, block: 2 }

const TRACKED = new Map<Hex, PoolInfo>([
  [Q1.poolId, Q1],
  [Q2.poolId, Q2],
])
const STARTS = new Map<Address, number>([
  [NATIVE, 18],
  [USDC, 6],
])
const BOUNDS = new Map<Address, InputBounds>([
  [NATIVE, { minInput: E18 / 100n, maxInput: 1_000_000n * E18 }],
  [USDC, { minInput: 10_000n, maxInput: 1_000_000_000n }],
])
const SETTINGS: ProbeSettings = { quoter: QUOTER, maxPerBlock: 4, minSpreadBps: 30, grid: 5 }

/** Tracked states: Q1 at 1 TOKEN per native (1M / 1M), Q2 the same via reserves. */
function trackedStates(): Map<Hex, PoolState> {
  const q1 = stateFromReserves(Q1.poolId, 1_000_000n * E18, 1_000_000n * E18, 3000)
  const q2 = { ...stateFromReserves(Q2.poolId, 1_000_000n * E18, 1_000_000n * E18, 3000), reserves: { reserve0: 1_000_000n * E18, reserve1: 1_000_000n * E18 } }
  return new Map([
    [Q1.poolId, q1],
    [Q2.poolId, q2],
  ])
}

/** sqrtPriceX96 of a (token1 per token0) price. */
function sqrtPriceOf(price: number): bigint {
  return isqrt(BigInt(Math.round(price * 1e6)) * Q96 * Q96 / 1_000_000n)
}

let logIndex = 0
function swapLog(poolId: Hex, block: bigint, sqrtPriceX96: bigint, fee = 0): RawLog {
  const topics = encodeEventTopics({ abi: poolManagerAbi, eventName: 'Swap', args: { id: poolId, sender: addr(0x11) } })
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [-1000n, 990n, sqrtPriceX96, 5n * E18, 0, fee],
  )
  return {
    address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: block,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: logIndex++,
    removed: false,
  } as RawLog
}

/** The `QuoteExactParams` of an encoded `quoteExactInput` call. */
function quoteParams(data: Hex): { exactCurrency: Address; exactAmount: bigint; path: readonly { intermediateCurrency: Address; fee: number; tickSpacing: number; hooks: Address; hookData: Hex }[] } {
  const decoded = decodeFunctionData({ abi: v4QuoterAbi, data })
  if (decoded.functionName !== 'quoteExactInput') throw new Error(`unexpected ${decoded.functionName}`)
  return decoded.args[0]
}

/** A fake quoter: prices every hooked pool as a constant-product pool with the given virtual reserves, and records batches. */
function fakeIo(hookedReserves: Map<Hex, { r0: bigint; r1: bigint }>, opts: { failFor?: Set<Hex>; logs?: RawLog[] } = {}) {
  const batches: QuoteCall[][] = []
  const io: ProbeIo = {
    async call(calls, _block) {
      batches.push([...calls])
      return calls.map((c): QuoteOutcome => {
        const params = quoteParams(c.data)
        const path = params.path[0]!
        const pool = [H1, H2, H3].find((h) => h.hooks.toLowerCase() === path.hooks.toLowerCase() && h.fee === path.fee && h.tickSpacing === path.tickSpacing)
        if (!pool) return { ok: false, reason: 'unknown pool' }
        if (opts.failFor?.has(pool.poolId)) return { ok: false, reason: 'UnexpectedRevertBytes(0x)' }
        const reserves = hookedReserves.get(pool.poolId)!
        const zeroForOne = params.exactCurrency.toLowerCase() === pool.currency0
        const state = stateFromReserves(pool.poolId, reserves.r0, reserves.r1, pool.fee)
        const out = cpmmSimulator(state, zeroForOne, params.exactAmount).amountOut
        return { ok: true, data: encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInput', result: [out, 75_000n] }) }
      })
    },
    async fetchSwapLogs(from, to) {
      return (opts.logs ?? []).filter((l) => l.blockNumber >= from && l.blockNumber <= to)
    },
    async readSlot0s(ids, _block) {
      const out = new Map()
      for (const id of ids) {
        const r = hookedReserves.get(id)
        if (r) out.set(id, { sqrtPriceX96: stateFromReserves(id, r.r0, r.r1).sqrtPriceX96, tick: 0, lpFee: 0 })
      }
      return out
    },
  }
  return { io, batches }
}

describe('selectProbePools', () => {
  it('keeps active hooked v4 pools that share a start-currency pair with a tracked pool, most active first', () => {
    const stored = (p: PoolInfo, extra: Partial<StoredPool>): StoredPool => ({ ...p, liquidity: '1000', ...extra })
    const pools = [
      stored(H1, { swapCount: 5, lastSwapBlock: 100 }),
      stored(H2, { swapCount: 9, lastSwapBlock: 50 }),
      stored(H3, { swapCount: 100 }), // pair (USDC, 0xcc) has no tracked pool
      stored({ ...H1, poolId: pid(0xa4) }, { liquidity: '0', swapCount: 50 }), // empty
      stored({ ...H1, poolId: pid(0xa5) }, { swapCount: 5, lastSwapBlock: 200 }),
      stored({ ...H1, poolId: pid(0xa6), hooks: NATIVE }, { swapCount: 500 }), // hookless: tracked, not probed
      stored({ ...H1, poolId: pid(0xa7), kind: 1, pool: addr(0x77) }, { swapCount: 500 }), // not v4
    ]
    const selected = selectProbePools(pools, [Q1], new Set([NATIVE]))
    expect(selected.map((p) => p.poolId)).toEqual([H2.poolId, pid(0xa5), H1.poolId])
    expect(selected[0]).toEqual({ poolId: H2.poolId, currency0: NATIVE, currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks: HOOK, block: 2 })
    expect(selectProbePools(pools, [Q1], new Set([NATIVE]), 1)).toHaveLength(1)
    expect(selectProbePools(pools, [Q1], new Set([USDC]))).toEqual([])
  })
})

describe('helpers', () => {
  it('logGrid spaces n points geometrically including both ends, spreadBps is symmetric', () => {
    expect(logGrid(1n, 10_000n, 5)).toEqual([1n, 10n, 100n, 1000n, 10_000n])
    expect(logGrid(7n, 7n, 5)).toEqual([7n])
    expect(logGrid(10n, 5n, 5)).toEqual([])
    expect(logGrid(1n, 2n, 5).length).toBeLessThanOrEqual(2)
    expect(spreadBps(1.01, 1)).toBeCloseTo(99.5, 0)
    expect(spreadBps(1, 1.01)).toBeCloseTo(99.5, 0)
    expect(spreadBps(0, 1)).toBe(Number.POSITIVE_INFINITY)
    expect(spotPrice(Q96)).toBe(1)
  })

  it('encodes quoteExactInput with the hop as a single PathKey and decodes the result', () => {
    const data = encodeQuoteExactInput(H2, NATIVE, 123n)
    expect(data.slice(0, 10)).toBe('0xca253dc9')
    const params = quoteParams(data)
    expect(params.exactCurrency).toBe(NATIVE)
    expect(params.exactAmount).toBe(123n)
    expect(params.path).toHaveLength(1)
    expect(params.path[0]!.intermediateCurrency.toLowerCase()).toBe(TOKEN)
    expect(params.path[0]!.fee).toBe(10000)
    expect(params.path[0]!.tickSpacing).toBe(200)
    expect(params.path[0]!.hooks.toLowerCase()).toBe(HOOK)
    expect(params.path[0]!.hookData).toBe('0x')
    expect(decodeQuote(encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInput', result: [5n, 6n] }))).toEqual({ amountOut: 5n, gasEstimate: 6n })
  })
})

describe('HookedProbe', () => {
  it('tracks prices from Swap logs and seeds them from slot0 at init', async () => {
    const reserves = new Map([[H1.poolId, { r0: 1_000_000n * E18, r1: 1_100_000n * E18 }]])
    const { io } = fakeIo(reserves)
    const probe = new HookedProbe(SETTINGS, io, TRACKED, [H1, H2, Q1], STARTS)
    // Tracked pools never enter the probe set.
    expect(probe.pools.map((p) => p.poolId)).toEqual([H1.poolId, H2.poolId])
    await probe.init(500n)
    expect(probe.pricedCount).toBe(1)
    expect(probe.block).toBe(500n)
    expect(probe.price(H1.poolId)?.sqrtPriceX96).toBe(stateFromReserves(H1.poolId, 1_000_000n * E18, 1_100_000n * E18).sqrtPriceX96)
    expect(probe.states().get(H1.poolId)).toMatchObject({ poolId: H1.poolId, block: 500, lpFee: 0, protocolFee: 0, tickSpacing: 1 })

    const touched = probe.observeSwapLogs([swapLog(H2.poolId, 501n, sqrtPriceOf(1.05), 10000), swapLog(Q1.poolId, 501n, Q96), swapLog(pid(0xff), 501n, Q96)])
    expect([...touched]).toEqual([H2.poolId])
    expect(probe.price(H2.poolId)).toEqual({ sqrtPriceX96: sqrtPriceOf(1.05), tick: 0, liquidity: 5n * E18, lpFee: 10000, block: 501 })
  })

  it('advance() fetches the swap logs since the last block (bounded) and returns the touched pools', async () => {
    const reserves = new Map([[H1.poolId, { r0: 1_000_000n * E18, r1: 1_000_000n * E18 }]])
    const logs = [swapLog(H1.poolId, 601n, sqrtPriceOf(1.02)), swapLog(H2.poolId, 610n, sqrtPriceOf(0.9)), swapLog(H1.poolId, 700n, sqrtPriceOf(1.03))]
    const ranges: Array<[bigint, bigint]> = []
    const { io } = fakeIo(reserves, { logs })
    const fetchSwapLogs = io.fetchSwapLogs.bind(io)
    io.fetchSwapLogs = async (from, to) => {
      ranges.push([from, to])
      return fetchSwapLogs(from, to)
    }
    const probe = new HookedProbe({ ...SETTINGS, maxReplayBlocks: 20 }, io, TRACKED, [H1, H2], STARTS)
    await probe.init(600n)
    expect([...(await probe.advance(610n))]).toEqual([H1.poolId, H2.poolId])
    expect(await probe.advance(610n)).toEqual(new Set())
    expect([...(await probe.advance(700n))]).toEqual([H1.poolId])
    expect(ranges).toEqual([
      [601n, 610n],
      [681n, 700n],
    ])
    expect(probe.price(H1.poolId)?.sqrtPriceX96).toBe(sqrtPriceOf(1.03))
  })

  it('advance() applies prefetched logs without fetching when they start at or before its resume point', async () => {
    const reserves = new Map([[H1.poolId, { r0: 1_000_000n * E18, r1: 1_000_000n * E18 }]])
    const { io } = fakeIo(reserves, { logs: [swapLog(H1.poolId, 605n, sqrtPriceOf(1.5))] })
    let fetches = 0
    const fetchSwapLogs = io.fetchSwapLogs.bind(io)
    io.fetchSwapLogs = async (from, to) => {
      fetches++
      return fetchSwapLogs(from, to)
    }
    const probe = new HookedProbe({ ...SETTINGS, poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' }, io, TRACKED, [H1, H2], STARTS)
    await probe.init(600n)
    // Covers (600, 610]: used as is, no chain access.
    const prefetched = [swapLog(H1.poolId, 601n, sqrtPriceOf(1.02)), swapLog(H2.poolId, 610n, sqrtPriceOf(0.9))]
    expect([...(await probe.advance(610n, { fromBlock: 601n, logs: prefetched }))]).toEqual([H1.poolId, H2.poolId])
    expect(fetches).toBe(0)
    expect(probe.price(H1.poolId)?.sqrtPriceX96).toBe(sqrtPriceOf(1.02))
    // Starts after the resume point (611): the gap would be missed, so the probe fetches itself.
    expect([...(await probe.advance(620n, { fromBlock: 615n, logs: [] }))]).toEqual([])
    expect(fetches).toBe(1)
    expect(probe.block).toBe(620n)
  })

  it('observeSwapLogs ignores logs that are not PoolManager Swaps (unfiltered batches may be passed)', async () => {
    const reserves = new Map([[H1.poolId, { r0: 1_000_000n * E18, r1: 1_000_000n * E18 }]])
    const { io } = fakeIo(reserves)
    const probe = new HookedProbe({ ...SETTINGS, poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' }, io, TRACKED, [H1, H2], STARTS)
    await probe.init(600n)
    const before = probe.price(H1.poolId)!.sqrtPriceX96
    const stranger = { ...swapLog(H1.poolId, 601n, sqrtPriceOf(3)), address: '0x9999999999999999999999999999999999999999' as Address }
    const modify = swapLog(H1.poolId, 601n, sqrtPriceOf(4))
    modify.topics[0] = encodeEventTopics({ abi: poolManagerAbi, eventName: 'ModifyLiquidity', args: { id: H1.poolId, sender: addr(0x11) } })[0]
    expect(probe.observeSwapLogs([stranger, modify]).size).toBe(0)
    expect(probe.price(H1.poolId)?.sqrtPriceX96).toBe(before)
    expect([...probe.observeSwapLogs([swapLog(H1.poolId, 601n, sqrtPriceOf(3))])]).toEqual([H1.poolId])
  })

  it('selects candidates above the spread threshold, most-spread first, for touched hooked and tracked pools', async () => {
    const reserves = new Map([
      [H1.poolId, { r0: 1_000_000n * E18, r1: 1_100_000n * E18 }], // 10 % above Q1/Q2
      [H2.poolId, { r0: 1_000_000n * E18, r1: 1_002_000n * E18 }], // 0.2 % above: below the 30 bps threshold
    ])
    const { io } = fakeIo(reserves)
    const probe = new HookedProbe(SETTINGS, io, TRACKED, [H1, H2], STARTS)
    await probe.init(1n)
    const states = trackedStates()
    const fromHooked = probe.selectCandidates(new Set([H1.poolId, H2.poolId]), new Set(), states)
    expect(fromHooked.map((c) => [c.hooked.poolId, c.tracked.poolId])).toEqual([
      [H1.poolId, Q1.poolId],
      [H1.poolId, Q2.poolId],
    ])
    expect(fromHooked[0]!.spreadBps).toBeCloseTo(953, 0)
    // A touched tracked pool pulls in every priced hooked sibling (still subject to the threshold), without duplicates.
    const fromTracked = probe.selectCandidates(new Set([H1.poolId]), new Set([Q1.poolId]), states)
    expect(fromTracked.map((c) => [c.hooked.poolId, c.tracked.poolId])).toEqual([
      [H1.poolId, Q1.poolId],
      [H1.poolId, Q2.poolId],
    ])
    expect(probe.selectCandidates(new Set(), new Set(), states)).toEqual([])
    // Unpriced hooked pools and unknown tracked pools are ignored.
    const lenient = new HookedProbe({ ...SETTINGS, minSpreadBps: 0 }, io, TRACKED, [H1, H2], STARTS)
    expect(lenient.selectCandidates(new Set([H1.poolId]), new Set(), states)).toEqual([])
  })

  it('quotes only the direction the spread implies and chains the on-chain and local hops both ways', async () => {
    // H1 holds 1.1M TOKEN per 1M native: TOKEN is 10 % cheaper there than on Q1. Buy TOKEN on H1, sell it on Q1.
    const reserves = new Map([[H1.poolId, { r0: 1_000_000n * E18, r1: 1_100_000n * E18 }]])
    const { io, batches } = fakeIo(reserves)
    const probe = new HookedProbe({ ...SETTINGS, maxPerBlock: 1 }, io, TRACKED, [H1], STARTS)
    await probe.init(1n)
    const states = trackedStates()
    const candidates = probe.selectCandidates(new Set([H1.poolId]), new Set(), states)
    const cycles = probe.cyclesFor(candidates[0]!, states, BOUNDS)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.cycle.start).toBe(NATIVE)
    expect(cycles[0]!.hookedFirst).toBe(true)
    expect(cycles[0]!.cycle.hops).toEqual([
      { poolId: H1.poolId, zeroForOne: true },
      { poolId: Q1.poolId, zeroForOne: false },
    ])

    const result = await probe.probe(7n, states, BOUNDS, new Set([H1.poolId]), new Set())
    expect(result).toMatchObject({ candidates: 2, probes: 1, touchedHooked: 1 })
    // Grid of 5 in one batch, then a refinement batch of 2.
    expect(batches.map((b) => b.length)).toEqual([5, 2])
    expect(result.calls).toBe(7)
    expect(batches[0]!.every((c) => c.to === QUOTER)).toBe(true)
    const firstInputs = batches[0]!.map((c) => quoteParams(c.data))
    // Hooked hop first: the quoter is asked in native at exactly the grid inputs.
    expect(firstInputs.every((p) => p.exactCurrency === NATIVE)).toBe(true)
    expect(firstInputs.map((p) => p.exactAmount)).toEqual(logGrid(BOUNDS.get(NATIVE)!.minInput, BOUNDS.get(NATIVE)!.maxInput, 5))
    expect(result.opportunities).toHaveLength(1)
    const opp = result.opportunities[0]!
    expect(opp.probed).toBe(true)
    expect(opp.block).toBe(7)
    expect(opp.grossProfit).toBeGreaterThan(0n)
    expect(opp.amountOut - opp.amountIn).toBe(opp.grossProfit)
    expect(opp.quoterGas).toBe(75_000n)
    expect(opp.evaluations).toBe(7)
    expect(opp.cycle.id).toBe(cycles[0]!.cycle.id)
    // The optimum of this constant-product pair is ~48k native; the grid (.., 100, 10k, 1M) + refinement lands in that basin.
    expect(opp.amountIn).toBeGreaterThan(1_000n * E18)
    expect(opp.amountIn).toBeLessThan(100_000n * E18)

    // The opposite skew (TOKEN dearer on H1) simulates Q1 first and asks the quoter in TOKEN for Q1's output.
    reserves.set(H1.poolId, { r0: 1_100_000n * E18, r1: 1_000_000n * E18 })
    const probe2 = new HookedProbe({ ...SETTINGS, maxPerBlock: 1 }, io, TRACKED, [H1], STARTS)
    await probe2.init(1n)
    batches.length = 0
    const result2 = await probe2.probe(8n, states, BOUNDS, new Set([H1.poolId]), new Set())
    expect(result2.opportunities).toHaveLength(1)
    expect(result2.opportunities[0]!.cycle.hops.map((h) => h.poolId)).toEqual([Q1.poolId, H1.poolId])
    expect(result2.opportunities[0]!.grossProfit).toBeGreaterThan(0n)
    const inputs2 = batches[0]!.map((c) => quoteParams(c.data))
    expect(inputs2.every((p) => p.exactCurrency.toLowerCase() === TOKEN)).toBe(true)
    // Q1 charges 0.3 % and moves the price, so each quoted amount is below the grid input that produced it.
    const grid = logGrid(BOUNDS.get(NATIVE)!.minInput, BOUNDS.get(NATIVE)!.maxInput, 5)
    inputs2.forEach((p, i) => expect(p.exactAmount).toBeLessThan(grid[i]!))
  })

  it('caps probed pairs per block, skips pairs where fees eat the spread, and survives failed quotes', async () => {
    const reserves = new Map([
      [H1.poolId, { r0: 1_000_000n * E18, r1: 1_100_000n * E18 }],
      [H2.poolId, { r0: 1_000_000n * E18, r1: 1_004_000n * E18 }], // 40 bps spread, but Q charges 30 bps and H2 1 %: no direction is profitable
    ])
    const { io, batches } = fakeIo(reserves, { failFor: new Set([H1.poolId]) })
    const probe = new HookedProbe({ ...SETTINGS, maxPerBlock: 1 }, io, TRACKED, [H1, H2], STARTS)
    await probe.init(1n)
    const states = trackedStates()
    const result = await probe.probe(9n, states, BOUNDS, new Set([H1.poolId, H2.poolId]), new Set())
    // 4 candidates above threshold (H1 and H2 against Q1 and Q2); H2 has no quotable direction; cap 1 keeps H1/Q1 only.
    expect(result.candidates).toBe(4)
    expect(result.probes).toBe(1)
    expect(result.opportunities).toEqual([])
    // Every grid quote failed: the least-bad sample is the smallest input, so one refinement to its right is tried (and fails too).
    expect(batches.map((b) => b.length)).toEqual([5, 1])
    expect(result.calls).toBe(6)

    const noCap = new HookedProbe({ ...SETTINGS, maxPerBlock: 0 }, io, TRACKED, [H1, H2], STARTS)
    await noCap.init(1n)
    expect(await noCap.probe(9n, states, BOUNDS, new Set([H1.poolId]), new Set())).toMatchObject({ candidates: 2, probes: 0, calls: 0, opportunities: [] })
  })

  it('reports a batch that throws or answers with the wrong length as failed quotes', async () => {
    const reserves = new Map([[H1.poolId, { r0: 1_000_000n * E18, r1: 1_100_000n * E18 }]])
    const { io } = fakeIo(reserves)
    let n = 0
    io.call = async (calls) => {
      n++
      if (n === 1) throw new Error('HTTP 429')
      return calls.slice(1).map((): QuoteOutcome => ({ ok: false, reason: 'short' }))
    }
    const probe = new HookedProbe(SETTINGS, io, TRACKED, [H1], STARTS)
    await probe.init(1n)
    const result = await probe.probe(10n, trackedStates(), BOUNDS, new Set([H1.poolId]), new Set())
    expect(result.opportunities).toEqual([])
    expect(result.probes).toBe(2)
  })
})
