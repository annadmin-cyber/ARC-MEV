/**
 * Live chain access for the hooked-pool probe (`src/strategy/probe.ts`): quoter `eth_call`s
 * (packed into one `Multicall3.aggregate3` call per round, or one JSON-RPC batch per chunk),
 * PoolManager `Swap` logs per block, and `slot0` seeds via `extsload`.
 */
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, toHex, type Address, type Hex } from 'viem'
import { multicall3Abi, poolManagerAbi, v4QuoterAbi } from '../abi/index.js'
import { ADDRESSES } from '../chains.js'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { extsload, isRetryableRpcError, sleep, type RpcClients } from '../rpc/client.js'
import { eventsToTopics, fetchLogsOnce, type RawLog } from '../rpc/logs.js'
import { MULTICALL3_ADDRESS, multicallAddress } from '../rpc/multicall.js'
import { BLOCK_LOG_RETRY, isBlockNotReady } from '../state/cache.js'
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

/**
 * Quoter calls packed into one `Multicall3.aggregate3` `eth_call` (`PROBE_QUOTE_MODE=multicall`).
 * Every quote is a full v4 swap simulation (~100-300k gas), so 150 of them stay under the
 * 50M-gas `eth_call` cap common to providers; a probe round beyond that is split into several
 * aggregate3 calls (in practice a round is `PROBE_MAX_PER_BLOCK x PROBE_GRID`, i.e. 20 by default).
 */
export const MAX_MULTICALL_QUOTES = 150

/**
 * The node refused an `eth_call` because it needs more gas than the node's cap allows (geth:
 * "gas required exceeds allowance", the Arc gateway: "out of gas: gas required exceeds: 30000000").
 * A revert never matches: the messages describe the call as a whole, not its return data.
 */
export function isOutOfGas(error: unknown): boolean {
  const texts = [errorMessage(error)]
  for (let e: unknown = error, depth = 0; e !== null && typeof e === 'object' && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    for (const key of ['message', 'details'] as const) {
      const text = (e as Record<string, unknown>)[key]
      if (typeof text === 'string') texts.push(text)
    }
  }
  return texts.some((text) => OUT_OF_GAS.test(text))
}
const OUT_OF_GAS = /out of gas|gas required exceeds|exceeds (the )?(block )?gas (limit|cap|allowance)/i

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

/** Options for {@link multicallQuoteCallerFor}. */
export interface MulticallQuoteOptions {
  /** Quotes per `aggregate3` call. Default {@link MAX_MULTICALL_QUOTES}. */
  chunkSize?: number
  /** Multicall3 address. Default: the chain definition's `contracts.multicall3`, else the canonical one. */
  multicall?: Address
}

/**
 * A {@link QuoteCaller} that packs every quote of a round into one `Multicall3.aggregate3`
 * `eth_call` at the explicit block number (several when a round exceeds `chunkSize`, all in
 * flight together), so a round costs one request whatever the grid. Providers rate-limit each
 * entry of a JSON-RPC batch (and cap batch sizes at 3-100), while one aggregate3 call works
 * everywhere. `V4Quoter`'s quote functions are non-view but run fine inside aggregate3 with
 * `allowFailure=true`: a successful quote returns `(amountOut, gasEstimate)`, a real failure
 * (`NotEnoughLiquidity`, a hook revert as `UnexpectedRevertBytes`) comes back as
 * `success=false` with the revert bytes in `returnData`, decoded per call by
 * {@link describeQuoteError} exactly as in batch mode so the probe's retry-with-smaller-size
 * logic behaves the same. A chunk the node has not served `block` for yet is retried a few times;
 * a rate-limited chunk is re-issued after each of {@link RATE_LIMIT_RETRY_WAITS_MS}; a chunk the
 * node refuses for exceeding its `eth_call` gas cap (a hook that burns millions of gas before
 * reverting makes a quote cost ~4M instead of ~100k) is bisected and both halves re-issued, down
 * to single quotes. Inside a chunk that did fit, Multicall3 hands each sub-call 63/64 of what is
 * left, so a late quote can be starved and fail with empty revert data (the quoter catching its
 * own out-of-gas inner call) although it would succeed alone; such failures are re-issued as
 * single-quote aggregate3 calls before they count. Any other transport failure marks that
 * chunk's quotes as failed (the caller never throws).
 */
