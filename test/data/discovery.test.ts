import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, decodeFunctionData, toHex, type Address, type Hex } from 'viem'
import { multicall3Abi, poolManagerAbi, v2FactoryAbi, v2PairAbi, v3FactoryAbi, v3PoolAbi } from '../../src/abi/index.js'
import { ADDRESSES, arc } from '../../src/chains.js'
import { loadConfig, type Config } from '../../src/config.js'
import {
  DEFAULT_V2_FEE_PIPS,
  decodeVenuePool,
  refreshActivity,
  refreshLiquidity,
  scanPools,
  scanVenues,
  selectTrackedPools,
  toPoolInfo,
  venuesOf,
} from '../../src/discovery/scan.js'
import { emptyPoolStore, loadPoolStore, savePoolStore, type StoredPool } from '../../src/discovery/store.js'
import { isqrt } from '../../src/math/v2.js'
import type { RpcClients } from '../../src/rpc/client.js'
import type { RawLog } from '../../src/rpc/logs.js'
import { liquiditySlot } from '../../src/state/slots.js'
import { addressToPoolId, NATIVE, type PoolInfo } from '../../src/types.js'

const A = ADDRESSES[5042]!
const V3_FACTORY = A.v3Factories[0]!.address
const V2_FACTORY = A.v2Factories[0]!.address
const DYOR_FACTORY = A.v2Factories[1]!.address
const USDC = A.usdc
const CIRBTC = A.cirBtc!
const USDT = '0xb4337b8d148aa7a1f2124d9f6362234fff0fbbbb' as Address
const V3_POOL = '0x82916bee18fcef517b26c72d7cb5f13694e1db41' as Address
const V2_PAIR = '0x5dbf58814d0736fa09b6ad7f290800b805dd383d' as Address
const DYOR_PAIR = '0x00000000000000000000000000000000000d0e0f' as Address
const V4_ID = '0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae' as Hex

/** A log in the JSON-RPC wire shape (`eth_getLogs` result). */
interface WireLog {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  logIndex: Hex
  transactionIndex: Hex
  blockHash: Hex
  transactionHash: Hex
  removed: boolean
}

let logIndex = 0
function wire(address: Address, block: number, topics: readonly (Hex | Hex[] | null)[], data: Hex): WireLog {
  return {
    address,
    topics: topics as Hex[],
    data,
    blockNumber: toHex(block),
    logIndex: toHex(logIndex++),
    transactionIndex: '0x0',
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    removed: false,
  }
}

function poolCreated(factory: Address, block: number, token0: Address, token1: Address, fee: number, tickSpacing: number, pool: Address): WireLog {
  const topics = encodeEventTopics({ abi: v3FactoryAbi, eventName: 'PoolCreated', args: { token0, token1, fee } })
  return wire(factory, block, topics, encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [tickSpacing, pool]))
}

function pairCreated(factory: Address, block: number, token0: Address, token1: Address, pair: Address): WireLog {
  const topics = encodeEventTopics({ abi: v2FactoryAbi, eventName: 'PairCreated', args: { token0, token1 } })
  return wire(factory, block, topics, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [pair, 1n]))
}

function v4Swap(block: number, id: Hex, emitter: Address = A.poolManager): WireLog {
  const topics = encodeEventTopics({ abi: poolManagerAbi, eventName: 'Swap', args: { id, sender: NATIVE } })
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [-1n, 1n, 1n, 1n, 0, 0],
  )
  return wire(emitter, block, topics, data)
}

function v3Swap(block: number, emitter: Address): WireLog {
  const topics = encodeEventTopics({ abi: v3PoolAbi, eventName: 'Swap', args: { sender: NATIVE, recipient: NATIVE } })
  const data = encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [-1n, 1n, 1n, 1n, 0])
  return wire(emitter, block, topics, data)
}

function v2Swap(block: number, emitter: Address): WireLog {
  const topics = encodeEventTopics({ abi: v2PairAbi, eventName: 'Swap', args: { sender: NATIVE, to: NATIVE } })
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 0n, 0n, 1n])
  return wire(emitter, block, topics, data)
}

interface LogsRequest {
  address?: Address | Address[]
  fromBlock: Hex
  toBlock: Hex
  topics?: Hex[][]
}

