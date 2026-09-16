import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem'
import { poolManagerAbi, v2PairAbi, v3PoolAbi } from '../../src/abi/index.js'
import { arc } from '../../src/chains.js'
import { loadConfig } from '../../src/config.js'
import { MAX_TICK, MIN_TICK } from '../../src/math/tickMath.js'
import { v2Liquidity, v2SqrtPriceX96, v2Tick } from '../../src/math/v2.js'
import type { RpcClients } from '../../src/rpc/client.js'
import type { RawLog } from '../../src/rpc/logs.js'
import { StateCache, TRACKED_TOPICS, V2_SYNC_TOPIC, V3_SWAP_TOPIC, V4_SWAP_TOPIC } from '../../src/state/cache.js'
import type { FetchPoolStatesOptions } from '../../src/state/reader.js'
import { addressToPoolId, type PoolInfo, type PoolState } from '../../src/types.js'

const cfg = loadConfig({ DATA_DIR: '/nonexistent' })
const clients = {} as RpcClients
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address
const SENDER = '0x1111111111111111111111111111111111111111' as Address
const V3_ADDR = '0x82916bee18fcef517b26c72d7cb5f13694e1db41' as Address
const V2_ADDR = '0x5dbf58814d0736fa09b6ad7f290800b805dd383d' as Address
const STRANGER = '0x9999999999999999999999999999999999999999' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

const V4: PoolInfo = {
  poolId: '0x00000000000000000000000000000000000000000000000000000000000000a1',
  currency0: ZERO,
  currency1: '0x2000000000000000000000000000000000000002',
  fee: 3000,
  tickSpacing: 60,
  hooks: ZERO,
  block: 1,
}
const V3: PoolInfo = { ...V4, poolId: addressToPoolId(V3_ADDR), fee: 100, tickSpacing: 1, kind: 1, pool: V3_ADDR, venue: 'uniswap-v3' }
const V2: PoolInfo = { ...V4, poolId: addressToPoolId(V2_ADDR), fee: 3000, tickSpacing: 0, kind: 2, pool: V2_ADDR, venue: 'uniswap-v2' }
const RESERVES = { reserve0: 131_097_917_690n, reserve1: 19_381_947_516_033_733_583_385_209n }

function fakeState(info: PoolInfo, block: bigint): PoolState {
  if (info.kind === 2) {
    const sqrtPriceX96 = v2SqrtPriceX96(RESERVES)
    return {
      poolId: info.poolId,
      block: Number(block),
      sqrtPriceX96,
      tick: v2Tick(sqrtPriceX96),
      lpFee: info.fee,
      protocolFee: 0,
      liquidity: v2Liquidity(RESERVES),
      tickSpacing: 0,
      ticks: new Map(),
      tickWindow: { lower: MIN_TICK, upper: MAX_TICK },
      reserves: { ...RESERVES },
    }
  }
  return {
    poolId: info.poolId,
    block: Number(block),
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    lpFee: info.fee,
    protocolFee: 0,
    liquidity: 1_000_000n,
    tickSpacing: info.tickSpacing,
    ticks: new Map(),
    tickWindow: { lower: -30720, upper: 30660 },
  }
}

let logIndex = 0
function rawLog(address: Address, block: bigint, topics: readonly (Hex | Hex[] | null)[], data: Hex): RawLog {
  return {
    address,
    topics: topics as unknown as [Hex, ...Hex[]],
    data,
    blockNumber: block,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: logIndex++,
    removed: false,
  } as RawLog
}

function v4SwapLog(emitter: Address, poolId: Hex, block: bigint, sqrtPriceX96: bigint): RawLog {
  const topics = encodeEventTopics({ abi: poolManagerAbi, eventName: 'Swap', args: { id: poolId, sender: SENDER } })
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [-1000n, 990n, sqrtPriceX96, 7n, 3, 3000],
  )
  return rawLog(emitter, block, topics, data)
}

function v3SwapLog(emitter: Address, block: bigint, v: { sqrtPriceX96: bigint; liquidity: bigint; tick: number }): RawLog {
  const topics = encodeEventTopics({ abi: v3PoolAbi, eventName: 'Swap', args: { sender: SENDER, recipient: SENDER } })
  const data = encodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
    [-1000n, 990n, v.sqrtPriceX96, v.liquidity, v.tick],
  )
  return rawLog(emitter, block, topics, data)
}

function v3MintLog(emitter: Address, block: bigint): RawLog {
  const topics = encodeEventTopics({ abi: v3PoolAbi, eventName: 'Mint', args: { owner: SENDER, tickLower: -10, tickUpper: 10 } })
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [SENDER, 5n, 1n, 1n])
  return rawLog(emitter, block, topics, data)
}

function v3BurnLog(emitter: Address, block: bigint): RawLog {
  const topics = encodeEventTopics({ abi: v3PoolAbi, eventName: 'Burn', args: { owner: SENDER, tickLower: -10, tickUpper: 10 } })
  const data = encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [5n, 1n, 1n])
  return rawLog(emitter, block, topics, data)
}

