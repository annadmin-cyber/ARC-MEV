import { describe, expect, it } from 'vitest'
import { createPublicClient, custom, encodeErrorResult, encodeFunctionResult, type Hex, type PublicClient } from 'viem'
import { v4QuoterAbi } from '../../src/abi/index.js'
import { describeQuoteError, MAX_RPC_BATCH, probeSettingsFor, quoteCallerFor, RATE_LIMIT_RETRY_WAITS_MS } from '../../src/exec/probeIo.js'
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
