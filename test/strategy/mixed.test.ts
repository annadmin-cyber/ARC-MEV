/**
 * Cross-kind evaluation: cycles over v4, v3-style and v2-style pools are enumerated together and
 * evaluated with the kind-dispatching simulator (`makeSimulator` from `src/math/hop.ts`).
 */
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { makeSimulator, simulateHop } from '../../src/math/hop.js'
import { simulateExactInput } from '../../src/math/simulate.js'
import { buildCycles } from '../../src/strategy/cycles.js'
import { evaluateAll, evaluateCycle } from '../../src/strategy/evaluate.js'
import { rankOpportunities } from '../../src/strategy/rank.js'
import { addressToPoolId, type PoolInfo, type PoolState } from '../../src/types.js'
import { addr, isqrt, pid, Q96, stateFromReserves } from './helpers.js'

const E18 = 10n ** 18n
const A = addr(0xa)
const B = addr(0xb)
const V3_POOL: Address = addr(0x3333)
const V2_PAIR: Address = addr(0x2222)

/** Hookless v4 pool, a v3-style pool and a v2-style pair, all on (A, B). */
const V4: PoolInfo = { poolId: pid(1), currency0: A, currency1: B, fee: 3000, tickSpacing: 60, hooks: addr(0), block: 1 }
const V3: PoolInfo = { poolId: addressToPoolId(V3_POOL), currency0: A, currency1: B, fee: 500, tickSpacing: 10, hooks: addr(0), block: 1, kind: 1, pool: V3_POOL, venue: 'uniswap-v3' }
const V2: PoolInfo = { poolId: addressToPoolId(V2_PAIR), currency0: A, currency1: B, fee: 3000, tickSpacing: 0, hooks: addr(0), block: 1, kind: 2, pool: V2_PAIR, venue: 'uniswap-v2' }
const INFOS = new Map<Hex, PoolInfo>([V4, V3, V2].map((p) => [p.poolId, p]))

/** A full-range position priced at `price1Per0` (B per A) with virtual reserves ~1M. */
function fullRange(info: PoolInfo, price1Per0: number): PoolState {
  const r0 = 1_000_000n * E18
  const r1 = BigInt(Math.round(price1Per0 * 1e6)) * E18
  const s = stateFromReserves(info.poolId, r0, r1, info.fee)
  return { ...s, tickSpacing: info.tickSpacing || 1, tickWindow: { lower: -887272, upper: 887272 } }
}

function v2State(info: PoolInfo, reserve0: bigint, reserve1: bigint): PoolState {
  const sqrtPriceX96 = isqrt((reserve1 * Q96 * Q96) / reserve0)
  return {
    poolId: info.poolId,
    block: 1,
    sqrtPriceX96,
    tick: Math.floor(Math.log((Number(sqrtPriceX96) / Number(Q96)) ** 2) / Math.log(1.0001)),
    lpFee: info.fee,
    protocolFee: 0,
    liquidity: isqrt(reserve0 * reserve1),
    tickSpacing: 0,
    ticks: new Map(),
    tickWindow: { lower: -887272, upper: 887272 },
    reserves: { reserve0, reserve1 },
  }
}

describe('kind-dispatching simulation', () => {
  it('simulates a v2 pair by the constant-product formula and a v3 pool like v4 with protocol fee 0', () => {
    const v2 = v2State(V2, 1_000_000n * E18, 2_000_000n * E18)
    const sim = makeSimulator(INFOS)
    const out = sim(v2, true, 1000n * E18)
    // 1000 * 0.997 * 2M / (1M + 997) = 1992.01... B
    expect(out.amountOut).toBe((1000n * E18 * 997_000n * 2_000_000n * E18) / (1_000_000n * E18 * 1_000_000n + 1000n * E18 * 997_000n))
    expect(out.truncated).toBe(false)
    const v3 = { ...fullRange(V3, 1), protocolFee: (500 << 12) | 500 }
    expect(sim(v3, true, E18)).toEqual(simulateExactInput({ ...v3, protocolFee: 0 }, true, E18))
    expect(sim(v3, true, E18).amountOut).toBeGreaterThan(simulateExactInput(v3, true, E18).amountOut)
    expect(simulateHop(V4, fullRange(V4, 1), false, E18)).toEqual(simulateExactInput(fullRange(V4, 1), false, E18))
  })

  it('finds and ranks arbitrage across all three kinds', () => {
    // B is cheapest on the v2 pair (2.2 B per A), then v3 (2.0), dearest on v4 (1.8): buy B on v2, sell on v4.
    const states = new Map<Hex, PoolState>([
      [V4.poolId, fullRange(V4, 1.8)],
      [V3.poolId, fullRange(V3, 2.0)],
      [V2.poolId, v2State(V2, 1_000_000n * E18, 2_200_000n * E18)],
    ])
    const cycles = buildCycles([...INFOS.values()], new Set([A]), 2)
    expect(cycles).toHaveLength(6)
    const opts = { minInput: E18 / 100n, maxInput: 100_000n * E18, block: 9 }
    const opps = rankOpportunities(evaluateAll(cycles, states, INFOS, makeSimulator(INFOS), opts), new Map([[A, 18]]))
    expect(opps.length).toBeGreaterThanOrEqual(1)
    const best = opps[0]!
    expect(best.cycle.hops.map((h) => h.poolId)).toEqual([V2.poolId, V4.poolId])
    expect(best.grossProfit).toBeGreaterThan(0n)
    // Ranking keeps at most one cycle per pool: v2 and v4 are taken by the best, only v3-only cycles could follow.
    for (const other of opps.slice(1)) expect(other.cycle.hops.every((h) => h.poolId !== V2.poolId && h.poolId !== V4.poolId)).toBe(true)
    // The reverse direction loses.
    const reverse = cycles.find((c) => c.hops[0]!.poolId === V4.poolId && c.hops[1]!.poolId === V2.poolId)!
    expect(evaluateCycle(reverse, states, INFOS, makeSimulator(INFOS), opts)).toBeNull()
    // Sanity: the profit is reproducible by chaining the two hops by hand.
    const hop1 = simulateHop(V2, states.get(V2.poolId)!, true, best.amountIn)
    const hop2 = simulateHop(V4, states.get(V4.poolId)!, false, hop1.amountOut)
    expect(hop2.amountOut - best.amountIn).toBe(best.grossProfit)
  })

  it('a v2 pair without reserves never produces an opportunity', () => {
    const { reserves: _drop, ...noReserves } = v2State(V2, 1_000_000n * E18, 2_200_000n * E18)
    const states = new Map<Hex, PoolState>([
      [V4.poolId, fullRange(V4, 1.8)],
      [V2.poolId, noReserves],
    ])
    const cycles = buildCycles([V4, V2], new Set([A]), 2)
    expect(evaluateAll(cycles, states, INFOS, makeSimulator(INFOS), { minInput: 1n, maxInput: 100n * E18, block: 1 })).toEqual([])
  })
})
