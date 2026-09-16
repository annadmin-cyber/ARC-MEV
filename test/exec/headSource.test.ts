import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHeadSource, type HeadSubscription } from '../../src/exec/headSource.js'

/** A scriptable newHeads subscription. */
function fakeSubscription(url: string) {
  let handlers: { onBlock: (b: bigint) => void; onError: (e: unknown) => void } | undefined
  let unsubscribed = 0
  const sub: HeadSubscription = {
    url,
    watch(onBlock, onError) {
      handlers = { onBlock, onError }
      return () => {
        unsubscribed++
      }
    },
  }
  return {
    sub,
    head: (b: bigint) => handlers?.onBlock(b),
    fail: (e: unknown) => handlers?.onError(e),
    get unsubscribed() {
      return unsubscribed
    },
  }
}

describe('startHeadSource', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('races several subscriptions and delivers each block number once, in increasing order', () => {
    const a = fakeSubscription('wss://a')
    const b = fakeSubscription('wss://b')
    const seen: bigint[] = []
    const poll = vi.fn(async () => 0n)
    const source = startHeadSource({ subscriptions: [a.sub, b.sub], poll, pollIntervalMs: 250, stallMs: 3000, onBlock: (x) => seen.push(x) })
    a.head(10n)
    b.head(10n)
    b.head(11n)
    a.head(11n)
    a.head(9n)
    a.head(12n)
    expect(seen).toEqual([10n, 11n, 12n])
    expect(source.status()).toMatchObject({ mode: 'ws', newest: 12n, liveSubscriptions: 2, headsByUrl: { 'wss://a': 4, 'wss://b': 2 }, stalls: 0 })
    vi.advanceTimersByTime(2999)
    expect(poll).not.toHaveBeenCalled()
    source.stop()
    expect(a.unsubscribed).toBe(1)
    expect(b.unsubscribed).toBe(1)
  })

  it('falls back to polling after stallMs without a head and stops polling when heads resume', async () => {
    const a = fakeSubscription('wss://a')
    const seen: bigint[] = []
    let polled = 100n
    const poll = vi.fn(async () => ++polled)
    const source = startHeadSource({ subscriptions: [a.sub], poll, pollIntervalMs: 250, stallMs: 3000, onBlock: (x) => seen.push(x) })
    a.head(100n)
    vi.advanceTimersByTime(2999)
    expect(source.status().mode).toBe('ws')
    vi.advanceTimersByTime(1)
    expect(source.status().mode).toBe('ws-stalled')
    expect(source.status().stalls).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([100n, 101n, 102n])
    // A WebSocket head arrives again: polling stops and the watchdog is re-armed.
    a.head(103n)
    expect(source.status().mode).toBe('ws')
    await vi.advanceTimersByTimeAsync(1000)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([100n, 101n, 102n, 103n])
    await vi.advanceTimersByTimeAsync(2250)
    expect(source.status().mode).toBe('ws-stalled')
    expect(source.status().stalls).toBe(2)
    expect(poll).toHaveBeenCalledTimes(3)
    source.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('keeps going on the remaining subscription when one fails and polls for good when all fail', async () => {
    const a = fakeSubscription('wss://a')
    const b = fakeSubscription('wss://b')
    const seen: bigint[] = []
    let polled = 200n
    const poll = vi.fn(async () => ++polled)
    const source = startHeadSource({ subscriptions: [a.sub, b.sub], poll, pollIntervalMs: 100, stallMs: 3000, onBlock: (x) => seen.push(x) })
    a.fail(new Error('socket closed'))
    expect(a.unsubscribed).toBe(1)
    expect(source.status()).toMatchObject({ mode: 'ws', liveSubscriptions: 1 })
    b.head(200n)
    b.fail(new Error('socket closed'))
    expect(source.status()).toMatchObject({ mode: 'polling', liveSubscriptions: 0 })
    await vi.advanceTimersByTimeAsync(100)
    expect(seen).toEqual([200n, 201n])
    // Late heads from a dead subscription are ignored.
    b.head(300n)
    expect(seen).toEqual([200n, 201n])
    source.stop()
  })

  it('polls from the start without subscriptions and tolerates poll errors', async () => {
    const seen: bigint[] = []
    let n = 0
    const poll = vi.fn(async () => {
      n++
      if (n === 2) throw new Error('429')
      return BigInt(n)
    })
    const source = startHeadSource({ subscriptions: [], poll, pollIntervalMs: 100, stallMs: 3000, onBlock: (x) => seen.push(x) })
    expect(source.status().mode).toBe('polling')
    await vi.advanceTimersByTimeAsync(350)
    expect(poll).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([1n, 3n])
    source.stop()
  })
})