/** Fake RPC whose `eth_getLogs` answers from `logs` (ignoring the emitter filter on purpose, see tests). */
function fakeClients(logs: WireLog[], extra: Record<string, unknown> = {}) {
  const requests: LogsRequest[] = []
  const client = {
    request: async ({ method, params }: { method: string; params: [LogsRequest] }) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      const q = params[0]
      requests.push(q)
      const from = Number(BigInt(q.fromBlock))
      const to = Number(BigInt(q.toBlock))
      const topic0 = q.topics?.[0]
      return logs.filter((l) => {
        const b = Number(BigInt(l.blockNumber))
        if (b < from || b > to) return false
        if (topic0 && !topic0.includes(l.topics[0] as Hex)) return false
        return true
      })
    },
    ...extra,
  }
  const clients = { http: client, httpSingle: client, chain: arc, sendUrls: [] } as unknown as RpcClients
  return { clients, requests }
}

describe('scanVenues', () => {
  let dir: string
  let cfg: Config
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arc-mev-venues-'))
    cfg = loadConfig({ DATA_DIR: dir, LOG_LEVEL: 'error' })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists the configured venues with their kinds', () => {
    expect(venuesOf(cfg).map((v) => [v.name, v.kind, v.address])).toEqual([
      ['uniswap-v3', 1, V3_FACTORY],
      ['uniswap-v2', 2, V2_FACTORY],
      ['dyorswap', 2, DYOR_FACTORY],
    ])
  })

  it('upserts v3 pools and v2 pairs with kind/pool/venue, resumes per venue, and persists', async () => {
    const logs = [
      poolCreated(V3_FACTORY, 2_000_000, CIRBTC, USDC, 100, 1, V3_POOL),
      pairCreated(V2_FACTORY, 2_000_001, USDC, USDT, V2_PAIR),
      pairCreated(DYOR_FACTORY, 4_150_000, USDC, USDT, DYOR_PAIR),
    ]
    const { clients, requests } = fakeClients(logs)
    const store = emptyPoolStore(5042)
    const progress: Array<[number, string[]]> = []
    await scanVenues(clients, cfg, store, { toBlock: 4_200_000n, onProgress: (b, v) => progress.push([b, v]) })

    const v3 = store.pools[addressToPoolId(V3_POOL)]!
    expect(v3).toEqual({
      poolId: addressToPoolId(V3_POOL),
      currency0: CIRBTC,
      currency1: USDC,
      fee: 100,
      tickSpacing: 1,
      hooks: NATIVE,
      block: 2_000_000,
      kind: 1,
      pool: V3_POOL,
      venue: 'uniswap-v3',
    })
    expect(store.pools[addressToPoolId(V2_PAIR)]).toEqual({
      poolId: addressToPoolId(V2_PAIR),
      currency0: USDC,
      currency1: USDT,
      fee: 3000,
      tickSpacing: 0,
      hooks: NATIVE,
      block: 2_000_001,
      kind: 2,
      pool: V2_PAIR,
      venue: 'uniswap-v2',
    })
    expect(store.pools[addressToPoolId(DYOR_PAIR)]).toMatchObject({ kind: 2, venue: 'dyorswap', fee: DEFAULT_V2_FEE_PIPS, block: 4_150_000 })
    expect(store.venues).toEqual({
      'uniswap-v3': { lastScannedBlock: 4_200_000 },
      'uniswap-v2': { lastScannedBlock: 4_200_000 },
      dyorswap: { lastScannedBlock: 4_200_000 },
    })
    expect(store.lastScannedBlock).toBe(0) // the v4 resume point is untouched

    // Range: from the earliest deploy block (1,948,019) in 10k chunks; dyorswap joins from the
    // 100k-block segment that contains its deploy block (4,130,418 lies in [4,048,019, 4,148,018]);
    // every request carries the any-of topic filter.
    expect(requests[0]?.fromBlock).toBe(toHex(1_948_019))
    expect(requests[requests.length - 1]?.toBlock).toBe(toHex(4_200_000))
    const dyorSegmentStart = 1_948_019 + 100_000 * Math.floor((4_130_418 - 1_948_019) / 100_000)
    expect(dyorSegmentStart).toBe(4_048_019)
    for (const q of requests) {
      expect(q.topics?.[0]).toHaveLength(2)
      const addrs = q.address as Address[]
      expect(Array.isArray(addrs)).toBe(true)
      if (Number(BigInt(q.toBlock)) < dyorSegmentStart) expect(addrs).toEqual([V3_FACTORY, V2_FACTORY])
      else expect(addrs).toEqual([V3_FACTORY, V2_FACTORY, DYOR_FACTORY])
    }
    // 100k-block segments -> progress every segment, last one at toBlock
    expect(progress.length).toBeGreaterThan(20)
    expect(progress[progress.length - 1]).toEqual([4_200_000, ['uniswap-v3', 'uniswap-v2', 'dyorswap']])

    // Persisted: reload equals the in-memory store, including the new fields and venues.
    const loaded = await loadPoolStore(cfg)
    expect(loaded).toEqual(store)

    // Resume: nothing to scan at the same head -> no request at all.
    const before = requests.length
    await scanVenues(clients, cfg, loaded, { toBlock: 4_200_000n })
    expect(requests.length).toBe(before)
    // Scanning further starts at every venue's resume point + 1.
    await scanVenues(clients, cfg, loaded, { toBlock: 4_200_010n })
    expect(requests[requests.length - 1]).toMatchObject({ fromBlock: toHex(4_200_001), toBlock: toHex(4_200_010) })
    expect(loaded.venues['dyorswap']?.lastScannedBlock).toBe(4_200_010)
  })

  it('shares one pass across venues with different resume points and ignores logs below a venue\'s own resume', async () => {
    const logs = [
      pairCreated(V2_FACTORY, 4_150_000, USDC, USDT, V2_PAIR), // below uniswap-v2's resume: must be skipped
      poolCreated(V3_FACTORY, 4_150_001, CIRBTC, USDC, 500, 10, V3_POOL),
      pairCreated(V2_FACTORY, 4_250_000, USDC, USDT, DYOR_PAIR),
    ]
    const { clients, requests } = fakeClients(logs)
    const store = emptyPoolStore(5042)
    store.venues = { 'uniswap-v3': { lastScannedBlock: 4_100_000 }, 'uniswap-v2': { lastScannedBlock: 4_200_000 }, dyorswap: { lastScannedBlock: 4_200_000 } }
    await scanVenues(clients, cfg, store, { toBlock: 4_300_000n })
    expect(Object.keys(store.pools).sort()).toEqual([addressToPoolId(V3_POOL), addressToPoolId(DYOR_PAIR)].sort())
    expect(store.pools[addressToPoolId(DYOR_PAIR)]?.venue).toBe('uniswap-v2')
    // First segment [4,100,001 .. 4,200,000]: only the v3 factory is active; second: all three.
    const first = requests.filter((q) => Number(BigInt(q.toBlock)) <= 4_200_000)
    const second = requests.filter((q) => Number(BigInt(q.fromBlock)) > 4_200_000)
    expect(first.length).toBeGreaterThan(0)
    for (const q of first) expect(q.address).toEqual([V3_FACTORY])
    for (const q of second) expect(q.address).toEqual([V3_FACTORY, V2_FACTORY, DYOR_FACTORY])
    expect(store.venues).toEqual({
      'uniswap-v3': { lastScannedBlock: 4_300_000 },
      'uniswap-v2': { lastScannedBlock: 4_300_000 },
      dyorswap: { lastScannedBlock: 4_300_000 },
    })
    // `names` restricts the venues; `fromBlock` overrides the resume point.
    const only = fakeClients(logs)
    const s2 = emptyPoolStore(5042)
    await scanVenues(only.clients, cfg, s2, { names: ['uniswap-v2'], fromBlock: 4_140_000n, toBlock: 4_160_000n })
    expect(only.requests).toHaveLength(3)
    for (const q of only.requests) expect(q.address).toEqual([V2_FACTORY])
    expect(Object.keys(s2.pools)).toEqual([addressToPoolId(V2_PAIR)])
    expect(s2.venues).toEqual({ 'uniswap-v2': { lastScannedBlock: 4_160_000 } })
  })

  it('scanPools runs the v4 scan and then the venue scan over the same bounded range', async () => {
    const logs = [poolCreated(V3_FACTORY, 21_076_890, CIRBTC, USDC, 100, 1, V3_POOL)]
    const { clients, requests } = fakeClients(logs)
    const store = emptyPoolStore(5042)
    const v4Progress: number[] = []
    const venueProgress: number[] = []
    await scanPools(clients, cfg, store, {
      fromBlock: 21_070_000n,
      toBlock: 21_079_999n,
      onProgress: (b) => v4Progress.push(b),
      onVenueProgress: (b) => venueProgress.push(b),
    })
    expect(v4Progress).toEqual([21_079_999])
    expect(venueProgress).toEqual([21_079_999])
    expect(store.lastScannedBlock).toBe(21_079_999)
    expect(store.venues['uniswap-v3']?.lastScannedBlock).toBe(21_079_999)
    expect(store.pools[addressToPoolId(V3_POOL)]?.kind).toBe(1)
    // one PoolManager request (single address) + one venue request (address list)
    expect(requests.map((q) => (typeof q.address === 'string' ? 'pm' : 'venues'))).toEqual(['pm', 'venues'])
    // venues: false skips the factories
    const alone = fakeClients(logs)
    await scanPools(alone.clients, cfg, emptyPoolStore(5042), { fromBlock: 21_070_000n, toBlock: 21_079_999n, venues: false })
    expect(alone.requests).toHaveLength(1)
  })

  it('decodeVenuePool rejects logs of the wrong kind', () => {
    const [v3, v2] = venuesOf(cfg)
    const raw = poolCreated(V3_FACTORY, 5, CIRBTC, USDC, 100, 1, V3_POOL)
    const asRaw = { ...raw, blockNumber: 5n, logIndex: 0 } as unknown as RawLog
    expect(decodeVenuePool(asRaw, v3!)?.kind).toBe(1)
    expect(decodeVenuePool(asRaw, v2!)).toBeUndefined()
  })
})

