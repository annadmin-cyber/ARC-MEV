/**
 * Live chain access for the hooked-pool probe (`src/strategy/probe.ts`): batched quoter
 * `eth_call`s, PoolManager `Swap` logs per block, and `slot0` seeds via `extsload`.
 */
import { decodeErrorResult, toHex, type Address, type Hex } from 'viem'
import { poolManagerAbi, v4QuoterAbi } from '../abi/index.js'
import { ADDRESSES } from '../chains.js'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { extsload, isRetryableRpcError, sleep, withRetry, type RpcClients } from '../rpc/client.js'
import { eventsToTopics, fetchLogsOnce, type RawLog } from '../rpc/logs.js'
import { isBlockNotReady } from '../state/cache.js'
import { decodeSlot0, slot0Slot } from '../state/slots.js'
import type { ProbeIo, ProbeSettings, QuoteCall, QuoteCaller, QuoteOutcome, Slot0Snapshot } from '../strategy/probe.js'
import { errorMessage, revertDataOf } from './simulate.js'

const SWAP_EVENTS = poolManagerAbi.filter((i): i is Extract<(typeof poolManagerAbi)[number], { type: 'event' }> => i.type === 'event' && i.name === 'Swap')

/** Attempts while the node answers "block not found" for a block it will serve shortly. */
const BLOCK_NOT_READY_TRIES = 10
const BLOCK_NOT_READY_WAIT_MS = 50

/**
 * Extra rounds for quoter calls the gateway rate-limited (HTTP 429 / -32005 / "Request exceeds
 * defined limit."), and the wait before each round. Only the rejected calls are re-issued. Without
 * this a rate-limited quote scores as a lost sample and the probe under-reports the cycle.
 */
export const RATE_LIMIT_RETRY_WAITS_MS: readonly number[] = [150, 300, 600]

/**
 * Largest JSON-RPC batch the official Arc gateway accepts: requests beyond the 20th in one HTTP
 * body fail with "Request exceeds defined limit." (measured 2026-09-16). Quoter calls are issued
 * in chunks of this size, one HTTP batch per chunk, all chunks in flight together.
 */
export const MAX_RPC_BATCH = 20

/** Probe settings from config and the chain's V4Quoter / PoolManager addresses. */
export function probeSettingsFor(cfg: Pick<Config, 'CHAIN_ID' | 'PROBE_MAX_PER_BLOCK' | 'PROBE_MIN_SPREAD_BPS' | 'PROBE_GRID'>): ProbeSettings {
  const addresses = ADDRESSES[cfg.CHAIN_ID]
  const quoter = addresses?.v4Quoter
  if (!addresses || !quoter) throw new Error(`probe: no V4Quoter address for chain ${cfg.CHAIN_ID}`)
  return {
    quoter,
    maxPerBlock: cfg.PROBE_MAX_PER_BLOCK,
    minSpreadBps: cfg.PROBE_MIN_SPREAD_BPS,
    grid: cfg.PROBE_GRID,
    poolManager: addresses.poolManager.toLowerCase() as Address,
  }
}

/**
 * A {@link QuoteCaller} over `clients.http`: the calls of one chunk (at most `batchSize`,
 * default {@link MAX_RPC_BATCH}) are issued in the same tick so viem's JSON-RPC batching sends
 * them as one HTTP request; successive chunks are issued one timer tick apart so they form
 * separate HTTP batches, all in flight concurrently. Reverts are reported per call (decoded
 * against the quoter ABI when possible). When every call failed because the node has not served
 * `block` yet, the whole batch is retried a few times; calls the gateway rate-limited are
 * re-issued (only those) after each of {@link RATE_LIMIT_RETRY_WAITS_MS}.
 */