export function multicallQuoteCallerFor(clients: Pick<RpcClients, 'http'> & Partial<Pick<RpcClients, 'httpSingle' | 'chain'>>, opts: MulticallQuoteOptions = {}): QuoteCaller {
  const chunkSize = opts.chunkSize ?? MAX_MULTICALL_QUOTES
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError(`multicallQuoteCallerFor: chunkSize must be >= 1, got ${chunkSize}`)
  const to = (opts.multicall ?? (clients.chain ? multicallAddress({ chain: clients.chain }) : MULTICALL3_ADDRESS)).toLowerCase() as Address
  const client = clients.httpSingle ?? clients.http
  type ChunkFailure = { reason: string; notReady: boolean; rateLimited: boolean; outOfGas: boolean }
  /** One probe round: its block tag and the aggregate3 requests issued so far (retries and bisected halves included). */
  type Round = { block: bigint; tag: Hex; requests: number }
  /** One aggregate3 request for `chunk`; resolves to the per-quote outcomes or to why the request failed. */
  const issue = async (chunk: readonly QuoteCall[], round: Round): Promise<QuoteOutcome[] | ChunkFailure> => {
    round.requests++
    const data = encodeFunctionData({
      abi: multicall3Abi,
      functionName: 'aggregate3',
      args: [chunk.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))],
    })
    let returned: Hex
    try {
      returned = (await client.request({ method: 'eth_call', params: [{ to, data }, round.tag] })) as Hex
    } catch (error) {
      const notReady = isBlockNotReady(error)
      const outOfGas = !notReady && isOutOfGas(error)
      return { reason: errorMessage(error), notReady, rateLimited: !notReady && !outOfGas && isRetryableRpcError(error), outOfGas }
    }
    let results: readonly { success: boolean; returnData: Hex }[]
    try {
      results = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: returned })
    } catch (error) {
      return { reason: `aggregate3: undecodable response (${errorMessage(error)}; no code at ${to}?)`, notReady: false, rateLimited: false, outOfGas: false }
    }
    if (results.length !== chunk.length) {
      return { reason: `aggregate3: expected ${chunk.length} results, got ${results.length}`, notReady: false, rateLimited: false, outOfGas: false }
    }
    return results.map((r) => decodeAggregatedQuote(r.success, r.returnData))
  }
  const runChunk = async (chunk: readonly QuoteCall[], round: Round): Promise<QuoteOutcome[]> => {
    const { block } = round
    let result = await issue(chunk, round)
    for (let attempt = 1; attempt < BLOCK_NOT_READY_TRIES && !Array.isArray(result) && result.notReady; attempt++) {
      await sleep(BLOCK_NOT_READY_WAIT_MS)
      result = await issue(chunk, round)
    }
    for (const wait of RATE_LIMIT_RETRY_WAITS_MS) {
      if (Array.isArray(result) || !result.rateLimited) break
      log.debug({ block, quotes: chunk.length, waitMs: wait }, 'probe: re-issuing rate-limited aggregate3 quoter call')
      await sleep(wait)
      result = await issue(chunk, round)
    }
    if (Array.isArray(result)) {
      const starved = result.flatMap((o, i) => (chunk.length > 1 && !o.ok && STARVED_REASONS.has(o.reason) ? [i] : []))
      if (starved.length > 0) {
        log.debug({ block, quotes: chunk.length, starved: starved.length }, 'probe: re-issuing quotes that may have been starved of gas inside aggregate3')
        const again = await Promise.all(starved.map((i) => runChunk([chunk[i] as QuoteCall], round)))
        starved.forEach((i, k) => {
          result[i] = again[k]?.[0] ?? { ok: false, reason: 'unanswered' }
        })
      }
      return result
    }
    if (result.outOfGas && chunk.length > 1) {
      const half = Math.ceil(chunk.length / 2)
      log.debug({ block, quotes: chunk.length, halves: [half, chunk.length - half] }, 'probe: aggregate3 quoter call exceeds the eth_call gas cap, bisecting')
      const halves = await Promise.all([runChunk(chunk.slice(0, half), round), runChunk(chunk.slice(half), round)])
      return halves.flat()
    }
    const reason = result.reason
    return chunk.map(() => ({ ok: false, reason }))
  }
  return async (calls: readonly QuoteCall[], block: bigint): Promise<QuoteOutcome[]> => {
    if (calls.length === 0) return []
    const round: Round = { block, tag: toHex(block), requests: 0 }
    const chunks: QuoteCall[][] = []
    for (let i = 0; i < calls.length; i += chunkSize) chunks.push(calls.slice(i, i + chunkSize))
    const started = Date.now()
    const outcomes = (await Promise.all(chunks.map((chunk) => runChunk(chunk, round)))).flat()
    log.debug({ block, quotes: calls.length, aggregate3Calls: round.requests, ok: outcomes.filter((o) => o.ok).length, ms: Date.now() - started }, 'probe: quoted through aggregate3')
    return outcomes
  }
}

