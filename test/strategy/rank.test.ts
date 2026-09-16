import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { Opportunity } from '../../src/types.js'
import { from18, rankOpportunities, to18 } from '../../src/strategy/rank.js'
import { addr, pid } from './helpers.js'

const NATIVE = addr(0)
const USDC6 = addr(0x36)
const OTHER = addr(0x99)
const decimals = new Map<Address, number>([
  [NATIVE, 18],
  [USDC6, 6],
])

function opp(id: string, start: Address, pools: number[], grossProfit: bigint): Opportunity {
  return {
    cycle: { id, start, hops: pools.map((p) => ({ poolId: pid(p), zeroForOne: true })) },
    amountIn: 10n ** 18n,
    amountOut: 10n ** 18n + grossProfit,
    grossProfit,
    block: 1,
  }
}

describe('rankOpportunities', () => {
  it('normalises 6-decimal and 18-decimal start currencies to 18-decimal USDC', () => {
    const a = opp('a', USDC6, [1, 2], 1_000_000n) // 1 USDC
    const b = opp('b', NATIVE, [3, 4], 5n * 10n ** 17n) // 0.5 USDC
    const ranked = rankOpportunities([b, a], decimals)
    expect(ranked.map((o) => o.cycle.id)).toEqual(['a', 'b'])
    expect(ranked[0]?.grossProfitUsdc).toBe(10n ** 18n)
    expect(ranked[1]?.grossProfitUsdc).toBe(5n * 10n ** 17n)
    // Input untouched.
    expect(a.grossProfitUsdc).toBeUndefined()
  })

  it('drops opportunities sharing a pool with a better one, keeping disjoint ones', () => {
    const best = opp('best', NATIVE, [1, 2], 3n * 10n ** 18n)
    const overlap = opp('overlap', NATIVE, [2, 5, 6], 2n * 10n ** 18n)
    const disjoint = opp('disjoint', USDC6, [7, 8], 1_500_000n)
    const overlapDisjoint = opp('overlap2', NATIVE, [8, 9], 10n ** 18n)
    const ranked = rankOpportunities([overlap, overlapDisjoint, disjoint, best], decimals)
    expect(ranked.map((o) => o.cycle.id)).toEqual(['best', 'disjoint'])
  })

  it('sorts unpriced start currencies last and breaks ties by cycle id', () => {
    const priced = opp('priced', USDC6, [1, 2], 1n)
    const un1 = opp('z', OTHER, [3, 4], 100n)
    const un2 = opp('y', OTHER, [5, 6], 100n)
    const un3 = opp('x', OTHER, [7, 8], 50n)
    const ranked = rankOpportunities([un3, un1, un2, priced], decimals)
    expect(ranked.map((o) => o.cycle.id)).toEqual(['priced', 'y', 'z', 'x'])
    expect(ranked[1]?.grossProfitUsdc).toBeUndefined()
  })

  it('to18 / from18 scale both directions', () => {
    expect(to18(1_000_000n, 6)).toBe(10n ** 18n)
    expect(to18(10n ** 18n, 18)).toBe(10n ** 18n)
    expect(to18(10n ** 24n, 24)).toBe(10n ** 18n)
    expect(from18(10n ** 18n, 6)).toBe(1_000_000n)
    expect(from18(10n ** 18n, 24)).toBe(10n ** 24n)
    expect(from18(999n, 6)).toBe(0n)
  })
})
