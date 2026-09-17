/**
 * Chain-head feed with resilience: several `newHeads` subscriptions race (one per WebSocket
 * endpoint) and are de-duplicated by block number, a watchdog switches to `eth_blockNumber`
 * polling when no head arrives for `stallMs`, and polling stops again as soon as a WebSocket
 * head shows up. Without any subscription the feed polls from the start.
 *
 * A subscription that fails (the socket closed, the endpoint errored) or goes silent (a stall)
 * is never forgotten: it is re-created with a capped exponential backoff (`reconnectMs` doubling
 * up to `maxReconnectMs`; immediately on the first stall) while polling covers the gap, and it
 * counts as live again on its first head. Heads from a superseded subscription are ignored.
 *
 * Everything time-related uses the global timers so tests can drive it with fake timers, and the
 * subscriptions / poller are plain callbacks so no network is needed to test the state machine.
 */
import { log } from '../logger.js'

/** One `newHeads` source. `watch` starts delivering block numbers and returns an unsubscribe; it may be called again after that. */
export interface HeadSubscription {
  url: string
  watch(onBlock: (block: bigint) => void, onError: (error: unknown) => void): () => void
}

export interface HeadSourceOptions {
  subscriptions: readonly HeadSubscription[]
  /** `eth_blockNumber` (with the caller's retry policy). */
  poll: () => Promise<bigint>
  pollIntervalMs: number
  /** No WebSocket head for this long -> polling starts (and silent subscriptions are re-created). */
  stallMs: number
  /** Receives every new (strictly increasing) block number exactly once. */
  onBlock: (block: bigint) => void
  /** First delay before a failed subscription is re-created; doubles per failure. Default 2000. */
  reconnectMs?: number
  /** Upper bound of that delay. Default 30000. */
  maxReconnectMs?: number
}

export type HeadMode = 'ws' | 'ws-stalled' | 'polling'

export interface HeadSourceStatus {
  mode: HeadMode
  newest: bigint | undefined
  /** Subscriptions currently delivering (subscribed and not failed / silent since). */
  liveSubscriptions: number
  /** Heads received per endpoint URL (including duplicates). */
  headsByUrl: Record<string, number>
  /** How often the watchdog switched to polling. */
  stalls: number
  /** How often a subscription was re-created after a failure or a stall. */
  reconnects: number
}

export interface HeadSource {
  stop(): void
  status(): HeadSourceStatus
}

/** Bookkeeping per endpoint. */
interface Entry {
  sub: HeadSubscription
  /** Bumped on every `watch`; callbacks of older generations are ignored. */
  generation: number
  /** Unsubscribe of the current subscription; absent while a re-create is pending. */
  unsubscribe: (() => void) | undefined
  /** Counted in `liveSubscriptions`: subscribed and delivering (or freshly subscribed at start). */
  live: boolean
  /** Delay before the next re-create. */
  backoffMs: number
  timer: ReturnType<typeof setTimeout> | undefined
}

const DEFAULT_RECONNECT_MS = 2_000
const DEFAULT_MAX_RECONNECT_MS = 30_000

