import { decodeEventLog, encodeFunctionData, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem'
import { poolManagerAbi, v2FactoryAbi, v2PairAbi, v3FactoryAbi, v3PoolAbi } from '../abi/index.js'
import { ADDRESSES, type VenueFactory } from '../chains.js'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { isqrt } from '../math/v2.js'
import { extsload, limiter, type RpcClients } from '../rpc/client.js'
import { BACKFILL_RETRY, getLogsChunked, MAX_LOG_RANGE, safeHead, type RawLog } from '../rpc/logs.js'
import { aggregate3, type Call3 } from '../rpc/multicall.js'
import { decodeUint128, liquiditySlot } from '../state/slots.js'
import { decodeV2Reserves } from '../state/v2.js'
import { decodeV3Liquidity } from '../state/v3.js'
import { addressToPoolId, NATIVE, poolKind, type PoolInfo, type PoolKind } from '../types.js'
import { savePoolStore, type PoolStore, type StoredPool } from './store.js'

type PoolManagerEvent = Extract<(typeof poolManagerAbi)[number], { type: 'event' }>
const INITIALIZE = poolManagerAbi.filter((i): i is PoolManagerEvent => i.type === 'event' && i.name === 'Initialize')
const SWAP = poolManagerAbi.filter((i): i is PoolManagerEvent => i.type === 'event' && i.name === 'Swap')

const POOL_CREATED = v3FactoryAbi.find((i) => i.type === 'event' && i.name === 'PoolCreated') as AbiEvent
const PAIR_CREATED = v2FactoryAbi.find((i) => i.type === 'event' && i.name === 'PairCreated') as AbiEvent
const V3_SWAP = v3PoolAbi.find((i) => i.type === 'event' && i.name === 'Swap') as AbiEvent
const V2_SWAP = v2PairAbi.find((i) => i.type === 'event' && i.name === 'Swap') as AbiEvent
const POOL_CREATED_TOPIC = toEventSelector(POOL_CREATED)
const PAIR_CREATED_TOPIC = toEventSelector(PAIR_CREATED)

/** Fee assumed for a v2-style factory whose `VenueFactory.feePips` is not set (canonical 0.30%). */
export const DEFAULT_V2_FEE_PIPS = 3000

/** Options for {@link scanPools}. */
export interface ScanOptions {
  /** Scan up to this block (inclusive). Default: `safeHead`. */
  toBlock?: bigint
  /** Scan from this block (inclusive), overriding every resume point. Mainly for bounded test runs. */
  fromBlock?: bigint
  /** Called after every persisted PoolManager segment with the last scanned block. */
  onProgress?: (block: number) => void
  /** Called after every persisted venue segment with the last scanned block and the venues it covered. */
  onVenueProgress?: (block: number, venues: string[]) => void
  /** Log chunks (10k blocks each) per persisted segment. Default 10 (=100k blocks). */
  persistEveryChunks?: number
  /** Parallel `eth_getLogs` requests. Default 3. */
  concurrency?: number
  /** Also scan the v3/v2 factories of `ADDRESSES[chain]` (see {@link scanVenues}). Default true. */
  venues?: boolean
}

/**
 * Scan PoolManager `Initialize` logs from `max(store.lastScannedBlock + 1, deployBlock)` to the
 * safe head, upserting every pool into `store`, then (unless `opts.venues` is false) every v3/v2
 * factory's creation logs with {@link scanVenues}. Progress is persisted every
 * `persistEveryChunks` x 10k blocks so an interrupted scan resumes where it stopped.
 */
export async function scanPools(
  clients: RpcClients,
  cfg: Config,
  store: PoolStore,
  opts: ScanOptions = {},
): Promise<PoolStore> {
  const addresses = requireAddresses(cfg)
  const resume = BigInt(Math.max(store.lastScannedBlock + 1, addresses.poolManagerDeployBlock))
  const from = opts.fromBlock ?? resume
  const to = opts.toBlock ?? (await safeHead(clients.http))
  if (to < from) {
    log.info({ from, to }, 'scanPools: nothing to scan')
  } else {
    const segment = BigInt(MAX_LOG_RANGE * (opts.persistEveryChunks ?? 10))
    log.info({ from, to, pools: Object.keys(store.pools).length }, 'scanPools: start')
    for (let start = from; start <= to; start += segment) {
      const end = start + segment - 1n < to ? start + segment - 1n : to
      const logs = await getLogsChunked(clients.http, {
        address: addresses.poolManager,
        events: INITIALIZE,
        fromBlock: start,
        toBlock: end,
        concurrency: opts.concurrency ?? 2,
      retry: BACKFILL_RETRY,
      })
      let added = 0
      for (const raw of logs) {
        const info = decodeInitialize(raw)
        if (!(info.poolId in store.pools)) added++
        store.pools[info.poolId] = { ...store.pools[info.poolId], ...info }
      }
      store.lastScannedBlock = Math.max(store.lastScannedBlock, Number(end))
      await savePoolStore(cfg, store)
      opts.onProgress?.(store.lastScannedBlock)
      log.info({ start, end, logs: logs.length, added, total: Object.keys(store.pools).length }, 'scanPools: segment done')
    }
  }
  if (opts.venues ?? true) {
    await scanVenues(clients, cfg, store, {
      toBlock: to,
      ...(opts.fromBlock === undefined ? {} : { fromBlock: opts.fromBlock }),
      ...(opts.onVenueProgress === undefined ? {} : { onProgress: opts.onVenueProgress }),
      ...(opts.persistEveryChunks === undefined ? {} : { persistEveryChunks: opts.persistEveryChunks }),
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    })
  }
  return store
}

/** Decode one `Initialize` log into a {@link PoolInfo} (addresses lower-cased). */
export function decodeInitialize(raw: RawLog): PoolInfo {
  const { args } = decodeEventLog({ abi: poolManagerAbi, eventName: 'Initialize', data: raw.data, topics: raw.topics })
  return {
    poolId: args.id.toLowerCase() as Hex,
    currency0: args.currency0.toLowerCase() as Address,
    currency1: args.currency1.toLowerCase() as Address,
    fee: args.fee,
    tickSpacing: args.tickSpacing,
    hooks: args.hooks.toLowerCase() as Address,
    block: Number(raw.blockNumber),
  }
}

// ---------------------------------------------------------------------------------------------
// v3-style / v2-style venues
// ---------------------------------------------------------------------------------------------

/** A configured factory with the pool kind its pools have. */
export interface Venue extends VenueFactory {
  kind: Exclude<PoolKind, 0>
}

/** The v3/v2 factories configured for the chain, lower-cased, each tagged with its pool kind. */
export function venuesOf(cfg: Pick<Config, 'CHAIN_ID'>): Venue[] {
  const addresses = requireAddresses(cfg)
  const tag = (f: VenueFactory, kind: Venue['kind']): Venue => ({ ...f, address: f.address.toLowerCase() as Address, kind })
  return [...addresses.v3Factories.map((f) => tag(f, 1)), ...addresses.v2Factories.map((f) => tag(f, 2))]
}

/** Options for {@link scanVenues}. */
export interface ScanVenuesOptions {
  /** Scan up to this block (inclusive). Default: `safeHead`. */
  toBlock?: bigint
  /** Scan from this block (inclusive), overriding every venue's resume point. */
  fromBlock?: bigint
  /** Only these venues (by `VenueFactory.name`). Default: all configured. */
  names?: readonly string[]
  /** Called after every persisted segment with the last scanned block and the venues it covered. */
  onProgress?: (block: number, venues: string[]) => void
  /** Log chunks (10k blocks each) per persisted segment. Default 10 (=100k blocks). */
  persistEveryChunks?: number
  /** Parallel `eth_getLogs` requests. Default 3. */
  concurrency?: number
}

/**
 * Scan `PoolCreated` (v3-style factories) and `PairCreated` (v2-style factories) logs and upsert
 * the pools into `store` with `kind`, `pool`, `venue`, `poolId = addressToPoolId(pool)`, the fee
 * (v3: from the event; v2: `factory.feePips`), the tick spacing (v2: 0) and zero hooks.
 *
 * Every venue resumes from `max(store.venues[name].lastScannedBlock + 1, deployBlock)`. All venues
 * that still have blocks to scan share one pass over the chain (one `eth_getLogs` per 10k blocks
 * with an emitter list), logs below a venue's own resume point are ignored, and after every
 * persisted segment each venue covered by it has its resume point moved to the segment end.
 */
export async function scanVenues(
  clients: RpcClients,
  cfg: Config,
  store: PoolStore,
  opts: ScanVenuesOptions = {},
): Promise<PoolStore> {
  const venues = venuesOf(cfg).filter((v) => opts.names === undefined || opts.names.includes(v.name))
  if (venues.length === 0) {
    log.info({ names: opts.names }, 'scanVenues: no venues configured')
    return store
  }
  const to = opts.toBlock ?? (await safeHead(clients.http))
  const resumeOf = new Map<string, bigint>()
  for (const v of venues) {
    const scanned = store.venues[v.name]?.lastScannedBlock ?? 0
    resumeOf.set(v.name, opts.fromBlock ?? BigInt(Math.max(scanned + 1, v.deployBlock)))
  }
  const pending = venues.filter((v) => (resumeOf.get(v.name) as bigint) <= to)
  if (pending.length === 0) {
    log.info({ to, venues: venues.map((v) => v.name) }, 'scanVenues: nothing to scan')
    return store
  }
  const from = pending.map((v) => resumeOf.get(v.name) as bigint).reduce((a, b) => (a < b ? a : b))
  const byAddress = new Map<Address, Venue>(venues.map((v) => [v.address, v]))
  const segment = BigInt(MAX_LOG_RANGE * (opts.persistEveryChunks ?? 10))
  log.info({ from, to, venues: pending.map((v) => v.name) }, 'scanVenues: start')

  for (let start = from; start <= to; start += segment) {
    const end = start + segment - 1n < to ? start + segment - 1n : to
    const active = pending.filter((v) => (resumeOf.get(v.name) as bigint) <= end)
    if (active.length === 0) continue
    const logs = await getLogsChunked(clients.http, {
      address: active.map((v) => v.address),
      events: [POOL_CREATED, PAIR_CREATED],
      fromBlock: start,
      toBlock: end,
      concurrency: opts.concurrency ?? 2,
      retry: BACKFILL_RETRY,
    })
    let added = 0
    let skipped = 0
    for (const raw of logs) {
      const venue = byAddress.get(raw.address.toLowerCase() as Address)
      if (!venue || raw.blockNumber < (resumeOf.get(venue.name) as bigint)) continue
      const info = decodeVenuePool(raw, venue)
      if (!info) {
        skipped++
        continue
      }
      if (!(info.poolId in store.pools)) added++
      store.pools[info.poolId] = { ...store.pools[info.poolId], ...info }
    }
    for (const v of active) {
      const prev = store.venues[v.name]?.lastScannedBlock ?? 0
      store.venues[v.name] = { lastScannedBlock: Math.max(prev, Number(end)) }
    }
    await savePoolStore(cfg, store)
    opts.onProgress?.(Number(end), active.map((v) => v.name))
    log.info({ start, end, logs: logs.length, added, skipped, venues: active.map((v) => v.name) }, 'scanVenues: segment done')
  }
  return store
}

/**
 * Decode a `PoolCreated` / `PairCreated` log of `venue` into a {@link PoolInfo}; `undefined` (with
 * a debug log) when the log does not match the venue's kind or does not decode.
 */
export function decodeVenuePool(raw: RawLog, venue: Venue): PoolInfo | undefined {
  const topic0 = raw.topics[0]?.toLowerCase()
  try {
    if (venue.kind === 1 && topic0 === POOL_CREATED_TOPIC) {
      const { args } = decodeEventLog({ abi: v3FactoryAbi, eventName: 'PoolCreated', data: raw.data, topics: raw.topics })
      const pool = args.pool.toLowerCase() as Address
      return {
        poolId: addressToPoolId(pool),
        currency0: args.token0.toLowerCase() as Address,
        currency1: args.token1.toLowerCase() as Address,
        fee: args.fee,
        tickSpacing: args.tickSpacing,
        hooks: NATIVE,
        block: Number(raw.blockNumber),
        kind: 1,
        pool,
        venue: venue.name,
      }
    }
    if (venue.kind === 2 && topic0 === PAIR_CREATED_TOPIC) {
      const { args } = decodeEventLog({ abi: v2FactoryAbi, eventName: 'PairCreated', data: raw.data, topics: raw.topics })
      const pool = args.pair.toLowerCase() as Address
      return {
        poolId: addressToPoolId(pool),
        currency0: args.token0.toLowerCase() as Address,
        currency1: args.token1.toLowerCase() as Address,
        fee: venue.feePips ?? DEFAULT_V2_FEE_PIPS,
        tickSpacing: 0,
        hooks: NATIVE,
        block: Number(raw.blockNumber),
        kind: 2,
        pool,
        venue: venue.name,
      }
    }
  } catch (error) {
    log.debug({ err: error, venue: venue.name, block: raw.blockNumber, logIndex: raw.logIndex }, 'undecodable factory log')
    return undefined
  }
  log.debug({ venue: venue.name, topic0, block: raw.blockNumber }, 'factory log of the wrong kind ignored')
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Liquidity and activity refresh (all kinds)
// ---------------------------------------------------------------------------------------------

/** Options for {@link refreshLiquidity}. */
export interface RefreshLiquidityOptions {
  /** Read at this block. Default: `safeHead`. */
  block?: bigint
  /** Slots per extsload call (v4 pools). Default 800. */
  batchSize?: number
  /** Calls per Multicall3 `aggregate3` (v3/v2 pools). Default 300. */
  multicallBatchSize?: number
}

const LIQUIDITY_CALL = encodeFunctionData({ abi: v3PoolAbi, functionName: 'liquidity' })
const GET_RESERVES_CALL = encodeFunctionData({ abi: v2PairAbi, functionName: 'getReserves' })

/**
 * Read the liquidity of every pool in the store and store it as a decimal string: v4 pools via
 * `extsload` of the liquidity slot (800 per call, 4 in flight); v3-style pools via `liquidity()`
 * and v2-style pairs via `getReserves()` through Multicall3 `aggregate3` (allowFailure, at most
 * 300 calls each). A v2 pair's liquidity is `isqrt(reserve0 * reserve1)` so `MIN_POOL_LIQUIDITY`
 * and the activity/liquidity ordering apply uniformly. A v3/v2 read that reverts stores `"0"`.
 */
export async function refreshLiquidity(
  clients: RpcClients,
  cfg: Config,
  store: PoolStore,
  opts: RefreshLiquidityOptions = {},
): Promise<void> {
  const addresses = requireAddresses(cfg)
  const all = Object.values(store.pools)
  if (all.length === 0) return
  const block = opts.block ?? (await safeHead(clients.http))
  const limit = limiter(4)
  const v4 = all.filter((p) => poolKind(p) === 0)
  const venue = all.filter((p) => poolKind(p) !== 0)
  let withLiquidity = 0
  let failed = 0

  const readV4 = async (): Promise<void> => {
    if (v4.length === 0) return
    const values = await extsload(
      clients,
      addresses.poolManager,
      v4.map((p) => liquiditySlot(p.poolId)),
      block,
      { limit, ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }) },
    )
    v4.forEach((p, i) => {
      const word = values[i]
      if (word === undefined) throw new Error(`refreshLiquidity: missing value for ${p.poolId}`)
      const liquidity = decodeUint128(word)
      p.liquidity = liquidity.toString()
      if (liquidity > 0n) withLiquidity++
    })
  }
  const readVenues = async (): Promise<void> => {
    if (venue.length === 0) return
    const calls: Call3[] = venue.map((p) => ({ target: poolAddress(p), callData: poolKind(p) === 1 ? LIQUIDITY_CALL : GET_RESERVES_CALL }))
    const results = await aggregate3(clients, calls, block, {
      limit,
      ...(opts.multicallBatchSize === undefined ? {} : { batchSize: opts.multicallBatchSize }),
    })
    venue.forEach((p, i) => {
      const r = results[i]
      let liquidity = 0n
      try {
        if (!r?.success) throw new Error('call failed')
        if (poolKind(p) === 1) liquidity = decodeV3Liquidity(r.returnData)
        else {
          const { reserve0, reserve1 } = decodeV2Reserves(r.returnData)
          liquidity = isqrt(reserve0 * reserve1)
        }
      } catch {
        failed++
      }
      p.liquidity = liquidity.toString()
      if (liquidity > 0n) withLiquidity++
    })
  }
  await Promise.all([readV4(), readVenues()])
  log.info({ block, pools: all.length, v4: v4.length, venue: venue.length, withLiquidity, failed }, 'refreshLiquidity: done')
}

