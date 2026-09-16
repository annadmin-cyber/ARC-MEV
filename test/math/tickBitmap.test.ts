import { describe, expect, it } from 'vitest'
import type { TickData } from '../../src/types.js'
import { compress, nextInitializedTickWithinOneWord, position } from '../../src/math/tickBitmap.js'
import { addDelta } from '../../src/math/liquidityMath.js'
import { MAX_UINT128, MathError } from '../../src/math/fullMath.js'
import { compressVectors } from './fixtures.js'

const W = { lower: -1_000_000, upper: 1_000_000 }
const td = (net: bigint): TickData => ({ liquidityNet: net, liquidityGross: net < 0n ? -net : net })

describe('TickBitmap', () => {
  it('compress / position match Solidity vectors', () => {
    for (const v of compressVectors) {
      expect(compress(v.tick, v.tickSpacing), `compress ${v.tick}/${v.tickSpacing}`).toBe(v.compressed)
      const p = position(v.compressed)
      expect(p.wordPos, `wordPos ${v.compressed}`).toBe(v.wordPos)
      expect(p.bitPos, `bitPos ${v.compressed}`).toBe(v.bitPos)
    }
  })

  it('finds the next initialised tick to the left (lte) including the current tick', () => {
    const ticks = new Map<number, TickData>([
      [-600, td(1n)],
      [-120, td(1n)],
      [60, td(1n)],
    ])
    // tick 0 is the first tick of word 0: searching left only sees tick 0 itself (Pool.swap then moves to -1)
    expect(nextInitializedTickWithinOneWord(ticks, 0, 60, true, W)).toEqual({ next: 0, initialized: false })
    expect(nextInitializedTickWithinOneWord(ticks, -1, 60, true, W)).toEqual({ next: -120, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, -120, 60, true, W)).toEqual({ next: -120, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, -121, 60, true, W)).toEqual({ next: -600, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, 60, 60, true, W)).toEqual({ next: 60, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, 59, 60, true, W)).toEqual({ next: 0, initialized: false })
    // nothing left in the word -> word start (compressed -256 .. -1 -> tick -15360)
    expect(nextInitializedTickWithinOneWord(ticks, -601, 60, true, W)).toEqual({ next: -15360, initialized: false })
  })

  it('finds the next initialised tick to the right (gt), excluding the current tick', () => {
    const ticks = new Map<number, TickData>([
      [-120, td(1n)],
      [60, td(1n)],
      [180, td(1n)],
    ])
    expect(nextInitializedTickWithinOneWord(ticks, 0, 60, false, W)).toEqual({ next: 60, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, 60, 60, false, W)).toEqual({ next: 180, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, 59, 60, false, W)).toEqual({ next: 60, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, -121, 60, false, W)).toEqual({ next: -120, initialized: true })
    // nothing right of 180 in word 0 -> last tick of the word (255 * 60)
    expect(nextInitializedTickWithinOneWord(ticks, 180, 60, false, W)).toEqual({ next: 15300, initialized: false })
    // from the top of word 0, the search moves into word 1
    expect(nextInitializedTickWithinOneWord(ticks, 15300, 60, false, W)).toEqual({ next: 30660, initialized: false })
  })

  it('respects word boundaries exactly like the on-chain bitmap', () => {
    // tick 256*60 = 15360 is in word 1; a search from 15359 downward must not see it, but 15360 itself must
    const ticks = new Map<number, TickData>([[15360, td(1n)]])
    expect(nextInitializedTickWithinOneWord(ticks, 15359, 60, true, W)).toEqual({ next: 0, initialized: false })
    expect(nextInitializedTickWithinOneWord(ticks, 15360, 60, true, W)).toEqual({ next: 15360, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, 15299, 60, false, W)).toEqual({ next: 15300, initialized: false })
    expect(nextInitializedTickWithinOneWord(ticks, 15300, 60, false, W)).toEqual({ next: 15360, initialized: true })
    // negative words: ticks -15360..-60 are word -1 for spacing 60
    const neg = new Map<number, TickData>([[-15360, td(1n)]])
    expect(nextInitializedTickWithinOneWord(neg, -1, 60, true, W)).toEqual({ next: -15360, initialized: true })
    expect(nextInitializedTickWithinOneWord(neg, -15361, 60, true, W)).toEqual({ next: -30720, initialized: false })
  })

  it('ignores ticks outside the window', () => {
    const ticks = new Map<number, TickData>([
      [-120, td(1n)],
      [120, td(1n)],
    ])
    const narrow = { lower: -100, upper: 100 }
    expect(nextInitializedTickWithinOneWord(ticks, -1, 60, true, narrow)).toEqual({ next: -15360, initialized: false })
    expect(nextInitializedTickWithinOneWord(ticks, -1, 60, true, W)).toEqual({ next: -120, initialized: true })
    expect(nextInitializedTickWithinOneWord(ticks, 0, 60, false, narrow)).toEqual({ next: 15300, initialized: false })
  })
})

describe('LiquidityMath.addDelta', () => {
  it('adds signed deltas and throws on under/overflow', () => {
    expect(addDelta(10n, -3n)).toBe(7n)
    expect(addDelta(10n, 3n)).toBe(13n)
    expect(addDelta(MAX_UINT128, 0n)).toBe(MAX_UINT128)
    expect(() => addDelta(2n, -3n)).toThrow(MathError)
    expect(() => addDelta(MAX_UINT128, 1n)).toThrow(MathError)
  })
})