export function quoteCallerFor(clients: Pick<RpcClients, 'http'>, batchSize: number = MAX_RPC_BATCH): QuoteCaller {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError(`quoteCallerFor: batchSize must be >= 1, got ${batchSize}`)
  type Attempt = QuoteOutcome & { notReady?: boolean; rateLimited?: boolean }
  return async (calls: readonly QuoteCall[], block: bigint): Promise<QuoteOutcome[]> => {
    if (calls.length === 0) return []
    const tag = toHex(block)
    const issue = (call: QuoteCall): Promise<Attempt> =>
      clients.http.request({ method: 'eth_call', params: [{ to: call.to, data: call.data }, tag] }).then(
        (data): Attempt => ({ ok: true, data: data as Hex }),
        (error: unknown): Attempt => ({
          ok: false,
          reason: describeQuoteError(error),
          notReady: isBlockNotReady(error),
          rateLimited: !isBlockNotReady(error) && isRetryableRpcError(error),
        }),
      )
    /** Issue `subset` (indices into `calls`) in HTTP batches of `batchSize`, one batch per tick. */
    const run = async (subset: readonly number[]): Promise<Attempt[]> => {
      const pending: Array<Promise<Attempt>> = []
      for (let i = 0; i < subset.length; i += batchSize) {
        if (i > 0) await sleep(0)
        pending.push(...subset.slice(i, i + batchSize).map((idx) => issue(calls[idx] as QuoteCall)))
      }
      return Promise.all(pending)
    }
    const all = calls.map((_, i) => i)
    let outcomes = await run(all)
    for (let attempt = 1; attempt < BLOCK_NOT_READY_TRIES && outcomes.every((o) => !o.ok && o.notReady); attempt++) {
      await sleep(BLOCK_NOT_READY_WAIT_MS)
      outcomes = await run(all)
    }
    for (const wait of RATE_LIMIT_RETRY_WAITS_MS) {
      const limited = all.filter((i) => outcomes[i]?.rateLimited)
      if (limited.length === 0) break
      log.debug({ block, rateLimited: limited.length, of: calls.length, waitMs: wait }, 'probe: re-issuing rate-limited quoter calls')
      await sleep(wait)
      const again = await run(limited)
      limited.forEach((idx, i) => {
        outcomes[idx] = again[i] as Attempt
      })
    }
    return outcomes.map((o) => (o.ok ? o : { ok: false, reason: o.reason }))
  }
}

/** Quoter revert as text: `NotEnoughLiquidity(0x…)`, `UnexpectedRevertBytes(0x…)`, a raw selector, or the RPC message. */
export function describeQuoteError(error: unknown): string {
  const data = revertDataOf(error)
  if (data === undefined) return errorMessage(error)
  try {
    const decoded = decodeErrorResult({ abi: v4QuoterAbi, data })
    const args = (decoded.args ?? []).map((a) => (typeof a === 'bigint' ? a.toString() : String(a)))
    return `${decoded.errorName}(${args.join(', ')})`
  } catch {
    return data.length >= 10 ? `revert ${data.slice(0, 10)} (${data.length / 2 - 1} bytes)` : `revert ${data}`
  }
}

/** The live {@link ProbeIo} for `clients` on the configured chain. */
export function probeIoFor(clients: RpcClients, cfg: Pick<Config, 'CHAIN_ID'>): ProbeIo {
  const addresses = ADDRESSES[cfg.CHAIN_ID]
  if (!addresses) throw new Error(`probe: no addresses for chain ${cfg.CHAIN_ID}`)
  const poolManager: Address = addresses.poolManager
  const topics = eventsToTopics(SWAP_EVENTS)
  return {
    call: quoteCallerFor(clients),
    async fetchSwapLogs(fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
      for (let attempt = 1; ; attempt++) {
        try {
          return await withRetry(() => fetchLogsOnce(clients.http, poolManager, topics, fromBlock, toBlock), { label: `probe swap logs ${fromBlock}-${toBlock}` })
        } catch (error) {
          if (attempt >= BLOCK_NOT_READY_TRIES || !isBlockNotReady(error)) throw error
          log.debug({ attempt, fromBlock, toBlock }, 'probe: block not yet available for eth_getLogs, retrying')
          await sleep(BLOCK_NOT_READY_WAIT_MS)
        }
      }
    },
    async readSlot0s(poolIds: readonly Hex[], block: bigint): Promise<Map<Hex, Slot0Snapshot>> {
      const out = new Map<Hex, Slot0Snapshot>()
      if (poolIds.length === 0) return out
      const words = await extsload(clients, poolManager, poolIds.map((id) => slot0Slot(id)), block)
      poolIds.forEach((id, i) => {
        const word = words[i]
        if (word === undefined) return
        const slot0 = decodeSlot0(word)
        out.set(id, { sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, lpFee: slot0.lpFee })
      })
      return out
    },
  }
}