/** Default activity lookback: ~25 minutes of 500 ms blocks. */
export const DEFAULT_LOOKBACK_BLOCKS = 3000

/**
 * Fetch every `Swap` log (v4 PoolManager, v3-style pools and v2-style pairs, matched by topic0
 * without an emitter filter, bisecting on the provider's result cap) over the last
 * `lookbackBlocks` (ending at `safeHead`) and record, for every known pool, the block of its most
 * recent swap and the number of swaps in the window. v4 logs are matched by pool id (topic 1,
 * PoolManager emitter only), v3/v2 logs by emitter address. `swapCount` is reset to 0 for all
 * pools first (it describes this window only); `lastSwapBlock` is only ever moved forward.
 */
export async function refreshActivity(
  clients: RpcClients,
  cfg: Config,
  store: PoolStore,
  lookbackBlocks: number = DEFAULT_LOOKBACK_BLOCKS,
  opts: { toBlock?: bigint } = {},
): Promise<void> {
  const addresses = requireAddresses(cfg)
  const poolManager = addresses.poolManager.toLowerCase() as Address
  if (!Number.isInteger(lookbackBlocks) || lookbackBlocks < 1) throw new Error('refreshActivity: lookbackBlocks must be >= 1')
  const to = opts.toBlock ?? (await safeHead(clients.http))
  const from = to - BigInt(lookbackBlocks) + 1n > 0n ? to - BigInt(lookbackBlocks) + 1n : 0n
  for (const p of Object.values(store.pools)) p.swapCount = 0
  const logs = await getLogsChunked(clients.http, {
    events: [...SWAP, V3_SWAP, V2_SWAP],
    fromBlock: from,
    toBlock: to,
  })
  let matched = 0
  for (const raw of logs) {
    const emitter = raw.address.toLowerCase() as Address
    let pool: StoredPool | undefined
    if (emitter === poolManager) {
      const id = raw.topics[1]?.toLowerCase() as Hex | undefined
      pool = id === undefined ? undefined : store.pools[id]
      if (pool && poolKind(pool) !== 0) pool = undefined
    } else {
      pool = store.pools[addressToPoolId(emitter)]
      if (pool && poolKind(pool) === 0) pool = undefined
    }
    if (!pool) continue
    matched++
    const block = Number(raw.blockNumber)
    pool.swapCount = (pool.swapCount ?? 0) + 1
    if (pool.lastSwapBlock === undefined || block > pool.lastSwapBlock) pool.lastSwapBlock = block
  }
  log.info({ from, to, swaps: logs.length, matched }, 'refreshActivity: done')
}

