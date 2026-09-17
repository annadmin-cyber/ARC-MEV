import { ResponseBodyTooLargeError, formatLog, toEventSelector, toHex, type AbiEvent, type Address, type Hex, type Log, type PublicClient, type RpcLog } from 'viem'
import { limiter, withRetry, type Limiter, type RetryOptions } from './client.js'

/** Hard cap the public Arc RPC enforces on one `eth_getLogs` block range. */
export const MAX_LOG_RANGE = 10_000

/**
 * The public Arc RPC also caps one `eth_getLogs` response at 20,000 logs and answers
 * `-32602 "query exceeds max results 20000, retry with the range a-b"` above that. Dense event
 * streams (Swap) hit this well below the block-range cap, so ranges are bisected on this error.
 */
const RESULT_CAP_MESSAGE = /max results|too many results|exceeds max|query returned more than|range too large|response size|-32012/i

/** Topic filter entry as accepted by `eth_getLogs`: a single topic, any-of list, or wildcard. */
export type TopicFilter = Hex | Hex[] | null

/** Emitter filter for `eth_getLogs`: one address, several (any of), or none (every contract). */
export type AddressFilter = Address | readonly Address[] | undefined

/** Parameters for {@link getLogsChunked}. */
export interface GetLogsChunkedParams {
  /** Emitter(s) to match. Omit to match every contract (route by `log.address` afterwards). */
  address?: AddressFilter
  /** Events to match on topic0 (any of). Ignored when `topics` is given. */
  events?: readonly AbiEvent[]
  /** Raw topic filter (positional). Takes precedence over `events`. */
  topics?: TopicFilter[]
  fromBlock: bigint
  toBlock: bigint
  /** Blocks per request. Default and maximum {@link MAX_LOG_RANGE}. */
  chunk?: number
  /** Parallel requests. Default 3. */
  concurrency?: number
  /** Called after every chunk with the range it covered and the logs it returned. */
  onChunk?: (fromBlock: bigint, toBlock: bigint, logs: Log[]) => void
  /** Retry policy per chunk (default: the general `withRetry` defaults). */
  retry?: RetryOptions
}

/**
 * Patient retry policy for backfills on the public gateway, whose eth_getLogs bucket is tiny
 * (about 2 requests/s clean): 12 tries, 0.5 s doubling to 20 s, roughly 2.5 minutes in total.
 */
export const BACKFILL_RETRY: RetryOptions = { tries: 12, baseMs: 500, maxMs: 20_000 }

/** A raw log with the fields the bot needs, block number and log index guaranteed present. */
export type RawLog = Log<bigint, number, false>

/**
 * Fetch logs over an arbitrary block range by splitting it into chunks of at most `chunk`
 * blocks, fetching chunks with bounded concurrency and per-chunk retry, and returning the logs in
 * (blockNumber, logIndex) order. `toBlock` must be an explicit number (never "latest"; see spec).
 */
export async function getLogsChunked(client: PublicClient, params: GetLogsChunkedParams): Promise<RawLog[]> {
  const { address, fromBlock, toBlock } = params
  if (toBlock < fromBlock) return []
  if (typeof address === 'object' && address.length === 0) return []
  const chunk = BigInt(Math.min(params.chunk ?? MAX_LOG_RANGE, MAX_LOG_RANGE))
  if (chunk < 1n) throw new Error('getLogsChunked: chunk must be >= 1')
  const limit: Limiter = limiter(params.concurrency ?? 3)
  const topics = params.topics ?? eventsToTopics(params.events ?? [])

  const ranges: Array<[bigint, bigint]> = []
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock
    ranges.push([start, end])
  }
  const perChunk = await Promise.all(
    ranges.map(([start, end]) => fetchRangeBisecting(client, address, topics, start, end, limit, params.onChunk, params.retry ?? {})),
  )
  return perChunk.flat()
}

