import { describe, expect, it } from 'vitest'
import { createPublicClient, custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, type Hex, type PublicClient } from 'viem'
import { multicall3Abi, v4QuoterAbi } from '../../src/abi/index.js'
import {
  decodeAggregatedQuote,
  describeQuoteError,
  isOutOfGas,
  MAX_MULTICALL_QUOTES,
  MAX_RPC_BATCH,
  multicallQuoteCallerFor,
  probeIoFor,
  probeSettingsFor,
  quoteCallerFor,
  RATE_LIMIT_RETRY_WAITS_MS,
} from '../../src/exec/probeIo.js'
import type { RpcClients } from '../../src/rpc/client.js'
import { MULTICALL3_ADDRESS } from '../../src/rpc/multicall.js'
import type { QuoteCall } from '../../src/strategy/probe.js'
import { addressToPoolId } from '../../src/types.js'
import { testConfig } from './helpers.js'

type Handler = (method: string, params: unknown[]) => Promise<unknown>

/** A real viem client over a fake JSON-RPC provider that records every request. */
function fakeClient(handler: Handler): { client: PublicClient; calls: Array<{ method: string; params: unknown[] }> } {
  const calls: Array<{ method: string; params: unknown[] }> = []
  const client = createPublicClient({
    transport: custom(
      {
        request: ({ method, params }: { method: string; params: unknown[] }) => {
          calls.push({ method, params })
          return handler(method, params)
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient
  return { client, calls }
}

const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94'
const ok = (amountOut: bigint): Hex => encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInput', result: [amountOut, 70_000n] })

describe('quoteCallerFor', () => {
  it('issues one eth_call per quote at the block tag and reports reverts per call', async () => {
    const { client, calls } = fakeClient(async (method, params) => {
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
      const [call] = params as [{ to: string; data: Hex }]
      if (call.data === '0x01') return ok(1n)
      if (call.data === '0x02') throw { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: v4QuoterAbi, errorName: 'NotEnoughLiquidity', args: [addressToPoolId('0x00000000000000000000000000000000000000ab')] }) }
      return ok(3n)
    })
    const caller = quoteCallerFor({ http: client })
    const outcomes = await caller([{ to: QUOTER, data: '0x01' }, { to: QUOTER, data: '0x02' }, { to: QUOTER, data: '0x03' }], 0x1234n)
    expect(outcomes).toEqual([
      { ok: true, data: ok(1n) },
      { ok: false, reason: 'NotEnoughLiquidity(0x00000000000000000000000000000000000000000000000000000000000000ab)' },
      { ok: true, data: ok(3n) },
    ])
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.method === 'eth_call' && (c.params as unknown[])[1] === '0x1234')).toBe(true)
    expect((calls[0]!.params as [{ to: string }])[0].to).toBe(QUOTER)
    expect(await caller([], 1n)).toEqual([])
  })

  it('retries the whole batch while every call says the block is not served yet', async () => {
    let n = 0
    const { client, calls } = fakeClient(async () => {
      n++
      if (n <= 2) throw { code: -32001, message: 'block not found' }
      return ok(9n)
    })
    const outcomes = await quoteCallerFor({ http: client })([{ to: QUOTER, data: '0x01' }, { to: QUOTER, data: '0x02' }], 5n)
    expect(outcomes).toEqual([
      { ok: true, data: ok(9n) },
      { ok: true, data: ok(9n) },
    ])
    expect(calls).toHaveLength(4)
  })

  it('does not retry when only some calls are not ready (they are reported as failed)', async () => {
    const { client, calls } = fakeClient(async (_m, params) => {
      const [call] = params as [{ data: Hex }]
      if (call.data === '0x02') throw { code: -32001, message: 'block not found' }
      return ok(1n)
    })
    const outcomes = await quoteCallerFor({ http: client })([{ to: QUOTER, data: '0x01' }, { to: QUOTER, data: '0x02' }], 5n)
    expect(outcomes[0]).toEqual({ ok: true, data: ok(1n) })
    expect(outcomes[1]).toMatchObject({ ok: false, reason: expect.stringMatching(/not found/i) })
    expect(calls).toHaveLength(2)
  })
})

describe('quoteCallerFor under rate limiting', () => {
  it('re-issues only the rate-limited calls, keeps order, and gives up after the retry waits', async () => {
    const seen = new Map<Hex, number>()
    const { client, calls } = fakeClient(async (_m, params) => {
      const [call] = params as [{ data: Hex }]
      const n = (seen.get(call.data) ?? 0) + 1
      seen.set(call.data, n)
      // 0x01 succeeds at once, 0x02 after two throttled answers, 0x03 is throttled forever, 0x04 reverts (not retried).
      if (call.data === '0x02' && n <= 2) throw { code: -32005, message: 'Request exceeds defined limit.' }
      if (call.data === '0x03') throw { code: 429, message: 'Request exceeds defined limit.' }
      if (call.data === '0x04') throw { code: 3, message: 'execution reverted', data: encodeErrorResult({ abi: v4QuoterAbi, errorName: 'UnexpectedRevertBytes', args: ['0x'] }) }
      return ok(BigInt(call.data))
    })
    const outcomes = await quoteCallerFor({ http: client })(['0x01', '0x02', '0x03', '0x04'].map((data) => ({ to: QUOTER, data: data as Hex })), 9n)
    expect(outcomes).toEqual([
      { ok: true, data: ok(1n) },
      { ok: true, data: ok(2n) },
      { ok: false, reason: expect.any(String) }, // viem renders an unknown code (429) as a generic RPC error
      { ok: false, reason: 'UnexpectedRevertBytes(0x)' },
    ])
    expect(seen.get('0x01')).toBe(1)
    expect(seen.get('0x02')).toBe(3)
    expect(seen.get('0x03')).toBe(1 + RATE_LIMIT_RETRY_WAITS_MS.length)
    expect(seen.get('0x04')).toBe(1)
    // 0x01 once, 0x02 three times, 0x03 once per round, 0x04 once.
    expect(calls).toHaveLength(1 + 3 + (1 + RATE_LIMIT_RETRY_WAITS_MS.length) + 1)
  })
})

describe('quoteCallerFor batching', () => {
  it('issues the first chunk synchronously and later chunks in later ticks, keeping the answer order', async () => {
    const { client, calls } = fakeClient(async (_m, params) => ok(BigInt((params as [{ data: Hex }])[0].data)))
    const caller = quoteCallerFor({ http: client }, 2)
    const pending = caller([1, 2, 3, 4, 5].map((i) => ({ to: QUOTER, data: `0x0${i}` as Hex })), 1n)
    // Only the first chunk of 2 is issued in the calling tick (one HTTP batch); the rest follow in later ticks.
    expect(calls).toHaveLength(2)
    const outcomes = await pending
    expect(calls).toHaveLength(5)
    expect(calls.map((c) => (c.params as [{ data: Hex }])[0].data)).toEqual(['0x01', '0x02', '0x03', '0x04', '0x05'])
    expect(outcomes.map((o) => (o.ok ? o.data : o.reason))).toEqual([1n, 2n, 3n, 4n, 5n].map(ok))
    expect(MAX_RPC_BATCH).toBe(20)
    expect(() => quoteCallerFor({ http: {} as PublicClient }, 0)).toThrow(RangeError)
  })
})

/** An aggregate3 answer: `success` with `returnData` per sub-call. */
const aggregated = (results: Array<{ success: boolean; returnData: Hex }>): Hex => encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
/** The sub-calls of an aggregate3 `eth_call` request as `{ target, allowFailure, callData }`. */
function subCalls(params: unknown[]): Array<{ target: string; allowFailure: boolean; callData: Hex }> {
  const [call] = params as [{ to: string; data: Hex }]
  const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: call.data })
  expect(functionName).toBe('aggregate3')
  return (args as [ReadonlyArray<{ target: string; allowFailure: boolean; callData: Hex }>])[0].map((c) => ({ ...c, target: c.target.toLowerCase() }))
}
const NOT_ENOUGH = encodeErrorResult({ abi: v4QuoterAbi, errorName: 'NotEnoughLiquidity', args: [addressToPoolId('0x00000000000000000000000000000000000000ab')] })
const UNEXPECTED = encodeErrorResult({ abi: v4QuoterAbi, errorName: 'UnexpectedRevertBytes', args: ['0xdeadbeef'] })

