import { hexToBigInt, type Hex } from 'viem'
import type { Config } from '../config.js'
import { ADDRESSES } from '../chains.js'
import { extsload, limiter, type Limiter, type RpcClients } from '../rpc/client.js'
import type { PoolInfo, PoolState, TickData } from '../types.js'
import {
  bitmapWordSlot,
  decodeSlot0,
  decodeTickWord,
  decodeUint128,
  liquiditySlot,
  slot0Slot,
  tickInfoSlot,
  ticksInWord,
  wordPosBounds,
  wordPosOfTick,
  wordTickSpan,
} from './slots.js'

/** Options for {@link fetchPoolStates}. */
export interface FetchPoolStatesOptions {
  /**
   * Last known tick per pool. With a hint, the bitmap words around it are fetched together with
   * slot0 (2 round trips). Without one, the words can only be chosen after slot0 is known
   * (3 round trips).
   */
  tickHints?: ReadonlyMap<Hex, number>
  /** Concurrency limiter for the underlying `extsload` batches. Default: a limiter of 4. */
  limit?: Limiter
}

/** A pool with everything round trip 1 produced for it. */
interface Partial1 {
  info: PoolInfo
  sqrtPriceX96: bigint
  tick: number
  protocolFee: number
  lpFee: number
  liquidity: bigint
  /** wordPos -> bitmap word, filled by round trip 1 (hint) or round trip 1b. */
  words: Map<number, bigint>
}

/**
 * Fetch the full swap-relevant state of `pools` at `block`.
 *
 * Round trip 1: `slot0`, `liquidity` and (for hinted pools) the bitmap words
 * `[wordPos(hint) - k, wordPos(hint) + k]`, `k = cfg.TICK_WORDS_EACH_SIDE`, all in one extsload
 * batch set. Round trip 1b (only for pools whose hint was missing or whose actual window is not
 * fully covered): the missing words. Round trip 2: word 0 of `TickInfo` for every set bit in the
 * fetched words. The result's `tickWindow` is exactly the span of ticks whose bitmap word was
 * read (`wordTickSpan` of the lowest and highest word), so `ticks` is complete inside it and the
 * simulator knows where its knowledge ends; the pool's current tick always lies inside it.
 */