/** Start following the head as described in the module doc. */
export function startHeadSource(opts: HeadSourceOptions): HeadSource {
  const reconnectMs = opts.reconnectMs ?? DEFAULT_RECONNECT_MS
  const maxReconnectMs = Math.max(reconnectMs, opts.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS)
  let stopped = false
  let newest: bigint | undefined
  let mode: HeadMode = opts.subscriptions.length > 0 ? 'ws' : 'polling'
  let stalls = 0
  let reconnects = 0
  const headsByUrl: Record<string, number> = {}
  const entries = new Map<string, Entry>()
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let poller: ReturnType<typeof setInterval> | undefined

  const liveCount = (): number => [...entries.values()].filter((e) => e.live).length
  const subscribedCount = (): number => [...entries.values()].filter((e) => e.unsubscribe !== undefined).length

  const deliver = (block: bigint): void => {
    if (stopped) return
    if (newest !== undefined && block <= newest) return
    newest = block
    opts.onBlock(block)
  }

  const startPolling = (): void => {
    if (poller || stopped) return
    log.info({ intervalMs: opts.pollIntervalMs }, 'following the head by polling eth_blockNumber')
    let busy = false
    poller = setInterval(() => {
      if (busy || stopped) return
      busy = true
      opts
        .poll()
        .then(deliver)
        .catch((error: unknown) => log.warn({ err: error }, 'eth_blockNumber failed'))
        .finally(() => {
          busy = false
        })
    }, opts.pollIntervalMs)
  }

  const stopPolling = (): void => {
    if (!poller) return
    clearInterval(poller)
    poller = undefined
  }

  /** Drop the current subscription of `entry` (its callbacks become stale). */
  const unsubscribeEntry = (entry: Entry): void => {
    const unsubscribe = entry.unsubscribe
    entry.unsubscribe = undefined
    entry.live = false
    if (!unsubscribe) return
    try {
      unsubscribe()
    } catch (e) {
      log.debug({ url: entry.sub.url, err: e }, 'unsubscribe failed')
    }
  }

  /** (Re-)subscribe `entry` now. `live` only when `countLive` (the initial subscription); otherwise the first head makes it live. */
  const subscribe = (entry: Entry, countLive: boolean): void => {
    if (stopped) return
    const generation = ++entry.generation
    let unsubscribe: () => void
    try {
      unsubscribe = entry.sub.watch(
        (block) => onWsHead(entry, generation, block),
        (error) => onWsError(entry, generation, error),
      )
    } catch (error) {
      log.warn({ url: entry.sub.url, err: error }, 'could not subscribe to newHeads')
      scheduleResubscribe(entry)
      return
    }
    if (entry.timer || entry.generation !== generation) {
      // The subscription failed synchronously inside `watch` (onError already scheduled the re-create).
      try {
        unsubscribe()
      } catch {
        /* nothing to release */
      }
      return
    }
    entry.unsubscribe = unsubscribe
    entry.live = countLive
    armWatchdog()
  }

  /** Re-create `entry`'s subscription after its current backoff, then double the backoff (capped). */
  const scheduleResubscribe = (entry: Entry): void => {
    if (stopped || entry.timer) return
    const delayMs = entry.backoffMs
    entry.backoffMs = Math.min(maxReconnectMs, entry.backoffMs * 2)
    log.info({ url: entry.sub.url, delayMs }, 'newHeads subscription will be re-created')
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (stopped) return
      reconnects++
      subscribe(entry, false)
    }, delayMs)
  }

  /** Nothing over WebSocket for `stallMs` -> poll, and re-create every subscription that is still up. */
  const armWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog)
    if (stopped || subscribedCount() === 0) return
    watchdog = setTimeout(() => {
      watchdog = undefined
      if (stopped) return
      if (mode === 'ws') {
        stalls++
        mode = 'ws-stalled'
        log.warn({ stallMs: opts.stallMs, newest, liveSubscriptions: liveCount() }, 'no newHeads over WebSocket, falling back to polling')
        startPolling()
      }
      for (const entry of entries.values()) {
        if (!entry.unsubscribe) continue
        const wasLive = entry.live
        unsubscribeEntry(entry)
        if (wasLive) {
          // It delivered before and went silent: a fresh subscription is the cheapest probe, try at once.
          reconnects++
          log.info({ url: entry.sub.url }, 'newHeads subscription silent, re-creating it')
          subscribe(entry, false)
        } else {
          // Re-created earlier and still silent: back off before trying again.
          scheduleResubscribe(entry)
        }
      }
    }, opts.stallMs)
  }

  const onWsHead = (entry: Entry, generation: number, block: bigint): void => {
    // Heads from a superseded subscription (or after stop) are ignored.
    if (stopped || generation !== entry.generation || !entry.unsubscribe) return
    headsByUrl[entry.sub.url] = (headsByUrl[entry.sub.url] ?? 0) + 1
    if (!entry.live) {
      entry.live = true
      entry.backoffMs = reconnectMs
      log.info({ url: entry.sub.url, block }, 'newHeads subscription delivering again')
    }
    if (mode !== 'ws') {
      mode = 'ws'
      stopPolling()
      log.info({ url: entry.sub.url, block }, 'newHeads resumed, polling stopped')
    }
    deliver(block)
    armWatchdog()
  }

  const onWsError = (entry: Entry, generation: number, error: unknown): void => {
    if (stopped || generation !== entry.generation) return
    unsubscribeEntry(entry)
    log.warn({ url: entry.sub.url, err: error, liveSubscriptions: liveCount() }, 'newHeads subscription failed')
    scheduleResubscribe(entry)
    if (liveCount() === 0 && mode !== 'polling') {
      mode = 'polling'
      if (watchdog) clearTimeout(watchdog)
      watchdog = undefined
      log.warn('every newHeads subscription failed, polling until one recovers')
      startPolling()
    }
  }

  for (const sub of opts.subscriptions) {
    if (entries.has(sub.url)) continue
    const entry: Entry = { sub, generation: 0, unsubscribe: undefined, live: false, backoffMs: reconnectMs, timer: undefined }
    entries.set(sub.url, entry)
    subscribe(entry, true)
  }
  if (liveCount() > 0) {
    log.info({ urls: [...entries.values()].filter((e) => e.live).map((e) => e.sub.url), stallMs: opts.stallMs }, 'following the head via newHeads')
  } else {
    mode = 'polling'
    startPolling()
  }

  return {
    stop(): void {
      stopped = true
      if (watchdog) clearTimeout(watchdog)
      watchdog = undefined
      stopPolling()
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = undefined
        unsubscribeEntry(entry)
      }
    },
    status(): HeadSourceStatus {
      return { mode, newest, liveSubscriptions: liveCount(), headsByUrl: { ...headsByUrl }, stalls, reconnects }
    },
  }
}