/** True when the pool's hook is absent or explicitly allowed by config (v3/v2 pools never have hooks). */
export function hooksAllowed(cfg: Pick<Config, 'allowedHooks'>, pool: Pick<PoolInfo, 'hooks'>): boolean {
  return pool.hooks === NATIVE || cfg.allowedHooks.has(pool.hooks)
}

/** True when the pool passes the static filters (hooks allowed, liquidity known and >= minimum). */
export function isEligible(cfg: Pick<Config, 'allowedHooks' | 'MIN_POOL_LIQUIDITY'>, pool: StoredPool): boolean {
  if (!hooksAllowed(cfg, pool)) return false
  if (pool.liquidity === undefined) return false
  return BigInt(pool.liquidity) >= cfg.MIN_POOL_LIQUIDITY
}

/**
 * Ranking used by {@link selectTrackedPools}: most recent swap first (pools that never swapped
 * last), then larger liquidity first, then poolId ascending as a deterministic tie-break.
 */
export function compareStoredPools(a: StoredPool, b: StoredPool): number {
  const swapA = a.lastSwapBlock ?? -1
  const swapB = b.lastSwapBlock ?? -1
  if (swapA !== swapB) return swapB - swapA
  const liqA = BigInt(a.liquidity ?? '0')
  const liqB = BigInt(b.liquidity ?? '0')
  if (liqA !== liqB) return liqA > liqB ? -1 : 1
  return a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0
}

