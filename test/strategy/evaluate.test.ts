import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import type { PoolInfo, PoolState } from '../../src/types.js'
import { buildCycles, cyclesTouching } from '../../src/strategy/cycles.js'
import { effectiveSwapFee, evaluateAll, evaluateCycle, marginalRate } from '../../src/strategy/evaluate.js'
import { addr, cpmmSimulator, pid, poolInfo, stateFromReserves, truncatingAbove } from './helpers.js'

const E18 = 10n ** 18n
const A = addr(0xa)
const B = addr(0xb)
const C = addr(0xc)

const infos = new Map<Hex, PoolInfo>(
  [poolInfo(1, A, B), poolInfo(2, A, B, 500), poolInfo(3, B, C), poolInfo(4, C, A)].map((p) => [p.poolId, p]),
)

/** p1 prices B at 1.1 per A, p2 at 1.0 per A: buying B in p1 and selling in p2 is an arb. */
function arbStates(): Map<Hex, PoolState> {
  return new Map([
    [pid(1), stateFromReserves(pid(1), 1_000_000n * E18, 1_100_000n * E18, 3000)],
    [pid(2), stateFromReserves(pid(2), 1_000_000n * E18, 1_000_000n * E18, 500)],
    [pid(3), stateFromReserves(pid(3), 1_000_000n * E18, 1_000_000n * E18, 3000)],
    [pid(4), stateFromReserves(pid(4), 1_000_000n * E18, 1_000_000n * E18, 3000)],
  ])
}

const opts = { minInput: E18 / 1000n, maxInput: 100_000n * E18, block: 42 }
const cycles = buildCycles([...infos.values()], new Set([A]), 3)
const arbId = `2:${pid(1)}:1|${pid(2)}:0`
const reverseId = `2:${pid(2)}:1|${pid(1)}:0`
/** A -> B (P1, cheap B) -> C (P3, parity) -> A (P4, parity) is also profitable: 1.1 * 0.997^3 > 1. */
const triId = `3:${pid(1)}:1|${pid(3)}:1|${pid(4)}:0`
const byId = new Map(cycles.map((c) => [c.id, c]))

