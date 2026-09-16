import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem'
import { poolManagerAbi } from '../../src/abi/index.js'
import { loadConfig } from '../../src/config.js'
import type { RpcClients } from '../../src/rpc/client.js'
import type { RawLog } from '../../src/rpc/logs.js'
import { StateCache, isBlockNotReady } from '../../src/state/cache.js'
import type { FetchPoolStatesOptions } from '../../src/state/reader.js'
import type { PoolInfo, PoolState } from '../../src/types.js'

const cfg = loadConfig({ DATA_DIR: '/nonexistent' })
const clients = {} as RpcClients
const SENDER = '0x1111111111111111111111111111111111111111' as Address

const P1: PoolInfo = {
  poolId: '0x00000000000000000000000000000000000000000000000000000000000000a1',
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x2000000000000000000000000000000000000002',
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
  block: 1,
}
const P2: PoolInfo = { ...P1, poolId: '0x00000000000000000000000000000000000000000000000000000000000000a2', fee: 0x800000 }
const UNTRACKED: Hex = '0x00000000000000000000000000000000000000000000000000000000000000ff'

function fakeState(info: PoolInfo, block: bigint): PoolState {
  return {
    poolId: info.poolId,
    block: Number(block),
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    lpFee: info.fee === 0x800000 ? 500 : info.fee,
    protocolFee: 0,
    liquidity: 1_000_000n,
    tickSpacing: info.tickSpacing,
    ticks: new Map([[-60, { liquidityNet: 1n, liquidityGross: 1n }]]),
    tickWindow: { lower: -30720, upper: 30660 },
  }
}

let logIndex = 0
function swapLog(poolId: Hex, block: bigint, v: { sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number }): RawLog {
  const topics = encodeEventTopics({ abi: poolManagerAbi, eventName: 'Swap', args: { id: poolId, sender: SENDER } })
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [-1000n, 990n, v.sqrtPriceX96, v.liquidity, v.tick, v.fee],
  )
  return rawLog(block, topics as [Hex, ...Hex[]], data)
}

function modifyLog(poolId: Hex, block: bigint): RawLog {
  const topics = encodeEventTopics({ abi: poolManagerAbi, eventName: 'ModifyLiquidity', args: { id: poolId, sender: SENDER } })
  const data = encodeAbiParameters(
    [{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }],
    [-120, 120, 5n, `0x${'00'.repeat(32)}`],
  )
  return rawLog(block, topics as [Hex, ...Hex[]], data)
}

function rawLog(block: bigint, topics: [Hex, ...Hex[]], data: Hex): RawLog {
  return {
    address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    topics,
    data,
    blockNumber: block,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: logIndex++,
    removed: false,
  } as RawLog
}

/** Build a cache whose chain reads are scripted. */
function makeCache(logsByRange: (from: bigint, to: bigint) => RawLog[], opts: { fullRefreshBlocks?: number } = {}) {
  const fetchStates = vi.fn(
    async (_c: RpcClients, _cfg: unknown, pools: readonly PoolInfo[], block: bigint, _opts?: FetchPoolStatesOptions) =>
      new Map(pools.map((p) => [p.poolId, fakeState(p, block)] as const)),
  )
  const fetchLogs = vi.fn(async (from: bigint, to: bigint) => logsByRange(from, to))
  const cache = new StateCache(clients, cfg, [P1, P2], {
    fetchStates: fetchStates as unknown as typeof import('../../src/state/reader.js').fetchPoolStates,
    fetchLogs,
    blockRetryMs: 1,
    blockRetries: 3,
    ...opts,
  })
  return { cache, fetchStates, fetchLogs }
}