/**
 * Fetch `[from, to]` in one call; when the provider rejects it for returning too many logs,
 * split the range in half and fetch both halves (recursively, each under the limiter).
 */
async function fetchRangeBisecting(
  client: PublicClient,
  address: AddressFilter,
  topics: TopicFilter[],
  from: bigint,
  to: bigint,
  limit: Limiter,
  onChunk: GetLogsChunkedParams['onChunk'],
  retry: RetryOptions,
): Promise<RawLog[]> {
  try {
    const logs = await limit(() => fetchLogsOnce(client, address, topics, from, to, retry))
    onChunk?.(from, to, logs)
    return logs
  } catch (error) {
    if (from >= to || !isLogRangeTooLarge(error)) throw error
    const mid = from + (to - from) / 2n
    const [head, tail] = await Promise.all([
      fetchRangeBisecting(client, address, topics, from, mid, limit, onChunk, retry),
      fetchRangeBisecting(client, address, topics, mid + 1n, to, limit, onChunk, retry),
    ])
    return head.concat(tail)
  }
}

/**
 * True when an `eth_getLogs` failed because the range or result set is too big: the provider's
 * result cap, its block-range cap, or a response body larger than the client accepts.
 */
export function isLogRangeTooLarge(error: unknown): boolean {
  let e: unknown = error
  const seen = new Set<unknown>()
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e)
    if (e instanceof ResponseBodyTooLargeError) return true
    for (const key of ['message', 'details', 'shortMessage'] as const) {
      const text = (e as Record<string, unknown>)[key]
      if (typeof text === 'string' && RESULT_CAP_MESSAGE.test(text)) return true
    }
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** Build the positional topic filter that matches any of `events` on topic0. */
export function eventsToTopics(events: readonly AbiEvent[]): TopicFilter[] {
  if (events.length === 0) return []
  return [events.map((e) => toEventSelector(e))]
}

/**
 * One `eth_getLogs` call (with retry) for a range that already respects the provider cap. Uses
 * the raw request so that positional topic filters can be passed without viem's event decoding.
 * `address` may be one emitter, a list of emitters (any of) or `undefined` for no emitter filter.
 * `retry` overrides the default backoff (callers on a per-block critical path pass a shorter one).
 */
export async function fetchLogsOnce(
  client: PublicClient,
  address: AddressFilter,
  topics: TopicFilter[],
  fromBlock: bigint,
  toBlock: bigint,
  retry: RetryOptions = {},
): Promise<RawLog[]> {
  if (toBlock - fromBlock + 1n > BigInt(MAX_LOG_RANGE)) {
    throw new Error(`fetchLogsOnce: range ${fromBlock}-${toBlock} exceeds ${MAX_LOG_RANGE} blocks`)
  }
  const raw = await withRetry(
    () =>
      client.request({
        method: 'eth_getLogs',
        params: [
          {
            ...(address === undefined ? {} : { address: typeof address === 'string' ? address : [...address] }),
            fromBlock: toHex(fromBlock),
            toBlock: toHex(toBlock),
            ...(topics.length > 0 ? { topics } : {}),
          },
        ],
      }),
    { label: `eth_getLogs ${fromBlock}-${toBlock}`, ...retry },
  )
  const logs = (raw as RpcLog[]).map((l) => formatLog(l) as RawLog)
  logs.sort(compareLogs)
  return logs
}

/** Order by block number then log index. */
export function compareLogs(a: RawLog, b: RawLog): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
  return a.logIndex - b.logIndex
}

/**
 * The newest block that is safe to query with explicit ranges: `latest - 1`. The public RPC
 * occasionally rejects reads at the very head (block not yet indexed on the serving node).
 */
export async function safeHead(client: PublicClient): Promise<bigint> {
  const latest = await withRetry(() => client.getBlockNumber({ cacheTime: 0 }), { label: 'eth_blockNumber' })
  return latest > 0n ? latest - 1n : 0n
}
