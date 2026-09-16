import type { Address, Hex } from 'viem'
import { log } from '../logger.js'
import type { Cycle, Hop, PoolInfo } from '../types.js'
import { buildGraph, directionFrom, neighboursOf, poolsForPair, type TokenGraph } from './graph.js'

/** Default hard cap on the number of cycles `buildCycles` returns. */
export const DEFAULT_MAX_CYCLES = 50_000

export interface BuildCyclesOptions {
  /** Stop enumerating once this many cycles exist (default `DEFAULT_MAX_CYCLES`). */
  maxCycles?: number
}

/**
 * Stable identifier for a hop sequence: `"<hops>:<poolId>:<zfo>|<poolId>:<zfo>..."` where
 * `zfo` is `1` for zeroForOne and `0` otherwise. The start currency is implied by the first hop.
 */
export function cycleId(hops: Hop[]): string {
  return `${hops.length}:${hops.map((h) => `${h.poolId}:${h.zeroForOne ? 1 : 0}`).join('|')}`
}

/**
 * Enumerate closed arbitrage cycles starting (and ending) in one of `startCurrencies`.
 *
 * - 2-hop cycles: S -> T through pool P1 and T -> S through pool P2, for every ordered pair of
 *   distinct pools on the same (S, T) pair. Both orderings are produced because direction matters.
 * - 3-hop cycles (when `maxHops === 3`): S -> A -> B -> S over every triangle of currencies, with
 *   every combination of pools on the three edges. Both orientations of a triangle are produced.
 *
 * Enumeration is deterministic (sorted by currency address and poolId) so cycle ids are stable
 * across runs. The total is capped at `opts.maxCycles`; a warning is logged if truncation happens.
 */
export function buildCycles(
  pools: PoolInfo[],
  startCurrencies: Set<Address>,
  maxHops: 2 | 3,
  opts: BuildCyclesOptions = {},
): Cycle[] {
  const maxCycles = opts.maxCycles ?? DEFAULT_MAX_CYCLES
  const graph = buildGraph(pools)
  const starts = [...startCurrencies].map((c) => c.toLowerCase() as Address).sort()
  const out: Cycle[] = []
  const seen = new Set<string>()
  let truncated = false

  const push = (start: Address, hops: Hop[]): boolean => {
    if (out.length >= maxCycles) {
      truncated = true
      return false
    }
    const id = cycleId(hops)
    if (seen.has(id)) return true
    seen.add(id)
    out.push({ id, start, hops })
    return true
  }

  outer: for (const start of starts) {
    for (const cycle of twoHopCycles(graph, start)) {
      if (!push(start, cycle)) break outer
    }
    if (maxHops < 3) continue
    for (const cycle of threeHopCycles(graph, start)) {
      if (!push(start, cycle)) break outer
    }
  }

  if (truncated) {
    log.warn({ maxCycles, starts: starts.length, pools: graph.pools.size }, 'cycle enumeration truncated at maxCycles')
  }
  return out
}

/** Yields hop lists S -> T -> S over every ordered pair of distinct pools on a common pair. */
function* twoHopCycles(graph: TokenGraph, start: Address): Generator<Hop[]> {
  for (const mid of neighboursOf(graph, start)) {
    const pools = poolsForPair(graph, start, mid)
    for (const p1 of pools) {
      for (const p2 of pools) {
        if (p1.poolId === p2.poolId) continue
        yield [
          { poolId: p1.poolId, zeroForOne: directionFrom(p1, start) },
          { poolId: p2.poolId, zeroForOne: directionFrom(p2, mid) },
        ]
      }
    }
  }
}

/** Yields hop lists S -> A -> B -> S for every triangle containing `start` and every pool combination. */
function* threeHopCycles(graph: TokenGraph, start: Address): Generator<Hop[]> {
  for (const a of neighboursOf(graph, start)) {
    if (a === start) continue
    const poolsSA = poolsForPair(graph, start, a)
    for (const b of neighboursOf(graph, a)) {
      if (b === start || b === a) continue
      const poolsBS = poolsForPair(graph, b, start)
      if (poolsBS.length === 0) continue
      const poolsAB = poolsForPair(graph, a, b)
      for (const p1 of poolsSA) {
        for (const p2 of poolsAB) {
          for (const p3 of poolsBS) {
            yield [
              { poolId: p1.poolId, zeroForOne: directionFrom(p1, start) },
              { poolId: p2.poolId, zeroForOne: directionFrom(p2, a) },
              { poolId: p3.poolId, zeroForOne: directionFrom(p3, b) },
            ]
          }
        }
      }
    }
  }
}

/** Index cycles by every pool they touch, so a block loop can re-evaluate only affected cycles. */
export function cyclesTouching(cycles: Cycle[]): Map<Hex, Cycle[]> {
  const index = new Map<Hex, Cycle[]>()
  for (const cycle of cycles) {
    const poolsInCycle = new Set(cycle.hops.map((h) => h.poolId))
    for (const poolId of poolsInCycle) {
      const list = index.get(poolId)
      if (list) list.push(cycle)
      else index.set(poolId, [cycle])
    }
  }
  return index
}

/**
 * The subset of `cycles` that touch at least one pool in `touched`, each cycle at most once, in the
 * original order of `cycles`. Uses `index` (from `cyclesTouching`) when given, otherwise scans.
 */
export function selectTouched(cycles: Cycle[], touched: Set<Hex>, index?: Map<Hex, Cycle[]>): Cycle[] {
  if (touched.size === 0) return []
  if (!index) return cycles.filter((c) => c.hops.some((h) => touched.has(h.poolId)))
  const ids = new Set<string>()
  for (const poolId of touched) {
    for (const cycle of index.get(poolId) ?? []) ids.add(cycle.id)
  }
  return cycles.filter((c) => ids.has(c.id))
}
