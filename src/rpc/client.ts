import {
  BaseError,
  HttpRequestError,
  ResponseBodyTooLargeError,
  TimeoutError,
  createPublicClient,
  http,
  parseAbi,
  webSocket,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem'
import type { Config } from '../config.js'
import { CHAINS } from '../chains.js'
import { log } from '../logger.js'

/**
 * Connected viem clients for one chain.
 *
 * - `http`: JSON-RPC batching enabled (many `eth_call`s issued in the same tick travel in one HTTP
 *   request). Use it for everything except very large single calls.
 * - `httpSingle`: same endpoint without JSON-RPC batching. `extsload` uses it so that an 800-slot
 *   read is never glued to unrelated requests in one HTTP body. Falls back to `http` when absent.
 * - `ws`: present only when `WS_URL` is configured (for `newHeads`).
 */
export interface RpcClients {
  http: PublicClient
  httpSingle?: PublicClient
  ws?: PublicClient
  chain: Chain
  /** RPC URLs that receive `eth_sendRawTransaction` (primary first, de-duplicated). */
  sendUrls: string[]
}

/** Default HTTP timeout for a single JSON-RPC request. */
const HTTP_TIMEOUT_MS = 20_000

/**
 * viem caps JSON-RPC response bodies at 10 MiB by default; a 20,000-log `eth_getLogs` answer
 * from Arc is ~10.5 MB, so allow 64 MiB (log fetches also bisect on oversized responses).
 */
const MAX_RESPONSE_BODY_BYTES = 64 * 1024 * 1024

/**
 * Build the clients described by `cfg`. viem's built-in transport retry is disabled so that
 * {@link withRetry} is the single retry policy in the process.
 */
export function makeClients(cfg: Config): RpcClients {
  const chain = CHAINS[cfg.CHAIN_ID]
  if (!chain) throw new Error(`makeClients: unknown CHAIN_ID ${cfg.CHAIN_ID}`)
  const httpClient = createPublicClient({
    chain,
    batch: { multicall: false },
    transport: http(cfg.RPC_URL, {
      batch: true,
      retryCount: 0,
      timeout: HTTP_TIMEOUT_MS,
      maxResponseBodySize: MAX_RESPONSE_BODY_BYTES,
    }),
  })
  const httpSingle = createPublicClient({
    chain,
    batch: { multicall: false },
    transport: http(cfg.RPC_URL, {
      batch: false,
      retryCount: 0,
      timeout: HTTP_TIMEOUT_MS,
      maxResponseBodySize: MAX_RESPONSE_BODY_BYTES,
    }),
  })
  const clients: RpcClients = {
    http: httpClient as PublicClient,
    httpSingle: httpSingle as PublicClient,
    chain,
    sendUrls: [...cfg.sendRpcUrls],
  }
  if (cfg.WS_URL) {
    clients.ws = createPublicClient({
      chain,
      transport: webSocket(cfg.WS_URL, { retryCount: 0, timeout: HTTP_TIMEOUT_MS }),
    }) as PublicClient
  }
  return clients
}

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Total attempts including the first one. Default 6. */
  tries?: number
  /** Delay before the second attempt in ms. Default 300. */
  baseMs?: number
  /** Multiplier applied to the delay after every failed attempt. Default 2. */
  factor?: number
  /** Upper bound for a single delay in ms. Default 10_000. */
  maxMs?: number
  /** Add up to 25% random jitter to every delay. Default true. */
  jitter?: boolean
  /** Override the retry predicate. Default {@link isRetryableRpcError}. */
  shouldRetry?: (error: unknown) => boolean
  /** Label used in the retry warning log. */
  label?: string
}

/** Messages that identify throttling / transient limits on JSON-RPC providers. */
const RETRYABLE_MESSAGE = /rate|limit|too many|429|-32005|-32614/i

/** JSON-RPC error codes that are transient by convention (-32005 limit exceeded, -32614 provider-specific throttle). */
const RETRYABLE_CODES = new Set([-32005, -32614, 429])

/**
 * True for errors worth retrying: HTTP 429 / transport failures / timeouts, and JSON-RPC errors
 * whose code or message signals throttling. Everything else (reverts, invalid params, unknown
 * block, ...) is rethrown immediately by {@link withRetry}.
 */
export function isRetryableRpcError(error: unknown): boolean {
  for (const e of errorChain(error)) {
    // Oversized responses never shrink on retry (its message mentions "limit"); callers split the query instead.
    if (e instanceof ResponseBodyTooLargeError) return false
    if (e instanceof HttpRequestError || e instanceof TimeoutError) return true
    const code = (e as { code?: unknown }).code
    if (typeof code === 'number' && RETRYABLE_CODES.has(code)) return true
    const status = (e as { status?: unknown }).status
    if (status === 429) return true
    const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
    if (message && RETRYABLE_MESSAGE.test(message)) return true
  }
  return false
}