/**
 * Failure texts a sub-call starved of gas inside aggregate3 produces: the quoter caught an
 * out-of-gas inner call (empty revert data), or the quoter itself ran dry. Real quoter failures
 * carry `NotEnoughLiquidity` / `UnexpectedRevertBytes(<hook data>)` and are never re-issued.
 */
const STARVED_REASONS: ReadonlySet<string> = new Set(['UnexpectedRevertBytes(0x)', 'revert (no data)'])

/**
 * One aggregate3 `Result` as a {@link QuoteOutcome}: a success must decode as the quoter's
 * `(amountOut, gasEstimate)` (an empty answer means the quoter has no code at that address); a
 * failure carries the quoter's revert bytes, described like a reverted `eth_call`.
 */
export function decodeAggregatedQuote(success: boolean, returnData: Hex): QuoteOutcome {
  if (!success) {
    return { ok: false, reason: returnData.length > 2 ? describeQuoteError({ data: returnData }) : 'revert (no data)' }
  }
  try {
    decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInput', data: returnData })
  } catch (error) {
    return { ok: false, reason: `undecodable quote ${returnData.length > 66 ? `${returnData.slice(0, 66)}…` : returnData}: ${errorMessage(error)}` }
  }
  return { ok: true, data: returnData }
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

/**
 * The live {@link ProbeIo} for `clients` on the configured chain. Quotes go through
 * {@link multicallQuoteCallerFor} unless `PROBE_QUOTE_MODE=batch` selects {@link quoteCallerFor}.
 */
export function probeIoFor(clients: RpcClients, cfg: Pick<Config, 'CHAIN_ID'> & Partial<Pick<Config, 'PROBE_QUOTE_MODE'>>): ProbeIo {
  const addresses = ADDRESSES[cfg.CHAIN_ID]
  if (!addresses) throw new Error(`probe: no addresses for chain ${cfg.CHAIN_ID}`)
  const poolManager: Address = addresses.poolManager
  const topics = eventsToTopics(SWAP_EVENTS)
  const mode = cfg.PROBE_QUOTE_MODE ?? 'multicall'
  return {
    call: mode === 'batch' ? quoteCallerFor(clients) : multicallQuoteCallerFor(clients),
    /** Per-block path: `fetchLogsOnce` retries itself with the short {@link BLOCK_LOG_RETRY} policy (never nested in another retry). */
    async fetchSwapLogs(fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
      for (let attempt = 1; ; attempt++) {
        try {
          return await fetchLogsOnce(clients.http, poolManager, topics, fromBlock, toBlock, { ...BLOCK_LOG_RETRY, label: `probe swap logs ${fromBlock}-${toBlock}` })
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
