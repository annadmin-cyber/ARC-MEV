import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHeadSource, type HeadSubscription } from '../../src/exec/headSource.js'

/**
 * Models what viem's WebSocket transport does when the socket closes: every subscription's
 * onError fires with SocketClosedError. A consumer that unsubscribes on that error cancels
 * viem's own re-subscribe on reconnect, so heads only flow again on a subscription created by a
 * later `watch` call (which this fake models by re-arming on every `watch`).
 *
 * Regression for: the head feed forgot the URL after the first socket close and polled for the
 * rest of the run (mode 'polling', liveSubscriptions 0, heads on the reconnected socket ignored).
 */
function viemLikeSubscription(url: string) {
  let handlers: { onBlock: (b: bigint) => void; onError: (e: unknown) => void } | undefined
  let unsubscribed = false
  let watches = 0
  const sub: HeadSubscription = {
    url,
    watch(onBlock, onError) {
      watches++
      unsubscribed = false
      handlers = { onBlock, onError }
      return () => {
        unsubscribed = true
      }
    },
  }
  return {
    sub,
    socketClosed: () => handlers?.onError(new Error('The socket has been closed.')),
    /** A head on the current subscription (only if the consumer did not unsubscribe it). */
    headAfterReconnect: (b: bigint) => {
      if (!unsubscribed) handlers?.onBlock(b)
    },
    get unsubscribed() {
      return unsubscribed
    },
    get watches() {
      return watches
    },
  }
}

describe('startHeadSource after a WebSocket drop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('re-creates the subscription after the backoff and returns to newHeads on its first head', async () => {
    const ws = viemLikeSubscription('wss://rpc.mainnet.arc.io/ws')
    const seen: bigint[] = []
    let polled = 100n
    const poll = vi.fn(async () => ++polled)
    const source = startHeadSource({ subscriptions: [ws.sub], poll, pollIntervalMs: 250, stallMs: 3000, onBlock: (b) => seen.push(b) })
    ws.headAfterReconnect(99n)
    ws.socketClosed()
    // The dead subscription is released and polling covers the gap...
    expect(ws.unsubscribed).toBe(true)
    expect(source.status()).toMatchObject({ mode: 'polling', liveSubscriptions: 0, reconnects: 0 })
    await vi.advanceTimersByTimeAsync(1999)
    expect(ws.watches).toBe(1)
    expect(poll).toHaveBeenCalledTimes(7)
    // ...until the URL is re-subscribed 2 s later.
    await vi.advanceTimersByTimeAsync(1)
    expect(ws.watches).toBe(2)
    expect(ws.unsubscribed).toBe(false)
    expect(source.status()).toMatchObject({ mode: 'polling', liveSubscriptions: 0, reconnects: 1 })
    // Its first head makes it live again, stops polling and de-duplicates against what polling delivered.
    const newest = seen[seen.length - 1]!
    ws.headAfterReconnect(newest)
    ws.headAfterReconnect(newest + 1n)
    expect(seen).toContain(newest + 1n)
    expect(source.status()).toMatchObject({ mode: 'ws', liveSubscriptions: 1 })
    const polls = poll.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(poll).toHaveBeenCalledTimes(polls)
    expect(seen).toEqual([...new Set(seen)])
    expect([...seen].sort((a, b) => (a < b ? -1 : 1))).toEqual(seen)
    source.stop()
  })

  it('backs off (2 s doubling to 30 s) while the endpoint keeps failing, and recovers whenever it comes back', async () => {
    const ws = viemLikeSubscription('wss://a')
    const seen: bigint[] = []
    let polled = 0n
    const source = startHeadSource({ subscriptions: [ws.sub], poll: async () => ++polled, pollIntervalMs: 250, stallMs: 3000, onBlock: (b) => seen.push(b) })
    ws.socketClosed()
    const watchesAt: number[] = []
    for (let t = 0; t < 10 * 60_000; t += 1000) {
      await vi.advanceTimersByTimeAsync(1000)
      if (ws.watches > watchesAt.length + 1) {
        watchesAt.push(t + 1000)
        ws.socketClosed() // every re-subscribe fails at once
      }
    }
    // Delays between attempts: 2, 4, 8, 16, 30, 30, ... seconds -> no thrash, no giving up.
    const gaps = watchesAt.slice(1).map((t, i) => t - watchesAt[i]!)
    expect(gaps.slice(0, 5)).toEqual([4000, 8000, 16_000, 30_000, 30_000])
    expect(Math.max(...gaps)).toBe(30_000)
    expect(watchesAt.length).toBeGreaterThan(15)
    expect(source.status().mode).toBe('polling')
    expect(seen.length).toBeGreaterThan(0)
    // The endpoint is back: the next re-subscribe delivers and the feed returns to newHeads.
    await vi.advanceTimersByTimeAsync(30_000)
    ws.headAfterReconnect(10_000n)
    expect(seen).toContain(10_000n)
    expect(source.status()).toMatchObject({ mode: 'ws', liveSubscriptions: 1 })
    source.stop()
  })

  it('re-creates a subscription that went silent (ws-stalled) instead of waiting forever', async () => {
    const ws = viemLikeSubscription('wss://a')
    const seen: bigint[] = []
    let polled = 500n
    const source = startHeadSource({ subscriptions: [ws.sub], poll: async () => ++polled, pollIntervalMs: 250, stallMs: 3000, onBlock: (b) => seen.push(b) })
    ws.headAfterReconnect(500n)
    // A silent TCP drop: no error, no heads.
    await vi.advanceTimersByTimeAsync(3000)
    expect(source.status()).toMatchObject({ mode: 'ws-stalled', stalls: 1, reconnects: 1 })
    expect(ws.watches).toBe(2) // re-created immediately on the first stall
    // Still silent: further re-creates follow the backoff (3 s watchdog + 2 s, then + 4 s, ...).
    await vi.advanceTimersByTimeAsync(3000 + 2000)
    expect(ws.watches).toBe(3)
    await vi.advanceTimersByTimeAsync(3000 + 4000)
    expect(ws.watches).toBe(4)
    // The fresh subscription delivers: back to 'ws', polling stops.
    const newest = seen[seen.length - 1]!
    ws.headAfterReconnect(newest + 1n)
    expect(source.status()).toMatchObject({ mode: 'ws', liveSubscriptions: 1 })
    expect(seen[seen.length - 1]).toBe(newest + 1n)
    source.stop()
  })
})