describe('multicallQuoteCallerFor', () => {
  it('packs every quote of a round into one aggregate3 eth_call at the block tag and decodes each Result', async () => {
    const { client, calls } = fakeClient(async (method, params) => {
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
      const subs = subCalls(params)
      return aggregated(
        subs.map(({ callData }) => {
          if (callData === '0x01') return { success: true, returnData: ok(1n) }
          if (callData === '0x02') return { success: false, returnData: NOT_ENOUGH }
          if (callData === '0x03') return { success: false, returnData: UNEXPECTED }
          if (callData === '0x04') return { success: false, returnData: '0x12345678' }
          if (callData === '0x05') return { success: false, returnData: '0x' }
          if (callData === '0x06') return { success: true, returnData: '0x' } // no code at the quoter
          return { success: true, returnData: ok(BigInt(callData)) }
        }),
      )
    })
    const caller = multicallQuoteCallerFor({ http: client })
    const quotes: QuoteCall[] = ['0x01', '0x02', '0x03', '0x04', '0x05', '0x06', '0x07'].map((data) => ({ to: QUOTER, data: data as Hex }))
    const outcomes = await caller(quotes, 0x1234n)
    expect(outcomes).toEqual([
      { ok: true, data: ok(1n) },
      { ok: false, reason: 'NotEnoughLiquidity(0x00000000000000000000000000000000000000000000000000000000000000ab)' },
      { ok: false, reason: 'UnexpectedRevertBytes(0xdeadbeef)' },
      { ok: false, reason: 'revert 0x12345678 (4 bytes)' },
      { ok: false, reason: 'revert (no data)' },
      { ok: false, reason: expect.stringMatching(/^undecodable quote 0x/) },
      { ok: true, data: ok(7n) },
    ])
    // One request for the whole round: an eth_call to Multicall3 at the explicit block number (the empty-data
    // failure of 0x05 is then re-issued alone, in case it was starved of gas, and fails the same way).
    expect(calls).toHaveLength(2)
    expect(subCalls(calls[1]!.params).map((s) => s.callData)).toEqual(['0x05'])
    const [request] = calls as [{ method: string; params: [{ to: string; data: Hex }, string] }]
    expect(request.method).toBe('eth_call')
    expect(request.params[0].to).toBe(MULTICALL3_ADDRESS)
    expect(request.params[1]).toBe('0x1234')
    expect(subCalls(request.params)).toEqual(quotes.map((q) => ({ target: QUOTER, allowFailure: true, callData: q.data })))
    expect(await caller([], 1n)).toEqual([])
  })

  it('splits a round beyond MAX_MULTICALL_QUOTES into several aggregate3 calls, keeping the answer order', async () => {
    const { client, calls } = fakeClient(async (_m, params) => aggregated(subCalls(params).map(({ callData }) => ({ success: true, returnData: ok(BigInt(callData)) }))))
    const n = MAX_MULTICALL_QUOTES + 1
    const quotes: QuoteCall[] = Array.from({ length: n }, (_, i) => ({ to: QUOTER, data: `0x${(i + 1).toString(16).padStart(4, '0')}` as Hex }))
    const outcomes = await multicallQuoteCallerFor({ http: client })(quotes, 7n)
    expect(calls).toHaveLength(2)
    expect(subCalls(calls[0]!.params)).toHaveLength(MAX_MULTICALL_QUOTES)
    expect(subCalls(calls[1]!.params)).toHaveLength(1)
    expect(calls.every((c) => (c.params as unknown[])[1] === '0x7')).toBe(true)
    expect(outcomes).toEqual(quotes.map((q) => ({ ok: true, data: ok(BigInt(q.data)) })))
    expect(MAX_MULTICALL_QUOTES).toBe(150)
    // A custom chunk size and Multicall3 address are honoured.
    calls.length = 0
    await multicallQuoteCallerFor({ http: client }, { chunkSize: 2, multicall: '0x00000000000000000000000000000000000000aa' })(quotes.slice(0, 5), 7n)
    expect(calls.map((c) => subCalls(c.params).length)).toEqual([2, 2, 1])
    expect((calls[0]!.params as [{ to: string }])[0].to).toBe('0x00000000000000000000000000000000000000aa')
    expect(() => multicallQuoteCallerFor({ http: client }, { chunkSize: 0 })).toThrow(RangeError)
  })

  it('re-issues a rate-limited aggregate3 call after the short waits, retries while the block is not served, and never throws', async () => {
    let n = 0
    const { client, calls } = fakeClient(async (_m, params) => {
      n++
      if (n === 1) throw { code: -32001, message: 'block not found' }
      if (n === 2) throw { code: -32005, message: 'Request exceeds defined limit.' }
      return aggregated(subCalls(params).map(() => ({ success: true, returnData: ok(5n) })))
    })
    const quotes: QuoteCall[] = [{ to: QUOTER, data: '0x01' }, { to: QUOTER, data: '0x02' }]
    expect(await multicallQuoteCallerFor({ http: client })(quotes, 5n)).toEqual([
      { ok: true, data: ok(5n) },
      { ok: true, data: ok(5n) },
    ])
    expect(calls).toHaveLength(3)
    // Throttled for good: one request per retry wait, then every quote of the round fails with the RPC message.
    calls.length = 0
    const throttled = fakeClient(async () => {
      throw { code: -32005, message: 'Request exceeds defined limit.' }
    })
    expect(await multicallQuoteCallerFor({ http: throttled.client })(quotes, 5n)).toEqual([
      { ok: false, reason: expect.stringMatching(/limit/i) },
      { ok: false, reason: expect.stringMatching(/limit/i) },
    ])
    expect(throttled.calls).toHaveLength(1 + RATE_LIMIT_RETRY_WAITS_MS.length)
    // A non-retryable transport failure (or a response Multicall3 could not have produced) fails the round at once.
    const broken = fakeClient(async () => '0x')
    expect(await multicallQuoteCallerFor({ http: broken.client })(quotes, 5n)).toEqual([
      { ok: false, reason: expect.stringMatching(/undecodable response/) },
      { ok: false, reason: expect.stringMatching(/undecodable response/) },
    ])
    expect(broken.calls).toHaveLength(1)
    const short = fakeClient(async () => aggregated([{ success: true, returnData: ok(1n) }]))
    expect(await multicallQuoteCallerFor({ http: short.client })(quotes, 5n)).toEqual([
      { ok: false, reason: 'aggregate3: expected 2 results, got 1' },
      { ok: false, reason: 'aggregate3: expected 2 results, got 1' },
    ])
  })

  it('bisects a chunk the node refuses for exceeding its eth_call gas cap, down to single quotes', async () => {
    // The gateway's wording; a chunk of more than 4 quotes (each ~4M gas on a hook that burns gas before reverting) exceeds 30M.
    const { client, calls } = fakeClient(async (_m, params) => {
      const subs = subCalls(params)
      if (subs.length > 4) throw { code: -32000, message: 'Transaction creation failed. (out of gas: gas required exceeds: 30000000)' }
      return aggregated(subs.map(({ callData }) => (callData === '0x0009' ? { success: false, returnData: UNEXPECTED } : { success: true, returnData: ok(BigInt(callData)) })))
    })
    const quotes: QuoteCall[] = Array.from({ length: 15 }, (_, i) => ({ to: QUOTER, data: `0x${(i + 1).toString(16).padStart(4, '0')}` as Hex }))
    const outcomes = await multicallQuoteCallerFor({ http: client })(quotes, 9n)
    expect(outcomes).toEqual(quotes.map((q) => (q.data === '0x0009' ? { ok: false, reason: 'UnexpectedRevertBytes(0xdeadbeef)' } : { ok: true, data: ok(BigInt(q.data)) })))
    // 15 -> 8 + 7 -> 4 + 4 + 4 + 3: one refused call at each level above 4 quotes, then four that fit.
    expect(calls.map((c) => subCalls(c.params).length)).toEqual([15, 8, 7, 4, 4, 4, 3])
    expect(isOutOfGas({ message: 'gas required exceeds allowance (30000000)' })).toBe(true)
    expect(isOutOfGas({ code: -32005, message: 'Request exceeds defined limit.' })).toBe(false)
    // A single quote that still exceeds the cap fails with the node's message and is not retried as a rate limit.
    const single = fakeClient(async () => {
      throw { code: -32000, message: 'out of gas: gas required exceeds: 30000000' }
    })
    expect(await multicallQuoteCallerFor({ http: single.client })(quotes.slice(0, 1), 9n)).toEqual([{ ok: false, reason: expect.stringMatching(/out of gas/) }])
    expect(single.calls).toHaveLength(1)
  })

  it('re-issues quotes that failed with empty revert data inside a multi-quote chunk as single-quote calls', async () => {
    const EMPTY = encodeErrorResult({ abi: v4QuoterAbi, errorName: 'UnexpectedRevertBytes', args: ['0x'] })
    const { client, calls } = fakeClient(async (_m, params) => {
      const subs = subCalls(params)
      // In a chunk of several quotes the last sub-call is starved (63/64 of what is left); alone it succeeds.
      return aggregated(
        subs.map(({ callData }, i) => {
          if (callData === '0x02') return { success: false, returnData: NOT_ENOUGH } // a real failure, never re-issued
          if (subs.length > 1 && i === subs.length - 1) return { success: false, returnData: EMPTY }
          if (callData === '0x04') return { success: false, returnData: EMPTY } // genuinely empty: stays a failure after its own call
          return { success: true, returnData: ok(BigInt(callData)) }
        }),
      )
    })
    const quotes: QuoteCall[] = ['0x01', '0x02', '0x03', '0x04'].map((data) => ({ to: QUOTER, data: data as Hex }))
    const outcomes = await multicallQuoteCallerFor({ http: client })(quotes, 9n)
    expect(outcomes).toEqual([
      { ok: true, data: ok(1n) },
      { ok: false, reason: 'NotEnoughLiquidity(0x00000000000000000000000000000000000000000000000000000000000000ab)' },
      { ok: true, data: ok(3n) },
      { ok: false, reason: 'UnexpectedRevertBytes(0x)' },
    ])
    expect(calls.map((c) => subCalls(c.params).map((s) => s.callData))).toEqual([['0x01', '0x02', '0x03', '0x04'], ['0x04']])
  })

  it('decodeAggregatedQuote mirrors the eth_call error texts', () => {
    expect(decodeAggregatedQuote(true, ok(3n))).toEqual({ ok: true, data: ok(3n) })
    expect(decodeAggregatedQuote(false, NOT_ENOUGH)).toEqual({ ok: false, reason: describeQuoteError({ code: 3, message: 'execution reverted', data: NOT_ENOUGH }) })
    expect(decodeAggregatedQuote(false, '0x')).toEqual({ ok: false, reason: 'revert (no data)' })
    expect(decodeAggregatedQuote(true, '0x01')).toMatchObject({ ok: false })
  })
})