/** Key identifying a token pair regardless of fee / spacing / hooks / kind. */
export function pairKey(pool: Pick<PoolInfo, 'currency0' | 'currency1'>): string {
  return `${pool.currency0}/${pool.currency1}`
}

/** Options for {@link selectTrackedPools}. */
export interface SelectOptions {
  /**
   * When given, eligible pools that cannot lie on any 2- or 3-hop cycle through one of these
   * (lower-cased) currencies are dropped before the cap is applied, so the tracking budget is not
   * spent on pools the strategy can never use (see {@link cycleCapablePools}).
   */
  startCurrencies?: ReadonlySet<Address>
}

/**
 * Choose the pools the bot tracks each block. Every kind is treated alike (v3/v2 pools are
 * hookless, and their `liquidity` is comparable by construction, see {@link refreshLiquidity}):
 *
 * 1. Eligible = hooks allowed (none, or in `cfg.allowedHooks`) AND liquidity known AND
 *    liquidity >= `cfg.MIN_POOL_LIQUIDITY`.
 * 2. With `opts.startCurrencies`, eligible is narrowed to {@link cycleCapablePools}: pools that
 *    can be part of some 2- or 3-hop cycle through a start currency among the eligible pools.
 * 3. Sort eligible by {@link compareStoredPools}: `lastSwapBlock` desc (never-swapped last),
 *    then `liquidity` desc, then `poolId` asc.
 * 4. Primary = the first `cfg.MAX_TRACKED_POOLS` of that order.
 * 5. Pair completion: every *eligible* pool that shares its (currency0, currency1) pair with a
 *    primary pool is added as well (a 2-hop arb needs at least two pools on one pair), so the
 *    result may exceed `MAX_TRACKED_POOLS` by those siblings.
 * 6. The result keeps the order of step 3 (siblings are merged into their sorted position, not
 *    appended), so callers that truncate further keep the most active pools.
 */
