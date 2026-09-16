import { decodeEventLog, type Address, type Hex } from 'viem'
import { poolManagerAbi } from '../abi/index.js'
import { ADDRESSES } from '../chains.js'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { extsload, limiter, type RpcClients } from '../rpc/client.js'
import { getLogsChunked, MAX_LOG_RANGE, safeHead, type RawLog } from '../rpc/logs.js'
import { decodeUint128, liquiditySlot } from '../state/slots.js'
import { NATIVE, type PoolInfo } from '../types.js'
import { savePoolStore, type PoolStore, type StoredPool } from './store.js'

type PoolManagerEvent = Extract<(typeof poolManagerAbi)[number], { type: 'event' }>
const INITIALIZE = poolManagerAbi.filter((i): i is PoolManagerEvent => i.type === 'event' && i.name === 'Initialize')
const SWAP = poolManagerAbi.filter((i): i is PoolManagerEvent => i.type === 'event' && i.name === 'Swap')

/** Options for {@link scanPools}. */
export interface ScanOptions {
  /** Scan up to this block (inclusive). Default: `safeHead`. */
  toBlock?: bigint
  /** Scan from this block (inclusive), overriding the resume point. Mainly for bounded test runs. */
  fromBlock?: bigint
  /** Called after every persisted segment with the last scanned block. */
  onProgress?: (block: number) => void
  /** Log chunks (10k blocks each) per persisted segment. Default 10 (=100k blocks). */
  persistEveryChunks?: number
  /** Parallel `eth_getLogs` requests. Default 3. */
  concurrency?: number
}

/**
 * Scan PoolManager `Initialize` logs from `max(store.lastScannedBlock + 1, deployBlock)` to the
 * safe head, upserting every pool into `store`. Progress is persisted every
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
    return store
  }
  const segment = BigInt(MAX_LOG_RANGE * (opts.persistEveryChunks ?? 10))
  log.info({ from, to, pools: Object.keys(store.pools).length }, 'scanPools: start')
  for (let start = from; start <= to; start += segment) {
    const end = start + segment - 1n < to ? start + segment - 1n : to
    const logs = await getLogsChunked(clients.http, {
      address: addresses.poolManager,
      events: INITIALIZE,
      fromBlock: start,
      toBlock: end,
      concurrency: opts.concurrency ?? 3,
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

/** Options for {@link refreshLiquidity}. */
export interface RefreshLiquidityOptions {
  /** Read at this block. Default: `safeHead`. */
  block?: bigint
  /** Slots per extsload call. Default 800. */
  batchSize?: number
}

/**
 * Read the `liquidity` slot of every pool in the store (in extsload batches, 4 in flight) and
 * store it as a decimal string.
 */
export async function refreshLiquidity(
  clients: RpcClients,
  cfg: Config,
  store: PoolStore,
  opts: RefreshLiquidityOptions = {},
): Promise<void> {
  const addresses = requireAddresses(cfg)
  const pools = Object.values(store.pools)
  if (pools.length === 0) return
  const block = opts.block ?? (await safeHead(clients.http))
  const values = await extsload(
    clients,
    addresses.poolManager,
    pools.map((p) => liquiditySlot(p.poolId)),
    block,
    { limit: limiter(4), ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }) },
  )
  let withLiquidity = 0
  pools.forEach((p, i) => {
    const word = values[i]
    if (word === undefined) throw new Error(`refreshLiquidity: missing value for ${p.poolId}`)
    const liquidity = decodeUint128(word)
    p.liquidity = liquidity.toString()
    if (liquidity > 0n) withLiquidity++
  })
  log.info({ block, pools: pools.length, withLiquidity }, 'refreshLiquidity: done')
}

/** Default activity lookback: ~25 minutes of 500 ms blocks. */
export const DEFAULT_LOOKBACK_BLOCKS = 3000

/**
 * Fetch `Swap` logs over the last `lookbackBlocks` (ending at `safeHead`) and record, for every
 * known pool, the block of its most recent swap and the number of swaps in the window.
 * `swapCount` is reset to 0 for all pools first (it describes this window only);
 * `lastSwapBlock` is only ever moved forward.
 */
export async function refreshActivity(
  clients: RpcClients,
  cfg: Config,
  store: PoolStore,
  lookbackBlocks: number = DEFAULT_LOOKBACK_BLOCKS,
  opts: { toBlock?: bigint } = {},
): Promise<void> {
  const addresses = requireAddresses(cfg)
  if (!Number.isInteger(lookbackBlocks) || lookbackBlocks < 1) throw new Error('refreshActivity: lookbackBlocks must be >= 1')
  const to = opts.toBlock ?? (await safeHead(clients.http))
  const from = to - BigInt(lookbackBlocks) + 1n > 0n ? to - BigInt(lookbackBlocks) + 1n : 0n
  for (const p of Object.values(store.pools)) p.swapCount = 0
  const logs = await getLogsChunked(clients.http, {
    address: addresses.poolManager,
    events: SWAP,
    fromBlock: from,
    toBlock: to,
  })
  let matched = 0
  for (const raw of logs) {
    const id = raw.topics[1]?.toLowerCase() as Hex | undefined
    const pool = id === undefined ? undefined : store.pools[id]
    if (!pool) continue
    matched++
    const block = Number(raw.blockNumber)
    pool.swapCount = (pool.swapCount ?? 0) + 1
    if (pool.lastSwapBlock === undefined || block > pool.lastSwapBlock) pool.lastSwapBlock = block
  }
  log.info({ from, to, swaps: logs.length, matched }, 'refreshActivity: done')
}

/** True when the pool's hook is absent or explicitly allowed by config. */
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

/** Key identifying a token pair regardless of fee / spacing / hooks. */
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
 * Choose the pools the bot tracks each block.
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

/** Strip discovery statistics, returning the plain {@link PoolInfo}. */
export function toPoolInfo(p: StoredPool): PoolInfo {
  return {
    poolId: p.poolId,
    currency0: p.currency0,
    currency1: p.currency1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: p.hooks,
    block: p.block,
  }
}

function requireAddresses(cfg: Pick<Config, 'CHAIN_ID'>): (typeof ADDRESSES)[number] {
  const a = ADDRESSES[cfg.CHAIN_ID]
  if (!a) throw new Error(`no ADDRESSES entry for chain ${cfg.CHAIN_ID}`)
  return a
}