function v2SyncLog(emitter: Address, block: bigint, reserve0: bigint, reserve1: bigint): RawLog {
  const topics = encodeEventTopics({ abi: v2PairAbi, eventName: 'Sync' })
  const data = encodeAbiParameters([{ type: 'uint112' }, { type: 'uint112' }], [reserve0, reserve1])
  return rawLog(emitter, block, topics, data)
}

function makeCache(logsByRange: (from: bigint, to: bigint) => RawLog[]) {
  const fetchStates = vi.fn(
    async (_c: RpcClients, _cfg: unknown, pools: readonly PoolInfo[], block: bigint, _opts?: FetchPoolStatesOptions) =>
      new Map(pools.map((p) => [p.poolId, fakeState(p, block)] as const)),
  )
  const fetchLogs = vi.fn(async (from: bigint, to: bigint) => logsByRange(from, to))
  const cache = new StateCache(clients, cfg, [V4, V3, V2], {
    fetchStates: fetchStates as unknown as typeof import('../../src/state/reader.js').fetchPoolStates,
    fetchLogs,
    blockRetryMs: 1,
    blockRetries: 2,
  })
  return { cache, fetchStates, fetchLogs }
}

describe('StateCache routing of v3 / v2 events by emitter', () => {
  it('tracks six topic0 selectors and no emitter filter', () => {
    const topic0 = TRACKED_TOPICS[0] as Hex[]
    expect(TRACKED_TOPICS).toHaveLength(1)
    expect(topic0).toHaveLength(6)
    const named = (abi: readonly unknown[], name: string) => toEventSelector(abi.find((i) => (i as AbiEvent).type === 'event' && (i as AbiEvent).name === name) as AbiEvent)
    expect(new Set(topic0)).toEqual(
      new Set([
        named(poolManagerAbi, 'Swap'),
        named(poolManagerAbi, 'ModifyLiquidity'),
        named(v3PoolAbi, 'Swap'),
        named(v3PoolAbi, 'Mint'),
        named(v3PoolAbi, 'Burn'),
        named(v2PairAbi, 'Sync'),
      ]),
    )
    expect(V4_SWAP_TOPIC).toBe(named(poolManagerAbi, 'Swap'))
    expect(V3_SWAP_TOPIC).toBe(named(v3PoolAbi, 'Swap'))
    expect(V2_SYNC_TOPIC).toBe(named(v2PairAbi, 'Sync'))
    expect(V3_SWAP_TOPIC).not.toBe(V4_SWAP_TOPIC)
  })

  it('v3 Swap updates price/tick/liquidity in place; v2 Sync replaces reserves and re-derives', async () => {
    const { cache, fetchStates } = makeCache((from) => [
      v3SwapLog(V3_ADDR, from, { sqrtPriceX96: 2179578918580284116010575781096n, liquidity: 401045617221n, tick: 66294 }),
      v2SyncLog(V2_ADDR, from, 131_728_917_690n, 19_289_382_464_293_860_158_984_989n),
    ])
    await cache.init(100n)
    const s3 = cache.get(V3.poolId)!
    const s2 = cache.get(V2.poolId)!
    // the window of the fake state is [-30720, 30660]; tick 66294 lies outside -> refetch expected for v3
    const r = await cache.applyBlock(101n)
    expect([...r.touched].sort()).toEqual([V2.poolId, V3.poolId].sort())
    expect(cache.get(V2.poolId)).toBe(s2) // mutated in place
    expect(s2.reserves).toEqual({ reserve0: 131_728_917_690n, reserve1: 19_289_382_464_293_860_158_984_989n })
    expect(s2.sqrtPriceX96).toBe(v2SqrtPriceX96(s2.reserves!))
    expect(s2.tick).toBe(v2Tick(s2.sqrtPriceX96))
    expect(s2.liquidity).toBe(v2Liquidity(s2.reserves!))
    expect(s2.block).toBe(101)
    // v3: applied in place first (price/tick/liquidity), then refetched because the tick left the window
    expect(s3.sqrtPriceX96).toBe(2179578918580284116010575781096n)
    expect(s3.tick).toBe(66294)
    expect(s3.liquidity).toBe(401045617221n)
    expect(fetchStates).toHaveBeenCalledTimes(2)
    expect(fetchStates.mock.calls[1]?.[2].map((p) => p.poolId)).toEqual([V3.poolId])
    expect(fetchStates.mock.calls[1]?.[4]?.tickHints?.get(V3.poolId)).toBe(66294)
    expect(cache.get(V3.poolId)?.block).toBe(101)
  })

  it('v3 Swap inside the window does not refetch; Mint and Burn do', async () => {
    const { cache, fetchStates } = makeCache((from) =>
      from === 101n
        ? [v3SwapLog(V3_ADDR, from, { sqrtPriceX96: 123n, liquidity: 42n, tick: 5 })]
        : from === 102n
          ? [v3MintLog(V3_ADDR, from)]
          : [v3BurnLog(V3_ADDR, from)],
    )
    await cache.init(100n)
    const r1 = await cache.applyBlock(101n)
    expect([...r1.touched]).toEqual([V3.poolId])
    expect(fetchStates).toHaveBeenCalledTimes(1)
    expect(cache.get(V3.poolId)).toMatchObject({ sqrtPriceX96: 123n, liquidity: 42n, tick: 5, block: 101 })
    const r2 = await cache.applyBlock(102n)
    expect([...r2.touched]).toEqual([V3.poolId])
    expect(fetchStates).toHaveBeenCalledTimes(2)
    expect(fetchStates.mock.calls[1]?.[2].map((p) => p.poolId)).toEqual([V3.poolId])
    const r3 = await cache.applyBlock(103n)
    expect([...r3.touched]).toEqual([V3.poolId])
    expect(fetchStates).toHaveBeenCalledTimes(3)
  })

  it('v4 logs keep working and only the PoolManager may emit them; unknown emitters are ignored', async () => {
    const { cache, fetchStates } = makeCache((from) => [
      v4SwapLog(POOL_MANAGER, V4.poolId, from, 555n),
      // a stranger emitting a v4-shaped Swap with a tracked pool id must not be trusted
      v4SwapLog(STRANGER, V4.poolId, from, 666n),
      // a stranger emitting a v3-shaped Swap / v2 Sync is not a tracked pool either
      v3SwapLog(STRANGER, from, { sqrtPriceX96: 1n, liquidity: 1n, tick: 1 }),
      v2SyncLog(STRANGER, from, 1n, 1n),
      // a v2-shaped Sync from the v3 pool address is not a v3 Swap: treated as "something changed" -> refetch
      v2SyncLog(V3_ADDR, from, 1n, 1n),
      // a v3-shaped Swap from the v2 pair is ignored (only Sync moves a pair)
      v3SwapLog(V2_ADDR, from, { sqrtPriceX96: 1n, liquidity: 1n, tick: 1 }),
    ])
    await cache.init(100n)
    const r = await cache.applyBlock(101n)
    expect([...r.touched].sort()).toEqual([V3.poolId, V4.poolId].sort())
    expect(cache.get(V4.poolId)?.sqrtPriceX96).toBe(555n)
    expect(cache.get(V2.poolId)?.reserves).toEqual(RESERVES)
    expect(fetchStates).toHaveBeenCalledTimes(2)
    expect(fetchStates.mock.calls[1]?.[2].map((p) => p.poolId)).toEqual([V3.poolId])
  })

  it('returns the replayed logs (for the probe) and omits them when it refetched instead', async () => {
    const { cache } = makeCache((from, to) => [v4SwapLog(POOL_MANAGER, V4.poolId, from, 555n), v2SyncLog(V2_ADDR, to, 1n, 1n)])
    await cache.init(100n)
    const r = await cache.applyBlock(102n)
    expect(r.replayed?.fromBlock).toBe(101n)
    expect(r.replayed?.logs.map((l) => l.address)).toEqual([POOL_MANAGER, V2_ADDR])
    // A gap beyond maxReplayBlocks (50) is a full refetch: nothing was replayed.
    const far = await cache.applyBlock(102n + 51n)
    expect(far.replayed).toBeUndefined()
    expect(far.touched.size).toBe(3)
    // A no-op (stale block) carries no logs either.
    expect((await cache.applyBlock(102n + 51n)).replayed).toBeUndefined()
  })

  it('the default log fetcher asks for one block range with the tracked topics and no address filter', async () => {
    const requests: unknown[] = []
    const http = {
      request: async (req: { method: string; params: unknown[] }) => {
        requests.push(req)
        return []
      },
    }
    const real = { http, chain: arc, sendUrls: [] } as unknown as RpcClients
    const fetchStates = vi.fn(async (_c: RpcClients, _cfg: unknown, pools: readonly PoolInfo[], block: bigint) =>
      new Map(pools.map((p) => [p.poolId, fakeState(p, block)] as const)),
    )
    const cache = new StateCache(real, cfg, [V4, V3, V2], { fetchStates: fetchStates as unknown as typeof import('../../src/state/reader.js').fetchPoolStates })
    await cache.init(100n)
    await cache.applyBlock(102n)
    expect(requests).toHaveLength(1)
    const req = requests[0] as { method: string; params: [{ address?: unknown; fromBlock: Hex; toBlock: Hex; topics: Hex[][] }] }
    expect(req.method).toBe('eth_getLogs')
    expect(req.params[0].address).toBeUndefined()
    expect(req.params[0].fromBlock).toBe('0x65')
    expect(req.params[0].toBlock).toBe('0x66')
    expect(req.params[0].topics).toEqual(TRACKED_TOPICS)
  })
})
