import { describe, expect, it } from 'vitest'
import { BlockLoop } from '../../src/exec/blockLoop.js'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('BlockLoop', () => {
  it('processes blocks one at a time and skips to the newest when a backlog builds up', async () => {
    const seen: Array<[bigint, bigint]> = []
    let release: (() => void) | undefined
    const loop = new BlockLoop(async (block, skipped) => {
      seen.push([block, skipped])
      if (block === 10n) await new Promise<void>((r) => (release = r))
    })
    loop.notify(10n)
    await tick()
    // While 10 is being processed, 11, 12 and 13 arrive (and a stale 9).
    loop.notify(11n)
    loop.notify(9n)
    loop.notify(12n)
    loop.notify(13n)
    release?.()
    await tick()
    expect(seen).toEqual([
      [10n, 0n],
      [13n, 2n],
    ])
    expect(loop.lastProcessed).toBe(13n)
  })

  it('keeps going after a handler error and ignores duplicate notifications', async () => {
    const seen: bigint[] = []
    const loop = new BlockLoop(async (block) => {
      seen.push(block)
      if (block === 2n) throw new Error('boom')
    })
    loop.notify(1n)
    await tick()
    loop.notify(2n)
    await tick()
    loop.notify(2n)
    loop.notify(3n)
    await tick()
    expect(seen).toEqual([1n, 2n, 3n])
  })

  it('stop() waits for the block in progress and rejects further blocks', async () => {
    const seen: bigint[] = []
    const loop = new BlockLoop(async (block) => {
      await tick()
      seen.push(block)
    })
    loop.notify(5n)
    const stopped = loop.stop()
    loop.notify(6n)
    await stopped
    expect(seen).toEqual([5n])
    expect(loop.active).toBe(false)
    loop.notify(7n)
    await tick()
    expect(seen).toEqual([5n])
  })
})
