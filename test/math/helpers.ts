import type { Hex } from 'viem'
import type { PoolState, TickData } from '../../src/types.js'
import { MAX_TICK, MIN_TICK } from '../../src/math/tickMath.js'
import { simPools, simTicks } from './fixtures.js'

export const FULL_WINDOW = { lower: MIN_TICK, upper: MAX_TICK }

/** Builds a PoolState from the Foundry SimVectors pool named `name`. */
export function fixtureState(name: string, window: { lower: number; upper: number } = FULL_WINDOW): PoolState & {
  tickSpacing: number
} {
  const pool = simPools.find((p) => p.name === name)
  if (!pool) throw new Error(`no fixture pool ${name}`)
  const ticks = new Map<number, TickData>()
  for (const t of simTicks) {
    if (t.pool !== name) continue
    if (t.liquidityGross === 0n) continue
    ticks.set(t.tick, { liquidityNet: t.liquidityNet, liquidityGross: t.liquidityGross })
  }
  return {
    poolId: `0x${name.padEnd(64, '0')}` as Hex,
    block: 0,
    sqrtPriceX96: pool.sqrtPriceX96,
    tick: pool.tick,
    lpFee: pool.lpFee,
    protocolFee: pool.protocolFee,
    liquidity: pool.liquidity,
    ticks,
    tickWindow: window,
    tickSpacing: pool.tickSpacing,
  }
}

/** A pool state with the given liquidity in one range [lower, upper] at the given price. */
export function singleRangeState(opts: {
  liquidity: bigint
  lower: number
  upper: number
  sqrtPriceX96: bigint
  tick: number
  lpFee: number
  protocolFee?: number
  window?: { lower: number; upper: number }
  tickSpacing?: number
}): PoolState {
  const ticks = new Map<number, TickData>([
    [opts.lower, { liquidityNet: opts.liquidity, liquidityGross: opts.liquidity }],
    [opts.upper, { liquidityNet: -opts.liquidity, liquidityGross: opts.liquidity }],
  ])
  const inRange = opts.tick >= opts.lower && opts.tick < opts.upper
  return {
    poolId: '0x01' as Hex,
    block: 0,
    sqrtPriceX96: opts.sqrtPriceX96,
    tick: opts.tick,
    lpFee: opts.lpFee,
    protocolFee: opts.protocolFee ?? 0,
    liquidity: inRange ? opts.liquidity : 0n,
    tickSpacing: opts.tickSpacing ?? 60,
    ticks,
    tickWindow: opts.window ?? FULL_WINDOW,
  }
}

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