describe('refreshLiquidity / refreshActivity / selection with mixed kinds', () => {
  const cfg = loadConfig({ DATA_DIR: '/nonexistent', LOG_LEVEL: 'error' })
  const v4: StoredPool = { poolId: V4_ID, currency0: USDC, currency1: A.eurc!, fee: 500, tickSpacing: 10, hooks: NATIVE, block: 1 }
  const v3: StoredPool = { poolId: addressToPoolId(V3_POOL), currency0: CIRBTC, currency1: USDC, fee: 100, tickSpacing: 1, hooks: NATIVE, block: 2, kind: 1, pool: V3_POOL, venue: 'uniswap-v3' }
  const v2: StoredPool = { poolId: addressToPoolId(V2_PAIR), currency0: USDC, currency1: USDT, fee: 3000, tickSpacing: 0, hooks: NATIVE, block: 3, kind: 2, pool: V2_PAIR, venue: 'uniswap-v2' }
  const broken: StoredPool = { ...v2, poolId: addressToPoolId(DYOR_PAIR), pool: DYOR_PAIR, venue: 'dyorswap' }
  const RESERVES = { reserve0: 131_728_917_690n, reserve1: 19_289_382_464_293_860_158_984_989n }

  function storeWith(): ReturnType<typeof emptyPoolStore> {
    const store = emptyPoolStore(5042)
    for (const p of [v4, v3, v2, broken]) store.pools[p.poolId] = { ...p }
    return store
  }

  it('refreshLiquidity reads v4 via extsload and v3/v2 via one Multicall3 pass (failures store 0)', async () => {
    let extsloadCalls = 0
    let multicalls = 0
    const { clients } = fakeClients([], {
      readContract: async ({ args }: { args: [Hex[]] }) => {
        extsloadCalls++
        expect(args[0]).toEqual([liquiditySlot(V4_ID)])
        return [toHex(31_822_925_403_206n, { size: 32 })]
      },
      call: async ({ data }: { data: Hex }) => {
        multicalls++
        const { args } = decodeFunctionData({ abi: multicall3Abi, data })
        const results = args[0].map((c) => {
          const target = c.target.toLowerCase()
          if (target === V3_POOL) {
            expect(decodeFunctionData({ abi: v3PoolAbi, data: c.callData }).functionName).toBe('liquidity')
            return { success: true, returnData: encodeAbiParameters([{ type: 'uint128' }], [401_045_617_221n]) }
          }
          if (target === V2_PAIR) {
            expect(decodeFunctionData({ abi: v2PairAbi, data: c.callData }).functionName).toBe('getReserves')
            return { success: true, returnData: encodeAbiParameters([{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }], [RESERVES.reserve0, RESERVES.reserve1, 0]) }
          }
          return { success: false, returnData: '0x' as Hex }
        })
        return { data: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results }) }
      },
    })
    const store = storeWith()
    await refreshLiquidity(clients, cfg, store, { block: 100n })
    expect(extsloadCalls).toBe(1)
    expect(multicalls).toBe(1)
    expect(store.pools[V4_ID]?.liquidity).toBe('31822925403206')
    expect(store.pools[v3.poolId]?.liquidity).toBe('401045617221')
    expect(store.pools[v2.poolId]?.liquidity).toBe(isqrt(RESERVES.reserve0 * RESERVES.reserve1).toString())
    expect(store.pools[v2.poolId]?.liquidity).toBe('1594041867370457515')
    expect(store.pools[broken.poolId]?.liquidity).toBe('0')
  })

  it('refreshActivity matches v4 swaps by pool id (PoolManager only) and v3/v2 swaps by emitter, without an address filter', async () => {
    const logs = [
      v4Swap(990, V4_ID),
      v4Swap(995, V4_ID),
      v4Swap(999, V4_ID, '0x9999999999999999999999999999999999999999'), // stranger with a tracked id: ignored
      v4Swap(999, '0x00000000000000000000000000000000000000000000000000000000000000ff'), // unknown pool
      v3Swap(997, V3_POOL),
      v3Swap(998, '0x8888888888888888888888888888888888888888'), // unknown v3 pool
      v2Swap(996, V2_PAIR),
      v2Swap(1000, V2_PAIR),
    ]
    const { clients, requests } = fakeClients(logs)
    const store = storeWith()
    store.pools[v2.poolId]!.lastSwapBlock = 2000 // never moved backwards
    await refreshActivity(clients, cfg, store, 100, { toBlock: 1000n })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.address).toBeUndefined()
    expect(requests[0]?.topics?.[0]).toHaveLength(3)
    expect(requests[0]).toMatchObject({ fromBlock: toHex(901), toBlock: toHex(1000) })
    expect(store.pools[V4_ID]).toMatchObject({ swapCount: 2, lastSwapBlock: 995 })
    expect(store.pools[v3.poolId]).toMatchObject({ swapCount: 1, lastSwapBlock: 997 })
    expect(store.pools[v2.poolId]).toMatchObject({ swapCount: 2, lastSwapBlock: 2000 })
    expect(store.pools[broken.poolId]?.swapCount).toBe(0)
    expect(store.pools[broken.poolId]?.lastSwapBlock).toBeUndefined()
  })

  it('selectTrackedPools treats all kinds uniformly and keeps kind/pool/venue on the PoolInfo', async () => {
    const store = storeWith()
    store.pools[V4_ID]!.liquidity = '5000'
    store.pools[v3.poolId]!.liquidity = '4000'
    store.pools[v2.poolId]!.liquidity = '3000'
    store.pools[broken.poolId]!.liquidity = '0'
    // a second v3 pool on cirBTC/USDC so the pair can form a 2-hop cycle through USDC
    const v3b: StoredPool = { ...v3, poolId: addressToPoolId('0x000000000000000000000000000000000000abcd'), pool: '0x000000000000000000000000000000000000abcd', fee: 3000, tickSpacing: 60, liquidity: '2000' }
    store.pools[v3b.poolId] = v3b
    const sel = { allowedHooks: new Set<Address>(), MIN_POOL_LIQUIDITY: 1000n, MAX_TRACKED_POOLS: 10 }
    const all = selectTrackedPools(sel, store)
    expect(all.map((p) => p.poolId)).toEqual([V4_ID, v3.poolId, v2.poolId, v3b.poolId])
    expect(all[1]).toEqual(toPoolInfo(v3))
    expect(Object.keys(all[1]!).sort()).toEqual(['block', 'currency0', 'currency1', 'fee', 'hooks', 'kind', 'pool', 'poolId', 'tickSpacing', 'venue'])
    expect(all[2]).toMatchObject({ kind: 2, pool: V2_PAIR, venue: 'uniswap-v2', tickSpacing: 0 })
    expect(Object.keys(all[0]!).sort()).toEqual(['block', 'currency0', 'currency1', 'fee', 'hooks', 'poolId', 'tickSpacing'])
    // Cycle capability: only the two cirBTC/USDC v3 pools can form a cycle through USDC.
    const capable = selectTrackedPools(sel, store, { startCurrencies: new Set([USDC]) })
    expect(capable.map((p) => p.poolId)).toEqual([v3.poolId, v3b.poolId])

    // The store round-trips v2's tickSpacing 0 and the venue fields (schema accepts them).
    const dir = await mkdtemp(join(tmpdir(), 'arc-mev-venues-'))
    try {
      const fcfg = { DATA_DIR: dir, CHAIN_ID: 5042 }
      store.venues = { 'uniswap-v3': { lastScannedBlock: 5 } }
      await savePoolStore(fcfg, store)
      expect(await loadPoolStore(fcfg)).toEqual(store)
      // A stage-1 file without `venues` loads with an empty venue map.
      const { venues: _omit, ...legacy } = store
      await savePoolStore(fcfg, legacy as unknown as typeof store)
      expect((await loadPoolStore(fcfg)).venues).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** Keep the PoolInfo type honest for the fixtures above. */
const _typeCheck: PoolInfo = { poolId: V4_ID, currency0: USDC, currency1: USDT, fee: 0, tickSpacing: 0, hooks: NATIVE, block: 0 }
void _typeCheck
