import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { Cycle, PoolInfo } from '../../src/types.js'
import { buildCycles, cycleId, cyclesTouching, selectTouched } from '../../src/strategy/cycles.js'
import { buildGraph, inputCurrency, neighboursOf, outputCurrency, poolsForPair } from '../../src/strategy/graph.js'
import { addr, pid, poolInfo } from './helpers.js'

const S = addr(0xa)
const T = addr(0xb)
const U = addr(0xc)
const V = addr(0xd)

/** S-T has three pools, S-T-U and S-V-U are triangles, T-V is not connected. */
const POOLS: PoolInfo[] = [
  poolInfo(1, S, T, 500, 10),
  poolInfo(2, S, T, 3000, 60),
  poolInfo(3, T, S, 10000, 200),
  poolInfo(4, T, U),
  poolInfo(5, U, S),
  poolInfo(6, S, V),
  poolInfo(7, V, U),
]
const INFOS = new Map(POOLS.map((p) => [p.poolId, p]))

function assertWellFormed(cycle: Cycle): void {
  let current = cycle.start
  for (const hop of cycle.hops) {
    const info = INFOS.get(hop.poolId)
    expect(info, `pool ${hop.poolId} unknown`).toBeDefined()
    expect(inputCurrency(info as PoolInfo, hop.zeroForOne)).toBe(current)
    current = outputCurrency(info as PoolInfo, hop.zeroForOne)
  }
  expect(current).toBe(cycle.start)
  expect(cycle.id).toBe(cycleId(cycle.hops))
  const distinct = new Set(cycle.hops.map((h) => h.poolId))
  expect(distinct.size).toBe(cycle.hops.length)
}

describe('graph', () => {
  it('indexes pools per pair and neighbours deterministically', () => {
    const g = buildGraph([...POOLS].reverse())
    expect(poolsForPair(g, T, S).map((p) => p.poolId)).toEqual([pid(1), pid(2), pid(3)])
    expect(poolsForPair(g, S, T).map((p) => p.poolId)).toEqual([pid(1), pid(2), pid(3)])
    expect(poolsForPair(g, T, V)).toEqual([])
    expect(neighboursOf(g, S)).toEqual([T, U, V])
    expect(neighboursOf(g, V)).toEqual([S, U])
    expect(neighboursOf(g, addr(0xff))).toEqual([])
  })

  it('normalises casing and drops degenerate pools', () => {
    const upper = { ...poolInfo(9, S, T), currency0: S.toUpperCase() as Address, poolId: pid(9).toUpperCase() as Hex }
    const g = buildGraph([upper, poolInfo(10, S, S)])
    expect(g.pools.size).toBe(1)
    expect(poolsForPair(g, S, T)[0]?.poolId).toBe(pid(9))
  })
})

describe('buildCycles', () => {
  it('enumerates exactly the expected 2-hop cycles for one start currency', () => {
    const cycles = buildCycles(POOLS, new Set([S]), 2)
    expect(cycles).toHaveLength(6)
    const expected = new Set<string>()
    for (const a of [1, 2, 3]) {
      for (const b of [1, 2, 3]) {
        if (a !== b) expected.add(`2:${pid(a)}:1|${pid(b)}:0`)
      }
    }
    expect(new Set(cycles.map((c) => c.id))).toEqual(expected)
    for (const c of cycles) {
      expect(c.start).toBe(S)
      assertWellFormed(c)
    }
  })

  it('enumerates 3-hop triangles in both orientations with all pool combinations', () => {
    const cycles = buildCycles(POOLS, new Set([S]), 3)
    expect(cycles).toHaveLength(14)
    const three = cycles.filter((c) => c.hops.length === 3)
    expect(three).toHaveLength(8)
    // S -> T (P1..P3) -> U (P4) -> S (P5): 3 cycles; reverse S -> U (P5) -> T (P4) -> S (P1..P3): 3.
    expect(three.filter((c) => c.id === `3:${pid(2)}:1|${pid(4)}:1|${pid(5)}:0`)).toHaveLength(1)
    expect(three.filter((c) => c.id === `3:${pid(5)}:1|${pid(4)}:0|${pid(2)}:0`)).toHaveLength(1)
    // S -> V (P6) -> U (P7) -> S (P5) and its reverse.
    expect(three.filter((c) => c.id === `3:${pid(6)}:1|${pid(7)}:0|${pid(5)}:0`)).toHaveLength(1)
    expect(three.filter((c) => c.id === `3:${pid(5)}:1|${pid(7)}:1|${pid(6)}:0`)).toHaveLength(1)
    for (const c of cycles) assertWellFormed(c)
  })

  it('produces no duplicate ids across several start currencies and is deterministic', () => {
    const a = buildCycles(POOLS, new Set([T, S]), 3)
    const b = buildCycles([...POOLS].reverse(), new Set([S, T]), 3)
    expect(a).toHaveLength(26)
    expect(new Set(a.map((c) => c.id)).size).toBe(26)
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id))
    for (const c of a) assertWellFormed(c)
    expect(a.filter((c) => c.start === T)).toHaveLength(12)
  })

  it('ignores start currencies that are not in the graph and pairs without a second pool', () => {
    expect(buildCycles(POOLS, new Set([addr(0xee)]), 3)).toEqual([])
    expect(buildCycles(POOLS, new Set([V]), 2)).toEqual([])
  })

  it('caps the number of cycles', () => {
    const cycles = buildCycles(POOLS, new Set([S, T]), 3, { maxCycles: 5 })
    expect(cycles).toHaveLength(5)
  })
})

describe('cyclesTouching / selectTouched', () => {
  const cycles = buildCycles(POOLS, new Set([S]), 3)
  const index = cyclesTouching(cycles)

  it('lists every cycle under each pool it uses, once', () => {
    for (const [poolId, list] of index) {
      for (const c of list) expect(c.hops.some((h) => h.poolId === poolId)).toBe(true)
      expect(new Set(list.map((c) => c.id)).size).toBe(list.length)
    }
    // P1 is in 4 two-hop cycles (paired with P2, P3 in both orders) and 2 three-hop cycles.
    expect(index.get(pid(1))).toHaveLength(6)
    // P4 (T-U) is only in the S-T-U triangles: 6 cycles.
    expect(index.get(pid(4))).toHaveLength(6)
    expect(index.get(pid(99))).toBeUndefined()
    const total = [...index.values()].reduce((n, l) => n + l.length, 0)
    expect(total).toBe(cycles.reduce((n, c) => n + c.hops.length, 0))
  })

  it('selects affected cycles with or without the index, preserving order', () => {
    const touched = new Set<Hex>([pid(6), pid(99)])
    const withIndex = selectTouched(cycles, touched, index)
    const withoutIndex = selectTouched(cycles, touched)
    expect(withIndex.map((c) => c.id)).toEqual(withoutIndex.map((c) => c.id))
    expect(withIndex).toHaveLength(2)
    expect(selectTouched(cycles, new Set(), index)).toEqual([])
  })
})