describe('probeIoFor quote mode', () => {
  const quoteRequestsIn = (calls: Array<{ method: string; params: unknown[] }>) => calls.filter((c) => c.method === 'eth_call').map((c) => (c.params as [{ to: string }])[0].to)

  it('quotes through one aggregate3 call by default (PROBE_QUOTE_MODE=multicall) and per quote in batch mode', async () => {
    const quotes: QuoteCall[] = [1, 2, 3].map((i) => ({ to: QUOTER, data: `0x0${i}` as Hex }))
    const multi = fakeClient(async (_m, params) => aggregated(subCalls(params).map(({ callData }) => ({ success: true, returnData: ok(BigInt(callData)) }))))
    const clientsOf = (client: PublicClient) => ({ http: client, chain: { id: 5042 } }) as unknown as RpcClients
    expect(testConfig().PROBE_QUOTE_MODE).toBe('multicall')
    expect(await probeIoFor(clientsOf(multi.client), testConfig()).call(quotes, 3n)).toEqual(quotes.map((q) => ({ ok: true, data: ok(BigInt(q.data)) })))
    expect(quoteRequestsIn(multi.calls)).toEqual([MULTICALL3_ADDRESS])
    expect(await probeIoFor(clientsOf(multi.client), { CHAIN_ID: 5042 }).call(quotes, 3n)).toHaveLength(3)
    expect(quoteRequestsIn(multi.calls)).toEqual([MULTICALL3_ADDRESS, MULTICALL3_ADDRESS])

    const batch = fakeClient(async (_m, params) => ok(BigInt((params as [{ data: Hex }])[0].data)))
    const cfg = testConfig({ PROBE_QUOTE_MODE: 'batch' })
    expect(cfg.PROBE_QUOTE_MODE).toBe('batch')
    expect(await probeIoFor(clientsOf(batch.client), cfg).call(quotes, 3n)).toEqual(quotes.map((q) => ({ ok: true, data: ok(BigInt(q.data)) })))
    expect(quoteRequestsIn(batch.calls)).toEqual([QUOTER, QUOTER, QUOTER])
    expect(batch.calls.every((c) => (c.params as unknown[])[1] === '0x3')).toBe(true)
    expect(() => testConfig({ PROBE_QUOTE_MODE: 'jsonrpc' })).toThrow()
  })
})