/** Walk `error.cause` (viem nests causes several levels deep). */
function* errorChain(error: unknown): Generator<unknown> {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    yield current
    if (current instanceof BaseError) {
      current = current.cause
    } else if (typeof current === 'object' && 'cause' in current) {
      current = (current as { cause?: unknown }).cause
    } else {
      current = undefined
    }
  }
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `fn`, retrying with exponential backoff (300ms, 600ms, 1.2s, ... with jitter, 6 tries by
 * default) when the failure is a rate limit or a transport problem. Non-retryable errors are
 * rethrown at once; after the last attempt the last error is rethrown.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const tries = Math.max(1, opts.tries ?? 6)
  const baseMs = opts.baseMs ?? 300
  const factor = opts.factor ?? 2
  const maxMs = opts.maxMs ?? 10_000
  const jitter = opts.jitter ?? true
  const shouldRetry = opts.shouldRetry ?? isRetryableRpcError
  let delay = baseMs
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= tries || !shouldRetry(error)) throw error
      const wait = Math.min(maxMs, jitter ? delay * (1 + Math.random() * 0.25) : delay)
      log.warn(
        { attempt, tries, waitMs: Math.round(wait), label: opts.label, err: errorSummary(error) },
        'rpc call failed, retrying',
      )
      await sleep(wait)
      delay *= factor
    }
  }
}

/** Compact one-line description of an error for logs. */
function errorSummary(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage
  if (error instanceof Error) return error.message
  return String(error)
}

/** A function that runs a task under a concurrency limit. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>

/**
 * Simple promise semaphore: at most `concurrency` tasks run at once, the rest queue FIFO.
 */
export function limiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`limiter: concurrency must be a positive integer, got ${concurrency}`)
  }
  let active = 0
  const queue: Array<() => void> = []
  const release = (): void => {
    active--
    const next = queue.shift()
    if (next) next()
  }
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < concurrency) {
        active++
        resolve()
      } else {
        queue.push(() => {
          active++
          resolve()
        })
      }
    })
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/** Only the array overload, so viem never has to disambiguate `extsload(bytes32)` from `extsload(bytes32[])`. */
const extsloadArrayAbi = parseAbi(['function extsload(bytes32[] slots) view returns (bytes32[])'])

/** Slots per `extsload` call. 800 x 32 bytes = 25.6 KiB of return data, comfortably under provider limits. */
export const EXTSLOAD_BATCH = 800

/** Default concurrency for chunked reads against the public RPC. */
export const DEFAULT_RPC_CONCURRENCY = 4

const defaultLimiter = limiter(DEFAULT_RPC_CONCURRENCY)

/** Options for {@link extsload}. */
export interface ExtsloadOptions {
  /** Slots per call. Default {@link EXTSLOAD_BATCH}. */
  batchSize?: number
  /** Concurrency limiter shared with other readers. Default: module-level limiter of 4. */
  limit?: Limiter
  /** Retry policy per batch. Default: the slow {@link withRetry} defaults (discovery / backfill); per-block callers pass a short one. */
  retry?: RetryOptions
}

/**
 * Read arbitrary PoolManager storage slots via `extsload(bytes32[])`, splitting into batches of
 * `batchSize` slots, running the batches under a concurrency limit with retry, and returning the
 * values in the same order as `slots`. Without `block` the latest state is read.
 */
export async function extsload(
  clients: RpcClients,
  poolManager: Address,
  slots: readonly Hex[],
  block?: bigint,
  opts: ExtsloadOptions = {},
): Promise<Hex[]> {
  if (slots.length === 0) return []
  const batchSize = opts.batchSize ?? EXTSLOAD_BATCH
  const limit = opts.limit ?? defaultLimiter
  const client = clients.httpSingle ?? clients.http
  const chunks: Hex[][] = []
  for (let i = 0; i < slots.length; i += batchSize) chunks.push(slots.slice(i, i + batchSize))
  const results = await Promise.all(
    chunks.map((chunk, idx) =>
      limit(() =>
        withRetry(
          async () => {
            const values = await client.readContract({
              address: poolManager,
              abi: extsloadArrayAbi,
              functionName: 'extsload',
              args: [chunk],
              ...(block === undefined ? {} : { blockNumber: block }),
            })
            if (values.length !== chunk.length) {
              throw new Error(`extsload: expected ${chunk.length} values, got ${values.length} (chunk ${idx})`)
            }
            return values as readonly Hex[]
          },
          { ...opts.retry, label: `extsload#${idx}` },
        ),
      ),
    ),
  )
  return results.flatMap((r) => [...r])
}
