import { describe, expect, it } from 'vitest'
import { HttpRequestError, ResponseBodyTooLargeError, RpcRequestError, TimeoutError } from 'viem'
import { extsload, isRetryableRpcError, limiter, makeClients, withRetry, type RpcClients } from '../../src/rpc/client.js'
import { compareLogs, eventsToTopics, fetchLogsOnce, getLogsChunked, isLogRangeTooLarge, type RawLog } from '../../src/rpc/logs.js'
import { poolManagerAbi } from '../../src/abi/index.js'
import { loadConfig } from '../../src/config.js'

describe('isRetryableRpcError', () => {
  it('retries on 429, transport errors, timeouts and limit-style RPC errors', () => {
    expect(isRetryableRpcError(new HttpRequestError({ url: 'http://x', status: 429, body: {} }))).toBe(true)
    expect(isRetryableRpcError(new HttpRequestError({ url: 'http://x', status: 500, body: {} }))).toBe(true)
    expect(isRetryableRpcError(new TimeoutError({ url: 'http://x', body: {} }))).toBe(true)
    expect(
      isRetryableRpcError(
        new RpcRequestError({ url: 'http://x', body: {}, error: { code: -32005, message: 'rate limit exceeded' } }),
      ),
    ).toBe(true)
    expect(isRetryableRpcError(new Error('Too Many Requests'))).toBe(true)
    expect(isRetryableRpcError({ code: -32614, message: 'x' })).toBe(true)
    expect(isRetryableRpcError(new Error('outer', { cause: { code: 429 } }))).toBe(true)
  })
  it('does not retry reverts, unknown blocks or generic errors', () => {
    expect(isRetryableRpcError(new Error('execution reverted'))).toBe(false)
    expect(isRetryableRpcError({ code: -32014, message: 'requested data not available' })).toBe(false)
    expect(isRetryableRpcError(new Error('requested range too large'))).toBe(false)
    expect(isRetryableRpcError(undefined)).toBe(false)
  })
})

describe('withRetry', () => {
  it('retries retryable errors with backoff and returns the eventual value', async () => {
    let n = 0
    const start = Date.now()
    const v = await withRetry(
      async () => {
        n++
        if (n < 3) throw new Error('429 too many requests')
        return 'ok'
      },
      { baseMs: 5, jitter: false },
    )
    expect(v).toBe('ok')
    expect(n).toBe(3)
    expect(Date.now() - start).toBeGreaterThanOrEqual(5 + 10 - 2)
  })
  it('rethrows non-retryable errors at once and the last error after the final try', async () => {
    let n = 0
    await expect(
      withRetry(async () => {
        n++
        throw new Error('execution reverted')
      }),
    ).rejects.toThrow('execution reverted')
    expect(n).toBe(1)
    n = 0
    await expect(
      withRetry(
        async () => {
          n++
          throw new Error('rate limit exceeded')
        },
        { tries: 3, baseMs: 1, jitter: false },
      ),
    ).rejects.toThrow('rate limit exceeded')
    expect(n).toBe(3)
  })
})

describe('limiter', () => {
  it('never runs more than n tasks at once and preserves results', async () => {
    const limit = limiter(2)
    let active = 0
    let peak = 0
    const task = (i: number) =>
      limit(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return i
      })
    const results = await Promise.all([0, 1, 2, 3, 4, 5].map(task))
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
    expect(peak).toBe(2)
    expect(active).toBe(0)
  })
  it('releases the slot when a task throws', async () => {
    const limit = limiter(1)
    await expect(limit(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await limit(async () => 7)).toBe(7)
    expect(() => limiter(0)).toThrow()
  })
})