describe('evaluateCycle', () => {
  it('returns a positive opportunity for the profitable direction and null for the reverse', () => {
    const states = arbStates()
    const opp = evaluateCycle(byId.get(arbId)!, states, infos, cpmmSimulator, opts)
    expect(opp).not.toBeNull()
    expect(opp!.grossProfit).toBeGreaterThan(0n)
    expect(opp!.amountOut - opp!.amountIn).toBe(opp!.grossProfit)
    expect(opp!.block).toBe(42)
    expect(opp!.truncated).toBe(false)
    expect(opp!.cycle.id).toBe(arbId)
    expect(evaluateCycle(byId.get(reverseId)!, states, infos, cpmmSimulator, opts)).toBeNull()
    // Same answer with the prefilter off (the search itself finds no profit).
    expect(evaluateCycle(byId.get(reverseId)!, states, infos, cpmmSimulator, { ...opts, spotPrefilter: false })).toBeNull()
  })

  it('returns null when pools are at parity (fees make every cycle lose)', () => {
    const states = arbStates()
    states.set(pid(1), stateFromReserves(pid(1), 1_000_000n * E18, 1_000_000n * E18, 3000))
    for (const c of cycles) {
      expect(evaluateCycle(c, states, infos, cpmmSimulator, opts)).toBeNull()
      expect(evaluateCycle(c, states, infos, cpmmSimulator, { ...opts, spotPrefilter: false })).toBeNull()
    }
  })

  it('returns null on missing state, missing info, or a malformed cycle', () => {
    const states = arbStates()
    states.delete(pid(2))
    expect(evaluateCycle(byId.get(arbId)!, states, infos, cpmmSimulator, opts)).toBeNull()
    const fewerInfos = new Map(infos)
    fewerInfos.delete(pid(1))
    expect(evaluateCycle(byId.get(arbId)!, arbStates(), fewerInfos, cpmmSimulator, opts)).toBeNull()
    const broken = { ...byId.get(arbId)!, hops: [{ poolId: pid(1), zeroForOne: true }, { poolId: pid(3), zeroForOne: true }] }
    expect(evaluateCycle(broken, arbStates(), infos, cpmmSimulator, opts)).toBeNull()
    const open = { ...byId.get(arbId)!, hops: [{ poolId: pid(1), zeroForOne: true }] }
    expect(evaluateCycle(open, arbStates(), infos, cpmmSimulator, opts)).toBeNull()
    expect(evaluateCycle({ ...byId.get(arbId)!, hops: [] }, arbStates(), infos, cpmmSimulator, opts)).toBeNull()
  })

  it('treats truncated hops as a lower bound and marks the opportunity', () => {
    const states = arbStates()
    const full = evaluateCycle(byId.get(arbId)!, states, infos, cpmmSimulator, opts)!
    const limit = full.amountIn / 3n
    const sim = truncatingAbove(cpmmSimulator, limit)
    const trunc = evaluateCycle(byId.get(arbId)!, states, infos, sim, opts)!
    expect(trunc).not.toBeNull()
    // Beyond `limit` the output stops growing while the input keeps growing, so the best exact
    // input is at the limit and nothing larger can win.
    expect(trunc.amountIn).toBeLessThanOrEqual(limit)
    expect(trunc.grossProfit).toBeLessThan(full.grossProfit)
    expect(trunc.truncated).toBe(false)
    // If everything is truncated the sample is flagged.
    const alwaysTrunc = truncatingAbove(cpmmSimulator, 1n)
    const flagged = evaluateCycle(byId.get(arbId)!, states, infos, alwaysTrunc, { ...opts, minInput: 10n, maxInput: 100n })
    expect(flagged).toBeNull() // out(1 wei) after fees is 0, so no profit
  })

  it('survives a throwing simulator', () => {
    const boom = () => {
      throw new Error('boom')
    }
    expect(evaluateCycle(byId.get(arbId)!, arbStates(), infos, boom, opts)).toBeNull()
  })

  it('effectiveSwapFee follows Pool.swap semantics', () => {
    const s = arbStates().get(pid(1))!
    expect(effectiveSwapFee(s, true)).toBe(3000)
    const withProtocol = { ...s, protocolFee: (500 << 12) | 1000 }
    expect(effectiveSwapFee(withProtocol, true)).toBe(1000 + 3000 - Math.floor((1000 * 3000) / 1_000_000))
    expect(effectiveSwapFee(withProtocol, false)).toBe(500 + 3000 - Math.floor((500 * 3000) / 1_000_000))
    expect(marginalRate(s, true)).toBeCloseTo(1.1 * 0.997, 6)
    expect(marginalRate(s, false)).toBeCloseTo((1 / 1.1) * 0.997, 6)
  })
})

describe('evaluateAll', () => {
  it('evaluates every cycle, or only those touching given pools', () => {
    const states = arbStates()
    const all = evaluateAll(cycles, states, infos, cpmmSimulator, opts)
    expect(all.map((o) => o.cycle.id)).toEqual([arbId, triId])
    const index = cyclesTouching(cycles)
    const onlyP3 = evaluateAll(cycles, states, infos, cpmmSimulator, { ...opts, touched: new Set([pid(3)]), index })
    expect(onlyP3.map((o) => o.cycle.id)).toEqual([triId])
    const onlyP2 = evaluateAll(cycles, states, infos, cpmmSimulator, { ...opts, touched: new Set([pid(2)]), index })
    expect(onlyP2.map((o) => o.cycle.id)).toEqual([arbId])
    const p1 = evaluateAll(cycles, states, infos, cpmmSimulator, { ...opts, touched: new Set([pid(1)]) })
    expect(p1.map((o) => o.cycle.id)).toEqual([arbId, triId])
    expect(evaluateAll(cycles, states, infos, cpmmSimulator, { ...opts, touched: new Set() })).toEqual([])
  })
})