export function selectTrackedPools(
  cfg: Pick<Config, 'allowedHooks' | 'MIN_POOL_LIQUIDITY' | 'MAX_TRACKED_POOLS'>,
  store: PoolStore,
  opts: SelectOptions = {},
): PoolInfo[] {
  let eligible = Object.values(store.pools).filter((p) => isEligible(cfg, p))
  if (opts.startCurrencies) {
    const capable = cycleCapablePools(eligible, opts.startCurrencies)
    eligible = eligible.filter((p) => capable.has(p.poolId))
  }
  eligible.sort(compareStoredPools)
  const cap = Math.max(0, cfg.MAX_TRACKED_POOLS)
  const selected = new Set<Hex>()
  const primaryPairs = new Set<string>()
  for (const p of eligible.slice(0, cap)) {
    selected.add(p.poolId)
    primaryPairs.add(pairKey(p))
  }
  for (const p of eligible) if (primaryPairs.has(pairKey(p))) selected.add(p.poolId)
  return eligible.filter((p) => selected.has(p.poolId)).map(toPoolInfo)
}

/**
 * Ids of the pools in `pools` that can lie on at least one closed 2- or 3-hop cycle starting in
 * one of `starts` (the same cycle shapes `strategy/buildCycles` enumerates):
 *
 * - 2-hop: the pool touches a start currency and at least one other pool exists on its pair.
 * - 3-hop: the pool's two currencies have a common neighbour in the token graph that closes a
 *   triangle containing a start currency (either an endpoint of the pool is a start currency, or
 *   the common neighbour is one).
 *
 * This is exact for the cycle shapes above and costs O(pools * min-degree), so it is cheap enough
 * to run on every selection.
 */
