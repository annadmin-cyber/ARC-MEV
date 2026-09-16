/**
 * Chain-head feed with resilience: several `newHeads` subscriptions race (one per WebSocket
 * endpoint) and are de-duplicated by block number, a watchdog switches to `eth_blockNumber`
 * polling when no head arrives for `stallMs`, and polling stops again as soon as a WebSocket
 * head shows up. Without any subscription the feed polls from the start.
 *
 * Everything time-related uses the global timers so tests can drive it with fake timers, and the
 * subscriptions / poller are plain callbacks so no network is needed to test the state machine.
 */
import { log } from '../logger.js'

/** One `newHeads` source. `watch` starts delivering block numbers and returns an unsubscribe. */
export interface HeadSubscription {
  url: string
  watch(onBlock: (block: bigint) => void, onError: (error: unknown) => void): () => void
}

export interface HeadSourceOptions {
  subscriptions: readonly HeadSubscription[]
  /** `eth_blockNumber` (with the caller's retry policy). */
  poll: () => Promise<bigint>
  pollIntervalMs: number
  /** No WebSocket head for this long -> polling starts. */
  stallMs: number
  /** Receives every new (strictly increasing) block number exactly once. */
  onBlock: (block: bigint) => void
}

export type HeadMode = 'ws' | 'ws-stalled' | 'polling'

export interface HeadSourceStatus {
  mode: HeadMode
  newest: bigint | undefined
  /** Subscriptions still alive. */
  liveSubscriptions: number
  /** Heads received per endpoint URL (including duplicates). */
  headsByUrl: Record<string, number>
  /** How often the watchdog switched to polling. */
  stalls: number
}

export interface HeadSource {
  stop(): void
  status(): HeadSourceStatus
}

/** Start following the head as described in the module doc. */
export function startHeadSource(opts: HeadSourceOptions): HeadSource {
  let stopped = false
  let newest: bigint | undefined
  let mode: HeadMode = opts.subscriptions.length > 0 ? 'ws' : 'polling'
  let stalls = 0
  const headsByUrl: Record<string, number> = {}
  const unsubscribes = new Map<string, () => void>()
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let poller: ReturnType<typeof setInterval> | undefined

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

  const armWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog)
    if (unsubscribes.size === 0 || stopped) return
    watchdog = setTimeout(() => {
      watchdog = undefined
      if (stopped || mode !== 'ws') return
      stalls++
      mode = 'ws-stalled'
      log.warn({ stallMs: opts.stallMs, newest, liveSubscriptions: unsubscribes.size }, 'no newHeads over WebSocket, falling back to polling')
      startPolling()
    }, opts.stallMs)
  }

  const onWsHead = (url: string, block: bigint): void => {
    // Heads from a subscription that already failed (or after stop) are ignored.
    if (stopped || !unsubscribes.has(url)) return
    headsByUrl[url] = (headsByUrl[url] ?? 0) + 1
    if (mode === 'ws-stalled') {
      mode = 'ws'
      stopPolling()
      log.info({ url, block }, 'newHeads resumed, polling stopped')
    }
    deliver(block)
    armWatchdog()
  }

  const onWsError = (url: string, error: unknown): void => {
    if (stopped) return
    const unsubscribe = unsubscribes.get(url)
    if (!unsubscribe) return
    unsubscribes.delete(url)
    try {
      unsubscribe()
    } catch (e) {
      log.debug({ url, err: e }, 'unsubscribe failed')
    }
    log.warn({ url, err: error, liveSubscriptions: unsubscribes.size }, 'newHeads subscription failed')
    if (unsubscribes.size === 0) {
      mode = 'polling'
      if (watchdog) clearTimeout(watchdog)
      watchdog = undefined
      log.warn('every newHeads subscription failed, polling from now on')
      startPolling()
    }
  }

  for (const sub of opts.subscriptions) {
    if (unsubscribes.has(sub.url)) continue
    try {
      const unsubscribe = sub.watch(
        (block) => onWsHead(sub.url, block),
        (error) => onWsError(sub.url, error),
      )
      unsubscribes.set(sub.url, unsubscribe)
    } catch (error) {
      log.warn({ url: sub.url, err: error }, 'could not subscribe to newHeads')
    }
  }
  if (unsubscribes.size > 0) {
    log.info({ urls: [...unsubscribes.keys()], stallMs: opts.stallMs }, 'following the head via newHeads')
    armWatchdog()
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
      for (const [url, unsubscribe] of unsubscribes) {
        try {
          unsubscribe()
        } catch (e) {
          log.debug({ url, err: e }, 'unsubscribe failed')
        }
      }
      unsubscribes.clear()
    },
    status(): HeadSourceStatus {
      return { mode, newest, liveSubscriptions: unsubscribes.size, headsByUrl: { ...headsByUrl }, stalls }
    },
  }
}
