import { decodeEventLog, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem'
import { poolManagerAbi, v2PairAbi, v3PoolAbi } from '../abi/index.js'
import { ADDRESSES } from '../chains.js'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { limiter, sleep, type Limiter, type RetryOptions, type RpcClients } from '../rpc/client.js'
import { eventsToTopics, fetchLogsOnce, type RawLog, type TopicFilter } from '../rpc/logs.js'
import { addressToPoolId, poolKind, type PoolInfo, type PoolState } from '../types.js'
import { fetchPoolStates } from './reader.js'
import { applyV2Reserves } from './v2.js'

/** Fee flag marking a dynamic-fee pool (`LPFeeLibrary.DYNAMIC_FEE_FLAG`). */
export const DYNAMIC_FEE_FLAG = 0x800000

/** Signature of {@link fetchPoolStates}, injectable for tests. */
export type StateFetcher = typeof fetchPoolStates

/**
 * Retry policy of the per-block log fetch. The public gateway answers with a rate-limit error
 * ("Request exceeds defined limit." / 429 / -32005) for a fraction of a second at a time, so short
 * waits win; the default policy (300 ms doubling to 10 s) stalled the block loop for 10+ s.
 * Worst case here is ~2.6 s over 8 attempts, after which the block fails and the next head
 * replays the gap.
 */
export const BLOCK_LOG_RETRY: RetryOptions = { tries: 8, baseMs: 100, factor: 1.6, maxMs: 800 }

/** Result of {@link StateCache.applyBlock}. */
export interface AppliedBlock {
  /** Ids of every pool whose state changed. */
  touched: Set<Hex>
  /** Block the cache now corresponds to. */
  block: bigint
  /**
   * The raw logs the cache fetched and replayed to reach `block` (every {@link TRACKED_TOPICS}
   * event of every contract over `(previous block, block]`), so other consumers of the same block
   * (the hooked-pool probe) need not fetch them again. Absent when the cache refetched every pool
   * instead of replaying logs (periodic full refresh, or a gap larger than `maxReplayBlocks`).
   */
  replayed?: { fromBlock: bigint; logs: RawLog[] }
}

/** Fetch raw logs for an inclusive block range (already topic-filtered). Injectable for tests. */
export type BlockLogFetcher = (fromBlock: bigint, toBlock: bigint) => Promise<RawLog[]>

/** Tunables for {@link StateCache}. */
export interface StateCacheOptions {
  /** Refetch every pool from chain this often (in blocks). Default 200. */
  fullRefreshBlocks?: number
  /** Attempts when the RPC says a block is not yet available. Default 10. */
  blockRetries?: number
  /** Pause between those attempts in ms. Default 50. */
  blockRetryMs?: number
  /** If `applyBlock` is asked to jump more than this many blocks, refetch everything instead of replaying logs. Default 50. */
  maxReplayBlocks?: number
  /** Override the state fetcher (tests). */
  fetchStates?: StateFetcher
  /** Override the log fetcher (tests). */
  fetchLogs?: BlockLogFetcher
  /** Concurrency limiter shared with other RPC users. */
  limit?: Limiter
}

/** RPC errors that mean "ask again in a moment": the block is not yet served by this node. */
const BLOCK_NOT_READY = /not (yet )?available|block not found|beyond current head|unknown block|cannot query unfinalized|future block|not found/i

type EventOf<T extends readonly unknown[]> = Extract<T[number], { type: 'event' }>
function eventsNamed<T extends readonly unknown[]>(abi: T, names: readonly string[]): EventOf<T>[] {
  return abi.filter((item): item is EventOf<T> => {
    const i = item as { type?: string; name?: string }
    return i.type === 'event' && i.name !== undefined && names.includes(i.name)
  })
}

const SWAP_AND_MODIFY = eventsNamed(poolManagerAbi, ['Swap', 'ModifyLiquidity'])
const V3_EVENTS = eventsNamed(v3PoolAbi, ['Swap', 'Mint', 'Burn'])
const V2_EVENTS = eventsNamed(v2PairAbi, ['Sync'])

/** Topic0 of every event the cache reacts to, by kind. */
export const V4_SWAP_TOPIC = toEventSelector(eventsNamed(poolManagerAbi, ['Swap'])[0] as AbiEvent)
export const V3_SWAP_TOPIC = toEventSelector(eventsNamed(v3PoolAbi, ['Swap'])[0] as AbiEvent)
export const V2_SYNC_TOPIC = toEventSelector(V2_EVENTS[0] as AbiEvent)

/**
 * The positional topic filter for one `eth_getLogs` per block: any of v4 `Swap` / `ModifyLiquidity`,
 * v3 `Swap` / `Mint` / `Burn`, v2 `Sync` on topic0, no emitter filter (logs are routed by emitter).
 */
export const TRACKED_TOPICS: TopicFilter[] = eventsToTopics([...SWAP_AND_MODIFY, ...V3_EVENTS, ...V2_EVENTS])

/**
 * Keeps the {@link PoolState} of a fixed set of pools current, block by block.
 *
 * `applyBlock(b)` fetches the logs of block `b` in one `eth_getLogs` (no address filter, any of
 * the {@link TRACKED_TOPICS} on topic0) and routes each log by emitter:
 * - PoolManager `Swap` -> price, tick, liquidity (and the fee of dynamic-fee pools) in place;
 *   `ModifyLiquidity` -> refetch that pool.
 * - v3-style pool `Swap` -> price, tick, liquidity in place; `Mint` / `Burn` -> refetch that pool.
 * - v2-style pair `Sync` -> reserves in place (price, tick, liquidity re-derived).
 * A pool whose tick left the cached tick window is refetched as well, and every
 * `fullRefreshBlocks` blocks all pools are refetched to bound drift.
 */
export class StateCache {
  private readonly states = new Map<Hex, PoolState>()
  private readonly infos = new Map<Hex, PoolInfo>()
  private readonly pools: PoolInfo[]
  private readonly poolManager: Address | undefined
  private readonly fullRefreshBlocks: number
  private readonly blockRetries: number
  private readonly blockRetryMs: number
  private readonly maxReplayBlocks: number
  private readonly fetchStates: StateFetcher
  private readonly fetchLogs: BlockLogFetcher
  private readonly limit: Limiter
  private currentBlock: bigint | undefined
  private lastFullRefresh: bigint | undefined

  constructor(
    private readonly clients: RpcClients,
    private readonly cfg: Config,
    pools: readonly PoolInfo[],
    opts: StateCacheOptions = {},
  ) {
    this.pools = [...pools]
    for (const p of this.pools) this.infos.set(p.poolId, p)
    this.poolManager = ADDRESSES[cfg.CHAIN_ID]?.poolManager.toLowerCase() as Address | undefined
    this.fullRefreshBlocks = opts.fullRefreshBlocks ?? 200
    this.blockRetries = opts.blockRetries ?? 10
    this.blockRetryMs = opts.blockRetryMs ?? 50
    this.maxReplayBlocks = opts.maxReplayBlocks ?? 50
    this.fetchStates = opts.fetchStates ?? fetchPoolStates
    this.limit = opts.limit ?? limiter(4)
    this.fetchLogs = opts.fetchLogs ?? ((from, to) => this.fetchTrackedLogs(from, to))
  }

  /** Load every pool's state at `block`. */
  async init(block: bigint): Promise<void> {
    await this.refetch(this.pools, block)
    this.currentBlock = block
    this.lastFullRefresh = block
  }

  /** Block the cached states correspond to (undefined before `init`). */
  get block(): bigint | undefined {
    return this.currentBlock
  }

  get(poolId: Hex): PoolState | undefined {
    return this.states.get(poolId)
  }

  all(): Map<Hex, PoolState> {
    return this.states
  }

  /** Pool metadata for a tracked pool. */
  info(poolId: Hex): PoolInfo | undefined {
    return this.infos.get(poolId)
  }

  /**
   * Advance the cache to `block`. Blocks between the current one and `block` are replayed from
   * logs (a full refetch is used instead when the gap exceeds `maxReplayBlocks`). Returns the ids
   * of every pool whose state changed and, when logs were replayed, the logs themselves.
   */
  async applyBlock(block: bigint): Promise<AppliedBlock> {
    if (this.currentBlock === undefined || this.lastFullRefresh === undefined) {
      throw new Error('StateCache.applyBlock: call init() first')
    }
    const touched = new Set<Hex>()
    if (block <= this.currentBlock) return { touched, block: this.currentBlock }

    const fromBlock = this.currentBlock + 1n
    const dueForFull = block - this.lastFullRefresh >= BigInt(this.fullRefreshBlocks)
    const gapTooLarge = block - fromBlock + 1n > BigInt(this.maxReplayBlocks)
    const toRefetch = new Set<Hex>()
    let replayed: AppliedBlock['replayed']

    if (dueForFull || gapTooLarge) {
      for (const p of this.pools) toRefetch.add(p.poolId)
    } else {
      const logs = await this.fetchLogsWhenReady(fromBlock, block)
      for (const raw of logs) this.applyLog(raw, toRefetch, touched)
      replayed = { fromBlock, logs }
    }

    if (toRefetch.size > 0) {
      const pools = [...toRefetch].map((id) => this.infos.get(id)).filter((p): p is PoolInfo => p !== undefined)
      await this.refetch(pools, block)
      for (const id of toRefetch) touched.add(id)
      if (toRefetch.size === this.pools.length) this.lastFullRefresh = block
    }
    this.currentBlock = block
    return replayed ? { touched, block, replayed } : { touched, block }
  }

  /** Route one raw log by emitter to the tracked pool it concerns and apply it. */
  private applyLog(raw: RawLog, toRefetch: Set<Hex>, touched: Set<Hex>): void {
    const emitter = raw.address.toLowerCase() as Address
    if (emitter === this.poolManager) {
      this.applyV4Log(raw, toRefetch, touched)
      return
    }
    const poolId = addressToPoolId(emitter)
    const info = this.infos.get(poolId)
    if (!info || poolKind(info) === 0) return
    const state = this.states.get(poolId)
    if (!state) {
      toRefetch.add(poolId)
      return
    }
    const topic0 = raw.topics[0]?.toLowerCase()
    if (poolKind(info) === 1) {
      if (topic0 !== V3_SWAP_TOPIC) {
        // Mint / Burn (or anything else that passed the filter): tick data changed, reload from chain.
        toRefetch.add(poolId)
        return
      }
      this.applyV3Swap(raw, info, state, toRefetch, touched)
      return
    }
    if (topic0 === V2_SYNC_TOPIC) this.applyV2Sync(raw, state, toRefetch, touched)
  }

  /** Apply one decoded PoolManager log to the cache. */
  private applyV4Log(raw: RawLog, toRefetch: Set<Hex>, touched: Set<Hex>): void {
    const poolId = raw.topics[1]?.toLowerCase() as Hex | undefined
    if (poolId === undefined || !this.infos.has(poolId)) return
    const decoded = decodeEventLog({ abi: poolManagerAbi, data: raw.data, topics: raw.topics })
    if (decoded.eventName !== 'Swap') {
      // ModifyLiquidity (or anything unexpected that passed the topic filter): reload from chain.
      toRefetch.add(poolId)
      return
    }
    const state = this.states.get(poolId)
    const info = this.infos.get(poolId)
    if (!state || !info) {
      toRefetch.add(poolId)
      return
    }
    const { sqrtPriceX96, liquidity, tick, fee } = decoded.args
    state.sqrtPriceX96 = sqrtPriceX96
    state.liquidity = liquidity
    state.tick = tick
    if ((info.fee & DYNAMIC_FEE_FLAG) !== 0) state.lpFee = fee
    state.block = Number(raw.blockNumber)
    touched.add(poolId)
    if (tick < state.tickWindow.lower || tick > state.tickWindow.upper) toRefetch.add(poolId)
  }

  /** v3 `Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)`: update in place. */
  private applyV3Swap(raw: RawLog, info: PoolInfo, state: PoolState, toRefetch: Set<Hex>, touched: Set<Hex>): void {
    let args: { sqrtPriceX96: bigint; liquidity: bigint; tick: number }
    try {
      const decoded = decodeEventLog({ abi: v3PoolAbi, eventName: 'Swap', data: raw.data, topics: raw.topics })
      args = decoded.args
    } catch (error) {
      log.debug({ err: error, pool: info.pool, block: raw.blockNumber }, 'undecodable v3 Swap log, refetching pool')
      toRefetch.add(info.poolId)
      return
    }
    state.sqrtPriceX96 = args.sqrtPriceX96
    state.liquidity = args.liquidity
    state.tick = args.tick
    state.block = Number(raw.blockNumber)
    touched.add(info.poolId)
    if (args.tick < state.tickWindow.lower || args.tick > state.tickWindow.upper) toRefetch.add(info.poolId)
  }

  /** v2 `Sync(reserve0, reserve1)`: replace the reserves and re-derive price, tick and liquidity. */
  private applyV2Sync(raw: RawLog, state: PoolState, toRefetch: Set<Hex>, touched: Set<Hex>): void {
    try {
      const { args } = decodeEventLog({ abi: v2PairAbi, eventName: 'Sync', data: raw.data, topics: raw.topics })
      applyV2Reserves(state, { reserve0: args.reserve0, reserve1: args.reserve1 }, Number(raw.blockNumber))
      touched.add(state.poolId)
    } catch (error) {
      log.debug({ err: error, poolId: state.poolId, block: raw.blockNumber }, 'undecodable v2 Sync log, refetching pair')
      toRefetch.add(state.poolId)
    }
  }

  /** Refetch `pools` at `block`, using the currently cached ticks as bitmap-window hints. */
  private async refetch(pools: readonly PoolInfo[], block: bigint): Promise<void> {
    if (pools.length === 0) return
    const tickHints = new Map<Hex, number>()
    for (const p of pools) {
      const s = this.states.get(p.poolId)
      if (s) tickHints.set(p.poolId, s.tick)
    }
    const fresh = await this.fetchStates(this.clients, this.cfg, pools, block, { tickHints, limit: this.limit })
    for (const [id, state] of fresh) this.states.set(id, state)
  }

  /** Raw logs for `[from, to]`, retrying briefly while the node has not indexed the block yet. */
  private async fetchLogsWhenReady(from: bigint, to: bigint): Promise<RawLog[]> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.blockRetries; attempt++) {
      try {
        return await this.fetchLogs(from, to)
      } catch (error) {
        if (!isBlockNotReady(error)) throw error
        lastError = error
        log.debug({ attempt, from, to }, 'block not yet available for eth_getLogs, retrying')
        await sleep(this.blockRetryMs)
      }
    }
    throw new Error(`StateCache: block ${to} not available after ${this.blockRetries} attempts`, { cause: lastError })
  }

  /**
   * One `eth_getLogs` over `[from, to]` for every tracked event kind, without an emitter filter,
   * retried with the short {@link BLOCK_LOG_RETRY} policy (a "block not found" answer is not
   * retried here; `fetchLogsWhenReady` handles it).
   */
  private fetchTrackedLogs(from: bigint, to: bigint): Promise<RawLog[]> {
    if (!this.poolManager) throw new Error(`StateCache: no addresses for chain ${this.cfg.CHAIN_ID}`)
    return fetchLogsOnce(this.clients.http, undefined, TRACKED_TOPICS, from, to, BLOCK_LOG_RETRY)
  }
}

/** True when the error says the requested block is not served yet. */
export function isBlockNotReady(error: unknown): boolean {
  let e: unknown = error
  const seen = new Set<unknown>()
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e)
    const code = (e as { code?: unknown }).code
    if (code === -32014 || code === -32001) return true
    const message = (e as { message?: unknown }).message
    if (typeof message === 'string' && BLOCK_NOT_READY.test(message)) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}