export function cycleCapablePools(pools: readonly PoolInfo[], starts: ReadonlySet<Address>): Set<Hex> {
  const pairCount = new Map<string, number>()
  const neighbours = new Map<Address, Set<Address>>()
  for (const p of pools) {
    if (p.currency0 === p.currency1) continue
    pairCount.set(pairKey(p), (pairCount.get(pairKey(p)) ?? 0) + 1)
    addNeighbour(neighbours, p.currency0, p.currency1)
    addNeighbour(neighbours, p.currency1, p.currency0)
  }
  const capable = new Set<Hex>()
  for (const p of pools) {
    if (p.currency0 === p.currency1) continue
    const touchesStart = starts.has(p.currency0) || starts.has(p.currency1)
    if (touchesStart && (pairCount.get(pairKey(p)) ?? 0) >= 2) {
      capable.add(p.poolId)
      continue
    }
    const n0 = neighbours.get(p.currency0) ?? new Set<Address>()
    const n1 = neighbours.get(p.currency1) ?? new Set<Address>()
    if (hasCommonNeighbour(n0, n1, touchesStart ? undefined : starts)) capable.add(p.poolId)
  }
  return capable
}

function addNeighbour(sets: Map<Address, Set<Address>>, from: Address, to: Address): void {
  const set = sets.get(from)
  if (set) set.add(to)
  else sets.set(from, new Set([to]))
}

