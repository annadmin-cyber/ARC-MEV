/**
 * Throughput micro-benchmark: how long does it take to evaluate 5,000 two-hop cycles with the
 * constant-product mock simulator? Not an assertion, just a log line so the per-block budget
 * (~500 ms on Arc) can be reasoned about. The real simulator is slower per call, so treat this as a
 * lower bound on cost.
 */
import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import type { PoolInfo, PoolState } from '../../src/types.js'
import { log } from '../../src/logger.js'
import { buildCycles } from '../../src/strategy/cycles.js'
import { evaluateAll } from '../../src/strategy/evaluate.js'
import { addr, cpmmSimulator, pid, poolInfo, stateFromReserves } from './helpers.js'

const E18 = 10n ** 18n

describe('throughput benchmark', () => {
  it('evaluates 5,000 two-hop cycles', () => {
    const start = addr(1)
    const pools: PoolInfo[] = []
    const states = new Map<Hex, PoolState>()
    // 2,500 tokens, each with two pools against `start` => 2 ordered 2-hop cycles per token.
    for (let t = 0; t < 2500; t++) {
      const token = addr(1000 + t)
      const idA = 2 * t + 1
      const idB = 2 * t + 2
      pools.push(poolInfo(idA, start, token, 3000), poolInfo(idB, start, token, 500))
      // Every 4th token has a 1% price gap (profitable one way); the rest are at parity.
      const gap = t % 4 === 0 ? 1_010_000n : 1_000_000n
      states.set(pid(idA), stateFromReserves(pid(idA), 1_000_000n * E18, gap * E18, 3000))
      states.set(pid(idB), stateFromReserves(pid(idB), 1_000_000n * E18, 1_000_000n * E18, 500))
    }
    const infos = new Map(pools.map((p) => [p.poolId, p]))
    const cycles = buildCycles(pools, new Set([start]), 2)
    expect(cycles).toHaveLength(5000)
    const opts = { minInput: E18 / 1000n, maxInput: 100_000n * E18, block: 1 }

    const t0 = performance.now()
    const opps = evaluateAll(cycles, states, infos, cpmmSimulator, opts)
    const withPrefilter = performance.now() - t0

    const t1 = performance.now()
    const oppsNoFilter = evaluateAll(cycles, states, infos, cpmmSimulator, { ...opts, spotPrefilter: false })
    const withoutPrefilter = performance.now() - t1

    expect(opps.map((o) => o.cycle.id)).toEqual(oppsNoFilter.map((o) => o.cycle.id))
    expect(opps.length).toBe(625)
    const evals = opps.reduce((n, o) => n + o.evaluations, 0)
    log.info(
      {
        cycles: cycles.length,
        opportunities: opps.length,
        withPrefilterMs: Math.round(withPrefilter),
        withoutPrefilterMs: Math.round(withoutPrefilter),
        usPerCycleWithPrefilter: Math.round((withPrefilter * 1000) / cycles.length),
        usPerCycleWithoutPrefilter: Math.round((withoutPrefilter * 1000) / cycles.length),
        usPerFullSearch: Math.round((withPrefilter * 1000) / opps.length),
        avgEvaluationsPerSearch: Math.round(evals / opps.length),
      },
      'strategy throughput benchmark',
    )
  }, 60_000)
})