describe('StateCache', () => {
  it('init fetches every pool once', async () => {
    const { cache, fetchStates } = makeCache(() => [])
    await cache.init(100n)
    expect(fetchStates).toHaveBeenCalledTimes(1)
    expect(fetchStates.mock.calls[0]?.[2].map((p) => p.poolId)).toEqual([P1.poolId, P2.poolId])
    expect(cache.block).toBe(100n)
    expect(cache.all().size).toBe(2)
    expect(cache.get(P1.poolId)?.block).toBe(100)
  })

  it('applies a Swap in place (price, tick, liquidity; lpFee only for dynamic-fee pools)', async () => {
    const { cache, fetchStates, fetchLogs } = makeCache((from) => [
      swapLog(P1.poolId, from, { sqrtPriceX96: 123n, liquidity: 42n, tick: 600, fee: 9999 }),
      swapLog(P2.poolId, from, { sqrtPriceX96: 456n, liquidity: 43n, tick: -600, fee: 777 }),
      swapLog(UNTRACKED, from, { sqrtPriceX96: 1n, liquidity: 1n, tick: 1, fee: 1 }),
    ])
    await cache.init(100n)
    const before = cache.get(P1.poolId)!
    const res = await cache.applyBlock(101n)
    expect(fetchLogs).toHaveBeenCalledWith(101n, 101n)
    expect(res.block).toBe(101n)
    expect([...res.touched].sort()).toEqual([P1.poolId, P2.poolId])
    const s1 = cache.get(P1.poolId)!
    expect(s1).toBe(before) // mutated in place
    expect(s1.sqrtPriceX96).toBe(123n)
    expect(s1.liquidity).toBe(42n)
    expect(s1.tick).toBe(600)
    expect(s1.lpFee).toBe(3000) // static fee pool keeps its lpFee
    expect(s1.block).toBe(101)
    const s2 = cache.get(P2.poolId)!
    expect(s2.lpFee).toBe(777) // dynamic fee pool takes the event fee
    expect(s2.tick).toBe(-600)
    expect(fetchStates).toHaveBeenCalledTimes(1) // no refetch was needed
    expect(cache.block).toBe(101n)
  })

  it('refetches on ModifyLiquidity and when the tick leaves the window, with tick hints', async () => {
    const { cache, fetchStates } = makeCache((from) =>
      from === 101n
        ? [modifyLog(P1.poolId, from)]
        : [swapLog(P2.poolId, from, { sqrtPriceX96: 1n, liquidity: 1n, tick: 40000, fee: 500 })],
    )
    await cache.init(100n)
    const r1 = await cache.applyBlock(101n)
    expect([...r1.touched]).toEqual([P1.poolId])
    expect(fetchStates).toHaveBeenCalledTimes(2)
    expect(fetchStates.mock.calls[1]?.[2].map((p) => p.poolId)).toEqual([P1.poolId])
    expect(fetchStates.mock.calls[1]?.[3]).toBe(101n)
    const r2 = await cache.applyBlock(102n)
    expect([...r2.touched]).toEqual([P2.poolId])
    expect(fetchStates).toHaveBeenCalledTimes(3)
    const call = fetchStates.mock.calls[2]!
    expect(call[2].map((p) => p.poolId)).toEqual([P2.poolId])
    // The hint is the tick from the swap event (applied before the refetch decision).
    expect(call[4]?.tickHints?.get(P2.poolId)).toBe(40000)
  })

  it('does a full refresh every fullRefreshBlocks and after a large gap', async () => {
    const { cache, fetchStates, fetchLogs } = makeCache(() => [], { fullRefreshBlocks: 3 })
    await cache.init(100n)
    await cache.applyBlock(101n)
    await cache.applyBlock(102n)
    expect(fetchStates).toHaveBeenCalledTimes(1)
    const r = await cache.applyBlock(103n)
    expect(fetchStates).toHaveBeenCalledTimes(2)
    expect(fetchStates.mock.calls[1]?.[2]).toHaveLength(2)
    expect(r.touched.size).toBe(2)
    expect(fetchLogs).toHaveBeenCalledTimes(2) // no log fetch on the full-refresh block
    // Gap larger than maxReplayBlocks (50) -> full refresh, no log replay.
    await cache.applyBlock(200n)
    expect(fetchStates).toHaveBeenCalledTimes(3)
    expect(fetchLogs).toHaveBeenCalledTimes(2)
    // Small gap (below the next full-refresh boundary) -> single ranged log fetch.
    await cache.applyBlock(202n)
    expect(fetchLogs).toHaveBeenLastCalledWith(201n, 202n)
    expect(fetchStates).toHaveBeenCalledTimes(3)
    // Stale or repeated block is a no-op.
    const noop = await cache.applyBlock(202n)
    expect(noop.touched.size).toBe(0)
  })

  it('retries when the block is not yet available and gives up after blockRetries', async () => {
    let calls = 0
    const { cache, fetchLogs } = makeCache(() => {
      calls++
      if (calls < 3) throw Object.assign(new Error('requested data not available'), { code: -32014 })
      return []
    })
    await cache.init(100n)
    await cache.applyBlock(101n)
    expect(fetchLogs).toHaveBeenCalledTimes(3)
    calls = -100
    await expect(cache.applyBlock(102n)).rejects.toThrow(/not available after 3 attempts/)
    // Non-availability errors propagate immediately.
    const bad = makeCache(() => {
      throw new Error('execution reverted')
    })
    await bad.cache.init(1n)
    await expect(bad.cache.applyBlock(2n)).rejects.toThrow('execution reverted')
    expect(bad.fetchLogs).toHaveBeenCalledTimes(1)
  })

  it('applyBlock before init throws', async () => {
    const { cache } = makeCache(() => [])
    await expect(cache.applyBlock(1n)).rejects.toThrow(/init/)
  })
})

describe('isBlockNotReady', () => {
  it('recognises the Arc RPC error shapes', () => {
    expect(isBlockNotReady({ code: -32014, message: 'requested data not available' })).toBe(true)
    expect(isBlockNotReady({ code: -32001, message: 'block not found: 0x1500000' })).toBe(true)
    expect(isBlockNotReady(new Error('block range extends beyond current head'))).toBe(true)
    expect(isBlockNotReady(new Error('outer', { cause: { message: 'unknown block' } }))).toBe(true)
    expect(isBlockNotReady(new Error('rate limit exceeded'))).toBe(false)
    expect(isBlockNotReady(null)).toBe(false)
  })
})