/** True if `a` and `b` share an element; with `restrictTo`, the shared element must also be in it. */
function hasCommonNeighbour(a: ReadonlySet<Address>, b: ReadonlySet<Address>, restrictTo?: ReadonlySet<Address>): boolean {
  const candidates = restrictTo ?? (a.size <= b.size ? a : b)
  for (const c of candidates) if (a.has(c) && b.has(c)) return true
  return false
}

/** Strip discovery statistics, returning the plain {@link PoolInfo} (kind / pool / venue kept when present). */
export function toPoolInfo(p: StoredPool): PoolInfo {
  return {
    poolId: p.poolId,
    currency0: p.currency0,
    currency1: p.currency1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: p.hooks,
    block: p.block,
    ...(p.kind === undefined ? {} : { kind: p.kind }),
    ...(p.pool === undefined ? {} : { pool: p.pool }),
    ...(p.venue === undefined ? {} : { venue: p.venue }),
  }
}

/** Contract address of a stored v3/v2 pool; throws for a malformed entry. */
function poolAddress(p: StoredPool): Address {
  if (!p.pool) throw new Error(`pool ${p.poolId} (kind ${poolKind(p)}) has no contract address`)
  return p.pool
}

function requireAddresses(cfg: Pick<Config, 'CHAIN_ID'>): (typeof ADDRESSES)[number] {
  const a = ADDRESSES[cfg.CHAIN_ID]
  if (!a) throw new Error(`no ADDRESSES entry for chain ${cfg.CHAIN_ID}`)
  return a
}
