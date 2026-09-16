import type { Address, Hex } from 'viem'
import type { PoolInfo } from '../types.js'

/**
 * Undirected token graph: nodes are currencies, edges are pools. Several pools may connect the
 * same pair of currencies (different fee tiers / tick spacings / hooks), so an edge is a list.
 *
 * All collections are kept in a deterministic order (lexicographic by address / poolId) so that
 * cycle enumeration is stable across runs and across processes.
 */
export interface TokenGraph {
  /** poolId -> pool. */
  pools: Map<Hex, PoolInfo>
  /** pairKey(currencyA, currencyB) -> pools on that pair, sorted by poolId. */
  pairPools: Map<string, PoolInfo[]>
  /** currency -> neighbouring currencies (sorted). */
  neighbours: Map<Address, Address[]>
}

/** Canonical key for an unordered currency pair (order-independent). */
export function pairKey(a: Address, b: Address): string {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  return la < lb ? `${la}|${lb}` : `${lb}|${la}`
}

/** Lower-case a pool's addresses / ids so that graph lookups are canonical. */
function canonical(pool: PoolInfo): PoolInfo {
  return {
    ...pool,
    poolId: pool.poolId.toLowerCase() as Hex,
    currency0: pool.currency0.toLowerCase() as Address,
    currency1: pool.currency1.toLowerCase() as Address,
    hooks: pool.hooks.toLowerCase() as Address,
  }
}

/**
 * Build the token graph from a list of pools. Duplicate poolIds are collapsed (last one wins) and
 * degenerate pools whose two currencies are equal are ignored.
 */
export function buildGraph(pools: PoolInfo[]): TokenGraph {
  const byId = new Map<Hex, PoolInfo>()
  for (const raw of pools) {
    const pool = canonical(raw)
    if (pool.currency0 === pool.currency1) continue
    byId.set(pool.poolId, pool)
  }

  const pairPools = new Map<string, PoolInfo[]>()
  const neighbourSets = new Map<Address, Set<Address>>()
  for (const pool of byId.values()) {
    const key = pairKey(pool.currency0, pool.currency1)
    const list = pairPools.get(key)
    if (list) list.push(pool)
    else pairPools.set(key, [pool])
    addNeighbour(neighbourSets, pool.currency0, pool.currency1)
    addNeighbour(neighbourSets, pool.currency1, pool.currency0)
  }

  for (const list of pairPools.values()) list.sort((a, b) => (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0))
  const neighbours = new Map<Address, Address[]>()
  for (const [currency, set] of neighbourSets) neighbours.set(currency, [...set].sort())

  return { pools: byId, pairPools, neighbours }
}

function addNeighbour(sets: Map<Address, Set<Address>>, from: Address, to: Address): void {
  const set = sets.get(from)
  if (set) set.add(to)
  else sets.set(from, new Set([to]))
}

/** Pools connecting `a` and `b` (either order), sorted by poolId. Empty if none. */
export function poolsForPair(graph: TokenGraph, a: Address, b: Address): PoolInfo[] {
  return graph.pairPools.get(pairKey(a, b)) ?? []
}

/** Currencies reachable from `currency` in one hop, sorted. Empty if unknown. */
export function neighboursOf(graph: TokenGraph, currency: Address): Address[] {
  return graph.neighbours.get(currency.toLowerCase() as Address) ?? []
}

/** All currencies present in the graph, sorted. */
export function currenciesOf(graph: TokenGraph): Address[] {
  return [...graph.neighbours.keys()].sort()
}

/** The currency on the other side of `pool` from `currency`. Throws if `currency` is not in the pool. */
export function otherCurrency(pool: PoolInfo, currency: Address): Address {
  const c = currency.toLowerCase()
  if (c === pool.currency0) return pool.currency1
  if (c === pool.currency1) return pool.currency0
  throw new Error(`currency ${currency} is not in pool ${pool.poolId}`)
}

/**
 * Swap direction for entering `pool` with `input`: `zeroForOne` is true when the input is
 * currency0. Throws if `input` is not in the pool.
 */
export function directionFrom(pool: PoolInfo, input: Address): boolean {
  const c = input.toLowerCase()
  if (c === pool.currency0) return true
  if (c === pool.currency1) return false
  throw new Error(`currency ${input} is not in pool ${pool.poolId}`)
}

/** Input currency of a hop through `pool` in direction `zeroForOne`. */
export function inputCurrency(pool: PoolInfo, zeroForOne: boolean): Address {
  return zeroForOne ? pool.currency0 : pool.currency1
}

/** Output currency of a hop through `pool` in direction `zeroForOne`. */
export function outputCurrency(pool: PoolInfo, zeroForOne: boolean): Address {
  return zeroForOne ? pool.currency1 : pool.currency0
}