describe('logs helpers', () => {
  it('eventsToTopics builds an any-of topic0 filter', () => {
    const events = poolManagerAbi.filter((i) => i.type === 'event' && (i.name === 'Swap' || i.name === 'ModifyLiquidity'))
    const topics = eventsToTopics(events as never)
    expect(topics).toHaveLength(1)
    expect(topics[0]).toEqual([
      '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
      '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
    ])
    expect(eventsToTopics([])).toEqual([])
  })
  it('compareLogs orders by block then log index', () => {
    const l = (b: bigint, i: number) => ({ blockNumber: b, logIndex: i }) as RawLog
    expect([l(2n, 0), l(1n, 5), l(1n, 2)].sort(compareLogs).map((x) => [x.blockNumber, x.logIndex])).toEqual([
      [1n, 2],
      [1n, 5],
      [2n, 0],
    ])
  })
  it('getLogsChunked splits into <=10k-block chunks and bisects ranges the provider rejects for size', async () => {
    const calls: Array<[bigint, bigint]> = []
    const client = {
      request: async ({ params }: { params: [{ fromBlock: `0x${string}`; toBlock: `0x${string}` }] }) => {
        const from = BigInt(params[0].fromBlock)
        const to = BigInt(params[0].toBlock)
        calls.push([from, to])
        // Pretend anything wider than 3,000 blocks holds too many logs.
        if (to - from + 1n > 3000n) {
          throw Object.assign(new Error('request exceeded max allowed range: query exceeds max results 20000'), { code: -32602 })
        }
        return [
          { address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', topics: [], data: '0x', blockNumber: `0x${from.toString(16)}`, logIndex: '0x0', transactionIndex: '0x0', blockHash: '0x11', transactionHash: '0x22', removed: false },
        ]
      },
    } as unknown as RpcClients['http']
    const logs = await getLogsChunked(client, {
      address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
      fromBlock: 0n,
      toBlock: 14_999n,
      concurrency: 2,
    })
    // 2 chunks (0-9999, 10000-14999); the first bisects twice, the second once.
    expect(calls.filter(([f, t]) => t - f + 1n > 3000n).length).toBeGreaterThan(0)
    const leaves = calls.filter(([f, t]) => t - f + 1n <= 3000n).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    expect(leaves[0]?.[0]).toBe(0n)
    expect(leaves[leaves.length - 1]?.[1]).toBe(14_999n)
    for (let i = 1; i < leaves.length; i++) expect(leaves[i]?.[0]).toBe(leaves[i - 1]![1] + 1n)
    expect(logs.map((l) => l.blockNumber)).toEqual(leaves.map(([f]) => f))
    expect(isLogRangeTooLarge(new Error('requested range too large'))).toBe(true)
    expect(isLogRangeTooLarge(new Error('rate limit exceeded'))).toBe(false)
    expect(isLogRangeTooLarge(new ResponseBodyTooLargeError({ maxSize: 1, size: 2 }))).toBe(true)
    expect(isRetryableRpcError(new ResponseBodyTooLargeError({ maxSize: 1, size: 2 }))).toBe(false)
  })

  it('fetchLogsOnce refuses ranges above the provider cap without a network call', async () => {
    const client = { request: async () => [] } as unknown as RpcClients['http']
    await expect(fetchLogsOnce(client, '0x8366a39cc670b4001a1121b8f6a443a643e40951', [], 0n, 10_000n)).rejects.toThrow(
      /exceeds 10000/,
    )
  })
})

describe('makeClients / extsload', () => {
  it('builds http + single clients, ws only when configured', () => {
    const cfg = loadConfig({ DATA_DIR: '/nonexistent' })
    const c = makeClients(cfg)
    expect(c.chain.id).toBe(5042)
    expect(c.http).toBeDefined()
    expect(c.httpSingle).toBeDefined()
    expect(c.ws).toBeUndefined()
    expect(c.sendUrls).toEqual(['https://rpc.mainnet.arc.io'])
    expect(() => makeClients(loadConfig({ CHAIN_ID: '999', DATA_DIR: '/x' }))).toThrow(/CHAIN_ID/)
  })
  it('extsload returns [] for no slots without touching the network', async () => {
    const clients = {} as RpcClients
    expect(await extsload(clients, '0x8366a39cc670b4001a1121b8f6a443a643e40951', [])).toEqual([])
  })
})