export async function fetchPoolStates(
  clients: RpcClients,
  cfg: Config,
  pools: readonly PoolInfo[],
  block: bigint,
  opts: FetchPoolStatesOptions = {},
): Promise<Map<Hex, PoolState>> {
  const result = new Map<Hex, PoolState>()
  if (pools.length === 0) return result
  const addresses = ADDRESSES[cfg.CHAIN_ID]
  if (!addresses) throw new Error(`fetchPoolStates: no addresses for chain ${cfg.CHAIN_ID}`)
  const poolManager = addresses.poolManager
  const k = cfg.TICK_WORDS_EACH_SIDE
  const limit = opts.limit ?? limiter(4)
  const read = (slots: Hex[]): Promise<Hex[]> => extsload(clients, poolManager, slots, block, { limit })

  // Round trip 1 ---------------------------------------------------------------------------
  const slots1: Hex[] = []
  const hintedWords = new Map<Hex, number[]>()
  for (const p of pools) {
    slots1.push(slot0Slot(p.poolId), liquiditySlot(p.poolId))
    const hint = opts.tickHints?.get(p.poolId)
    if (hint === undefined) continue
    const words = windowWords(wordPosOfTick(hint, p.tickSpacing), k, p.tickSpacing)
    hintedWords.set(p.poolId, words)
    for (const w of words) slots1.push(bitmapWordSlot(p.poolId, w))
  }
  const values1 = await read(slots1)
  const partials: Partial1[] = []
  let cursor = 0
  for (const p of pools) {
    const slot0 = decodeSlot0(at(values1, cursor++))
    const liquidity = decodeUint128(at(values1, cursor++))
    const words = new Map<number, bigint>()
    for (const w of hintedWords.get(p.poolId) ?? []) words.set(w, hexToBigInt(at(values1, cursor++)))
    partials.push({ info: p, ...slot0, liquidity, words })
  }

  // Round trip 1b: words the hint did not cover ---------------------------------------------
  const missing: Array<{ partial: Partial1; wordPos: number }> = []
  for (const partial of partials) {
    const wanted = windowWords(wordPosOfTick(partial.tick, partial.info.tickSpacing), k, partial.info.tickSpacing)
    for (const w of wanted) if (!partial.words.has(w)) missing.push({ partial, wordPos: w })
  }
  if (missing.length > 0) {
    const values = await read(missing.map((m) => bitmapWordSlot(m.partial.info.poolId, m.wordPos)))
    missing.forEach((m, i) => m.partial.words.set(m.wordPos, hexToBigInt(at(values, i))))
  }

  // Round trip 2: tick infos for every set bit in the window ---------------------------------
  const tickReads: Array<{ partial: Partial1; tick: number }> = []
  for (const partial of partials) {
    for (const w of activeWords(partial, k)) {
      for (const tick of ticksInWord(w, partial.words.get(w) ?? 0n, partial.info.tickSpacing)) {
        tickReads.push({ partial, tick })
      }
    }
  }
  const tickWords = tickReads.length > 0 ? await read(tickReads.map((t) => tickInfoSlot(t.partial.info.poolId, t.tick))) : []
  const ticksByPool = new Map<Hex, Map<number, TickData>>()
  tickReads.forEach((t, i) => {
    let m = ticksByPool.get(t.partial.info.poolId)
    if (!m) ticksByPool.set(t.partial.info.poolId, (m = new Map()))
    m.set(t.tick, decodeTickWord(at(tickWords, i)))
  })

  for (const partial of partials) {
    const active = activeWords(partial, k)
    const first = active[0]
    const last = active[active.length - 1]
    if (first === undefined || last === undefined) throw new Error(`fetchPoolStates: empty window for ${partial.info.poolId}`)
    const ticks = ticksByPool.get(partial.info.poolId) ?? new Map<number, TickData>()
    result.set(partial.info.poolId, {
      poolId: partial.info.poolId,
      block: Number(block),
      sqrtPriceX96: partial.sqrtPriceX96,
      tick: partial.tick,
      lpFee: partial.lpFee,
      protocolFee: partial.protocolFee,
      liquidity: partial.liquidity,
      tickSpacing: partial.info.tickSpacing,
      ticks: sortTicks(ticks),
      tickWindow: {
        lower: wordTickSpan(first, partial.info.tickSpacing).lower,
        upper: wordTickSpan(last, partial.info.tickSpacing).upper,
      },
    })
  }
  return result
}

/** Words `[center - k, center + k]` clipped to those that can hold ticks for this spacing, ascending. */
export function windowWords(center: number, k: number, tickSpacing: number): number[] {
  const bounds = wordPosBounds(tickSpacing)
  const words: number[] = []
  for (let w = center - k; w <= center + k; w++) if (w >= bounds.min && w <= bounds.max) words.push(w)
  return words
}

/** The words that form the window around the pool's *actual* tick (all present after round trip 1b). */
function activeWords(partial: Partial1, k: number): number[] {
  return windowWords(wordPosOfTick(partial.tick, partial.info.tickSpacing), k, partial.info.tickSpacing)
}

/** Rebuild a tick map in ascending tick order (Map iteration order is insertion order). */
export function sortTicks(ticks: Map<number, TickData>): Map<number, TickData> {
  return new Map([...ticks.entries()].sort((a, b) => a[0] - b[0]))
}

function at(values: readonly Hex[], i: number): Hex {
  const v = values[i]
  if (v === undefined) throw new Error(`fetchPoolStates: missing extsload value at index ${i}`)
  return v
}
