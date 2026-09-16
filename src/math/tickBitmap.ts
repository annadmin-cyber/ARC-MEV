/**
 * Port of Uniswap v4 `TickBitmap.sol` over an in-memory `Map<number, TickData>`.
 *
 * On chain the bitmap packs one bit per (tick / tickSpacing) in 256-bit words and
 * `nextInitializedTickWithinOneWord` only ever looks inside one word. We reproduce the
 * exact same word boundaries and results, but the source of truth for "initialised" is
 * membership in the tick map, limited to the tick window the state reader filled.
 */
import type { TickData } from '../types.js'

/** Inclusive range of ticks for which a tick map is known to be complete. */
export interface TickWindow {
  lower: number
  upper: number
}

/** Result of a next-initialised-tick search. */
export interface NextTick {
  /** The next initialised tick, or the boundary of the searched word when none is initialised. */
  next: number
  initialized: boolean
}

/** `tick / tickSpacing` rounded toward negative infinity. */
export function compress(tick: number, tickSpacing: number): number {
  let compressed = Math.trunc(tick / tickSpacing)
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1
  return compressed
}

/** Word index (int16, arithmetic shift) and bit index (0..255) of a compressed tick. */
export function position(compressedTick: number): { wordPos: number; bitPos: number } {
  return { wordPos: compressedTick >> 8, bitPos: compressedTick & 0xff }
}

function isInitialized(ticks: Map<number, TickData>, tick: number, window: TickWindow): boolean {
  return tick >= window.lower && tick <= window.upper && ticks.has(tick)
}

/**
 * Next initialised tick within the same 256-bit bitmap word, mirroring
 * `TickBitmap.nextInitializedTickWithinOneWord`.
 *
 * @param ticks initialised ticks (keys are real ticks, multiples of tickSpacing)
 * @param tick the starting tick
 * @param tickSpacing the pool's tick spacing
 * @param lte search left (<= tick) when true, right (> tick) when false
 * @param window only ticks inside this inclusive window count as initialised
 * @returns `{ next, initialized }`; when nothing is initialised, `next` is the far edge of the word
 */
export function nextInitializedTickWithinOneWord(
  ticks: Map<number, TickData>,
  tick: number,
  tickSpacing: number,
  lte: boolean,
  window: TickWindow,
): NextTick {
  const compressed = compress(tick, tickSpacing)

  if (lte) {
    const { wordPos, bitPos } = position(compressed)
    const wordStart = wordPos * 256
    for (let bit = bitPos; bit >= 0; bit--) {
      const candidate = (wordStart + bit) * tickSpacing
      if (isInitialized(ticks, candidate, window)) return { next: candidate, initialized: true }
    }
    return { next: (compressed - bitPos) * tickSpacing, initialized: false }
  }

  // Start from the word of the next tick; the current tick's own state does not matter.
  const start = compressed + 1
  const { wordPos, bitPos } = position(start)
  const wordStart = wordPos * 256
  for (let bit = bitPos; bit <= 255; bit++) {
    const candidate = (wordStart + bit) * tickSpacing
    if (isInitialized(ticks, candidate, window)) return { next: candidate, initialized: true }
  }
  return { next: (start + (255 - bitPos)) * tickSpacing, initialized: false }
}
