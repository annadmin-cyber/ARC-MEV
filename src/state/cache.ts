import { decodeEventLog, type Hex } from 'viem'
import { poolManagerAbi } from '../abi/index.js'
import { ADDRESSES } from '../chains.js'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { limiter, sleep, withRetry, type Limiter, type RpcClients } from '../rpc/client.js'
import { eventsToTopics, fetchLogsOnce, type RawLog, type TopicFilter } from '../rpc/logs.js'
import type { PoolInfo, PoolState } from '../types.js'
import { fetchPoolStates } from './reader.js'

/** Fee flag marking a dynamic-fee pool (`LPFeeLibrary.DYNAMIC_FEE_FLAG`). */
export const DYNAMIC_FEE_FLAG = 0x800000

/** Signature of {@link fetchPoolStates}, injectable for tests. */
export type StateFetcher = typeof fetchPoolStates

/** Fetch raw PoolManager logs for an inclusive block range (already topic-filtered). Injectable for tests. */
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

const SWAP_AND_MODIFY = poolManagerAbi.filter(
  (item): item is Extract<(typeof poolManagerAbi)[number], { type: 'event' }> =>
    item.type === 'event' && (item.name === 'Swap' || item.name === 'ModifyLiquidity'),
)

/**
 * Keeps the {@link PoolState} of a fixed set of pools current, block by block.
 *
 * `applyBlock(b)` fetches the PoolManager `Swap` and `ModifyLiquidity` logs of block `b` in one
 * `eth_getLogs`, applies swaps in place (price, tick, liquidity and, for dynamic-fee pools, the
 * fee), and refetches from chain every pool that had liquidity modified or whose tick left the
 * cached tick window. Every `fullRefreshBlocks` blocks all pools are refetched to bound drift.
 */
export class StateCache {
  private readonly states = new Map<Hex, PoolState>()
  private readonly infos = new Map<Hex, PoolInfo>()
  private readonly pools: PoolInfo[]
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
    this.fullRefreshBlocks = opts.fullRefreshBlocks ?? 200
    this.blockRetries = opts.blockRetries ?? 10
    this.blockRetryMs = opts.blockRetryMs ?? 50
    this.maxReplayBlocks = opts.maxReplayBlocks ?? 50
    this.fetchStates = opts.fetchStates ?? fetchPoolStates
    this.limit = opts.limit ?? limiter(4)
    this.fetchLogs = opts.fetchLogs ?? ((from, to) => this.fetchPoolManagerLogs(from, to))
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
   * of every pool whose state changed.
   */
  async applyBlock(block: bigint): Promise<{ touched: Set<Hex>; block: bigint }> {
    if (this.currentBlock === undefined || this.lastFullRefresh === undefined) {
      throw new Error('StateCache.applyBlock: call init() first')
    }
    const touched = new Set<Hex>()
    if (block <= this.currentBlock) return { touched, block: this.currentBlock }

    const fromBlock = this.currentBlock + 1n
    const dueForFull = block - this.lastFullRefresh >= BigInt(this.fullRefreshBlocks)
    const gapTooLarge = block - fromBlock + 1n > BigInt(this.maxReplayBlocks)
    const toRefetch = new Set<Hex>()

    if (dueForFull || gapTooLarge) {
      for (const p of this.pools) toRefetch.add(p.poolId)
    } else {
      const logs = await this.fetchLogsWhenReady(fromBlock, block)
      for (const raw of logs) this.applyLog(raw, toRefetch, touched)
    }

    if (toRefetch.size > 0) {
      const pools = [...toRefetch].map((id) => this.infos.get(id)).filter((p): p is PoolInfo => p !== undefined)
      await this.refetch(pools, block)
      for (const id of toRefetch) touched.add(id)
      if (toRefetch.size === this.pools.length) this.lastFullRefresh = block
    }
    this.currentBlock = block
    return { touched, block }
  }

  /** Apply one decoded PoolManager log to the cache. */
  private applyLog(raw: RawLog, toRefetch: Set<Hex>, touched: Set<Hex>): void {
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

  /** One `eth_getLogs` for the PoolManager Swap + ModifyLiquidity events over `[from, to]`. */
  private fetchPoolManagerLogs(from: bigint, to: bigint): Promise<RawLog[]> {
    const addresses = ADDRESSES[this.cfg.CHAIN_ID]
    if (!addresses) throw new Error(`StateCache: no addresses for chain ${this.cfg.CHAIN_ID}`)
    const topics: TopicFilter[] = eventsToTopics(SWAP_AND_MODIFY)
    return withRetry(() => fetchLogsOnce(this.clients.http, addresses.poolManager, topics, from, to), {
      label: `pm logs ${from}-${to}`,
    })
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