describe('describeQuoteError', () => {
  it('decodes quoter errors, falls back to the selector, then to the message', () => {
    const unexpected = encodeErrorResult({ abi: v4QuoterAbi, errorName: 'UnexpectedRevertBytes', args: ['0xdeadbeef'] })
    expect(describeQuoteError({ code: 3, message: 'execution reverted', data: unexpected })).toBe('UnexpectedRevertBytes(0xdeadbeef)')
    expect(describeQuoteError({ data: '0x12345678' })).toBe('revert 0x12345678 (4 bytes)')
    expect(describeQuoteError(new Error('HTTP 429'))).toBe('HTTP 429')
  })
})

describe('probeSettingsFor', () => {
  it('takes the quoter from the chain table and the knobs from config', () => {
    const cfg = testConfig({ PROBE_MAX_PER_BLOCK: '7', PROBE_MIN_SPREAD_BPS: '12', PROBE_GRID: '3' })
    expect(probeSettingsFor(cfg)).toEqual({ quoter: QUOTER, maxPerBlock: 7, minSpreadBps: 12, grid: 3, poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' })
    expect(testConfig().PROBE_HOOKED_POOLS).toBe(true)
    expect(probeSettingsFor(testConfig())).toMatchObject({ maxPerBlock: 4, minSpreadBps: 30, grid: 5 })
    expect(() => probeSettingsFor(testConfig({ CHAIN_ID: '5042002' }))).toThrow(/V4Quoter/)
  })
})
