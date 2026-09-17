import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, custom, type PublicClient } from 'viem'
import { loadConfig } from '../../src/config.js'
import { readNextBaseFee } from '../../src/exec/gas.js'
import { probeIoFor } from '../../src/exec/probeIo.js'
import type { RpcClients } from '../../src/rpc/client.js'
import { extsload } from '../../src/rpc/client.js'
import { aggregate3 } from '../../src/rpc/multicall.js'
import { BLOCK_LOG_RETRY, BLOCK_REFETCH_RETRY, StateCache } from '../../src/state/cache.js'
import type { FetchPoolStatesOptions } from '../../src/state/reader.js'
import type { PoolInfo, PoolState } from '../../src/types.js'

/** A JSON-RPC rate-limit answer as the official gateway returns it over HTTP 200. */
function rateLimitError(): Error & { code: number } {
  return Object.assign(new Error('Request exceeds defined limit.'), { code: -32005 })
}

/** Run `p` under fake timers, advancing time until it settles; returns fake ms elapsed. */
async function settle<T>(p: Promise<T>): Promise<{ result: PromiseSettledResult<T>; elapsedMs: number }> {
  let done: PromiseSettledResult<T> | undefined
  p.then((v) => (done = { status: 'fulfilled', value: v }), (e: unknown) => (done = { status: 'rejected', reason: e }))
  const start = Date.now()
  while (!done) await vi.advanceTimersByTimeAsync(50)
  return { result: done as PromiseSettledResult<T>, elapsedMs: Date.now() - start }
}

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const P1: PoolInfo = {
  poolId: '0x00000000000000000000000000000000000000000000000000000000000000a1',
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x2000000000000000000000000000000000000002',
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
  block: 1,
}

/**
 * Regression for: nested / slow retry policies on the per-block path. `probeIo.fetchSwapLogs`
 * wrapped `fetchLogsOnce` (6 tries) in another `withRetry` (36 attempts, ~1 minute), and the
 * per-block refetches (`extsload` / `aggregate3`) and the header read used the slow default
 * (6 tries, 300 ms doubling: 9+ s), all of which stalled the block loop on a rate-limit burst.
 */
describe('retry policies on the per-block critical path', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('probeIo.fetchSwapLogs uses the single short BLOCK_LOG_RETRY policy (no nested withRetry)', async () => {
    const request = vi.fn(async () => {
      throw rateLimitError()
    })
    const clients = { http: { request } } as unknown as RpcClients
    const io = probeIoFor(clients, { CHAIN_ID: 5042 })
    const { result, elapsedMs } = await settle(io.fetchSwapLogs(100n, 100n))
    expect(result.status).toBe('rejected')
    expect(request).toHaveBeenCalledTimes(BLOCK_LOG_RETRY.tries!)
    expect(elapsedMs).toBeLessThan(4_000)
  })

  it('extsload and aggregate3 honour a short retry option (per-block refetches) and keep the slow default otherwise', async () => {
    const readContract = vi.fn(async () => {
      throw rateLimitError()
    })
    const call = vi.fn(async () => {
      throw rateLimitError()
    })
    const clients = { httpSingle: { readContract, call }, chain: { id: 5042 } } as unknown as RpcClients
    const slot = `0x${'00'.repeat(32)}` as const
    const fast = await settle(extsload(clients, POOL_MANAGER, [slot], 1n, { retry: BLOCK_REFETCH_RETRY }))
    expect(fast.result.status).toBe('rejected')
    expect(readContract).toHaveBeenCalledTimes(BLOCK_REFETCH_RETRY.tries!)
    expect(fast.elapsedMs).toBeLessThan(1_000)
    const fastCalls = await settle(aggregate3(clients, [{ target: POOL_MANAGER, callData: '0x' }], 1n, { retry: BLOCK_REFETCH_RETRY }))
    expect(fastCalls.result.status).toBe('rejected')
    expect(call).toHaveBeenCalledTimes(BLOCK_REFETCH_RETRY.tries!)
    expect(fastCalls.elapsedMs).toBeLessThan(1_000)
    // Discovery / backfill keep the patient default.
    readContract.mockClear()
    const slow = await settle(extsload(clients, POOL_MANAGER, [slot], 1n))
    expect(slow.result.status).toBe('rejected')
    expect(readContract).toHaveBeenCalledTimes(6)
    expect(slow.elapsedMs).toBeGreaterThanOrEqual(9_300)
  })

  it('StateCache threads BLOCK_REFETCH_RETRY into per-block refetches but not into init', async () => {
    const cfg = loadConfig({ DATA_DIR: '/nonexistent' })
    const fetchStates = vi.fn(async (_c: RpcClients, _cfg: unknown, pools: readonly PoolInfo[], block: bigint, _opts?: FetchPoolStatesOptions) => {
      const state: PoolState = {
        poolId: P1.poolId,
        block: Number(block),
        sqrtPriceX96: 1n << 96n,
        tick: 0,
        lpFee: 3000,
        protocolFee: 0,
        liquidity: 1n,
        tickSpacing: 60,
        ticks: new Map(),
        tickWindow: { lower: -60, upper: 60 },
      }
      return new Map(pools.map((p) => [p.poolId, { ...state, poolId: p.poolId }] as const))
    })
    const cache = new StateCache({} as RpcClients, cfg, [P1], {
      fetchStates: fetchStates as unknown as typeof import('../../src/state/reader.js').fetchPoolStates,
      fetchLogs: async () => [],
      fullRefreshBlocks: 2,
    })
    await cache.init(10n)
    expect(fetchStates.mock.calls[0]?.[4]?.retry).toBeUndefined()
    await cache.applyBlock(12n) // full refresh due -> refetch on the per-block path
    expect(fetchStates).toHaveBeenCalledTimes(2)
    expect(fetchStates.mock.calls[1]?.[4]?.retry).toBe(BLOCK_REFETCH_RETRY)
  })

  it('readNextBaseFee gives a rate-limited header read two quick retries only', async () => {
    let attempts = 0
    const client = createPublicClient({
      transport: custom(
        {
          request: async () => {
            attempts++
            throw rateLimitError()
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient
    const { result, elapsedMs } = await settle(readNextBaseFee({ http: client }, 100n))
    expect(result.status).toBe('rejected')
    expect(attempts).toBe(3)
    expect(elapsedMs).toBeLessThan(900)
  })
})
