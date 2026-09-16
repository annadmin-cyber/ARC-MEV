import { describe, expect, it } from 'vitest'
import type { PoolState } from '../../src/types.js'
import {
  MAX_PRICE_LIMIT,
  MIN_PRICE_LIMIT,
  inferTickSpacing,
  simulateExactInput,
  simulateExactOutput,
} from '../../src/math/simulate.js'
import { getAmount0Delta, getAmount1Delta } from '../../src/math/sqrtPriceMath.js'
import { MAX_TICK, MIN_TICK, getSqrtPriceAtTick, getTickAtSqrtPrice } from '../../src/math/tickMath.js'
import { simPools, simSwaps } from './fixtures.js'
import { FULL_WINDOW, fixtureState, rng, singleRangeState } from './helpers.js'

const P1 = 1n << 96n

describe('simulateExactInput vs real PoolManager (SimVectors.t.sol)', () => {
  const exactIn = simSwaps.filter((s) => s.amountSpecified < 0n)
  const exactOut = simSwaps.filter((s) => s.amountSpecified > 0n)

  it('has vectors for every fixture pool', () => {
    expect(simPools.map((p) => p.name)).toEqual(['main', 'afterA', 'pf'])
    expect(exactIn.length).toBeGreaterThanOrEqual(6)
    expect(exactOut.length).toBeGreaterThanOrEqual(2)
  })

  for (const v of exactIn) {
    it(`${v.pool} ${v.zeroForOne ? '0->1' : '1->0'} exact input ${v.amountSpecified} reproduces the chain exactly`, () => {
      const state = fixtureState(v.pool)
      const r = simulateExactInput(state, v.zeroForOne, -v.amountSpecified, { tickSpacing: state.tickSpacing })
      const chainIn = -(v.zeroForOne ? v.amount0 : v.amount1)
      const chainOut = v.zeroForOne ? v.amount1 : v.amount0
      expect(r.amountOut).toBe(chainOut)
      expect(r.amountIn).toBe(chainIn)
      expect(r.sqrtPriceX96After).toBe(v.sqrtPriceX96After)
      expect(r.tickAfter).toBe(v.tickAfter)
      expect(r.liquidityAfter).toBe(v.liquidityAfter)
      // partial fills (all liquidity exhausted, price at the limit) are the only truncated cases
      expect(r.truncated).toBe(chainIn !== -v.amountSpecified)
    })

    it(`${v.pool} ${v.zeroForOne ? '0->1' : '1->0'} exact input ${v.amountSpecified} with state.tickSpacing / inferred spacing`, () => {
      const state = fixtureState(v.pool)
      // state carries tickSpacing (duck-typed): used automatically
      const r = simulateExactInput(state, v.zeroForOne, -v.amountSpecified)
      expect(r.amountOut).toBe(v.zeroForOne ? v.amount1 : v.amount0)
      // without it, the spacing is inferred as a multiple of the real one; these swaps cross no
      // other word boundary than tick 0, so the result is still exact
      const inferred = inferTickSpacing(state)
      expect(inferred % state.tickSpacing).toBe(0)
      const { tickSpacing: _omit, ...bare } = state
      const b = simulateExactInput(bare as unknown as PoolState, v.zeroForOne, -v.amountSpecified)
      expect(b.amountOut).toBe(v.zeroForOne ? v.amount1 : v.amount0)
    })
  }

  for (const v of exactOut) {
    it(`${v.pool} ${v.zeroForOne ? '0->1' : '1->0'} exact output ${v.amountSpecified} reproduces the chain exactly`, () => {
      const state = fixtureState(v.pool)
      const r = simulateExactOutput(state, v.zeroForOne, v.amountSpecified, { tickSpacing: state.tickSpacing })
      expect(r.amountOut).toBe(v.amountSpecified)
      expect(r.amountIn).toBe(-(v.zeroForOne ? v.amount0 : v.amount1))
      expect(r.sqrtPriceX96After).toBe(v.sqrtPriceX96After)
      expect(r.tickAfter).toBe(v.tickAfter)
      expect(r.liquidityAfter).toBe(v.liquidityAfter)
      expect(r.truncated).toBe(false)
    })
  }

  it('the post-swap state can be chained: main + (0->1, 1e18) equals the afterA fixture', () => {
    const main = fixtureState('main')
    const r = simulateExactInput(main, true, 1_000_000_000_000_000_000n, { tickSpacing: 60 })
    const afterA = fixtureState('afterA')
    expect(r.sqrtPriceX96After).toBe(afterA.sqrtPriceX96)
    expect(r.tickAfter).toBe(afterA.tick)
    expect(r.liquidityAfter).toBe(afterA.liquidity)
    const chained: PoolState = { ...main, sqrtPriceX96: r.sqrtPriceX96After, tick: r.tickAfter, liquidity: r.liquidityAfter }
    for (const v of exactIn.filter((s) => s.pool === 'afterA')) {
      const c = simulateExactInput(chained, v.zeroForOne, -v.amountSpecified, { tickSpacing: 60 })
      expect(c.amountOut).toBe(v.zeroForOne ? v.amount1 : v.amount0)
    }
  })

  it('LP fee accounting: total fee equals input minus principal, protocol share removed', () => {
    // fee-free pool: fee = amountIn - sum(step.amountIn); with 0.30% the fee is ~0.3% of input
    const main = fixtureState('main')
    const r = simulateExactInput(main, true, 1_000_000_000_000_000_000n, { tickSpacing: 60 })
    expect(r.feeAmount).toBeGreaterThanOrEqual(2_990_000_000_000_000n)
    expect(r.feeAmount).toBeLessThanOrEqual(3_010_000_000_000_000n)
    // protocol-fee pool: swap fee 999 pips of which 500 go to the protocol
    const pf = fixtureState('pf')
    const p = simulateExactInput(pf, true, 1_000_000_000_000_000_000n, { tickSpacing: 10 })
    expect(p.feeAmount).toBeGreaterThanOrEqual(490_000_000_000_000n)
    expect(p.feeAmount).toBeLessThanOrEqual(510_000_000_000_000n)
  })
})

describe('simulateExactInput closed form (single wide range, 1:1)', () => {
  const L = 10n ** 24n
  const lower = -887220
  const upper = 887220
  const state = singleRangeState({ liquidity: L, lower, upper, sqrtPriceX96: P1, tick: 0, lpFee: 3000 })

  // Constant product with virtual reserves x = L / sqrtP, y = L * sqrtP; at 1:1 both equal L.
  // out = y - L^2 / (x + inLessFee) = L * inLessFee / (L + inLessFee)
  const closedForm = (amountIn: bigint, feePips: bigint) => {
    const inLessFee = (amountIn * (1_000_000n - feePips)) / 1_000_000n
    return (L * inLessFee) / (L + inLessFee)
  }

  it('matches the constant-product formula within 1 wei in both directions', () => {
    const amounts = [1n, 1000n, 10n ** 12n, 10n ** 18n, 12345678901234567890n, 10n ** 21n, 10n ** 23n, 5n * 10n ** 24n]
    for (const amountIn of amounts) {
      for (const zeroForOne of [true, false]) {
        const r = simulateExactInput(state, zeroForOne, amountIn, { tickSpacing: 60 })
        const expected = closedForm(amountIn, 3000n)
        const diff = r.amountOut > expected ? r.amountOut - expected : expected - r.amountOut
        expect(diff <= 1n, `amountIn=${amountIn} zfo=${zeroForOne} got ${r.amountOut} expected ${expected}`).toBe(true)
        expect(r.amountOut <= expected, 'rounding must favour the pool').toBe(true)
        expect(r.truncated).toBe(false)
        expect(r.amountIn).toBe(amountIn)
        expect(r.liquidityAfter).toBe(L)
        // like Pool.swap, after stepping left across a word boundary the tick may be one below the price's tick
        const priceTick = getTickAtSqrtPrice(r.sqrtPriceX96After)
        expect([priceTick, zeroForOne ? priceTick - 1 : priceTick]).toContain(r.tickAfter)
      }
    }
  })

  it('fee-free pool matches the closed form exactly to 1 wei with fee 0', () => {
    const free = { ...state, lpFee: 0 }
    const r = simulateExactInput(free, true, 10n ** 20n, { tickSpacing: 60 })
    const expected = closedForm(10n ** 20n, 0n)
    expect(expected - r.amountOut <= 1n).toBe(true)
    expect(r.feeAmount).toBe(0n)
  })
})

describe('multi-tick walk', () => {
  // main pool: L=100e18 on [-600,600], 50e18 on [-120,180], 30e18 on [60,1200], price 1:1 (tick 0), fee 0.30%, spacing 60
  const E18 = 10n ** 18n

  it('crosses ticks and applies liquidityNet with the right sign', () => {
    const state = fixtureState('main')
    const small = simulateExactInput(state, true, E18 / 100n, { tickSpacing: 60 })
    expect(small.liquidityAfter).toBe(150n * E18)
    expect(small.tickAfter).toBe(-2)

    const crossOne = simulateExactInput(state, true, E18, { tickSpacing: 60 })
    expect(crossOne.liquidityAfter).toBe(100n * E18) // crossed -120 leftwards: -(+50e18)
    expect(crossOne.tickAfter).toBeLessThan(-120)

    const up1 = simulateExactInput(state, false, E18, { tickSpacing: 60 })
    expect(up1.liquidityAfter).toBe(180n * E18) // crossed 60 rightwards: +30e18
    const up3 = simulateExactInput(state, false, 3n * E18, { tickSpacing: 60 })
    expect(up3.liquidityAfter).toBe(130n * E18) // crossed 60 (+30e18) and 180 (-50e18)
    expect(up3.tickAfter).toBeGreaterThan(180)
    expect(up3.tickAfter).toBeLessThan(600)
  })

  it('landing exactly on an initialised tick sets tick = next - 1 for zeroForOne', () => {
    const state = fixtureState('main')
    // find the exact input that lands on tick -120 by swapping to that price with exact output logic:
    // amountIn needed = getAmount0Delta(price(-120), P1, 150e18, roundUp) grossed up by the fee.
    const principal = getAmount0Delta(getSqrtPriceAtTick(-120), P1, 150n * E18, true)
    const fee = (principal * 3000n + (1_000_000n - 3000n) - 1n) / (1_000_000n - 3000n)
    const r = simulateExactInput(state, true, principal + fee, { tickSpacing: 60 })
    expect(r.sqrtPriceX96After).toBe(getSqrtPriceAtTick(-120))
    expect(r.tickAfter).toBe(-121)
    expect(r.liquidityAfter).toBe(100n * E18)
    expect(r.truncated).toBe(false)
  })

  it('output is monotone non-decreasing in input and bounded by the token the pool holds', () => {
    const state = fixtureState('main')
    // token1 held by ranges at/below the current price
    const token1Available =
      getAmount1Delta(getSqrtPriceAtTick(-600), P1, 100n * E18, false) +
      getAmount1Delta(getSqrtPriceAtTick(-120), P1, 50n * E18, false)
    const token0Available =
      getAmount0Delta(P1, getSqrtPriceAtTick(600), 100n * E18, false) +
      getAmount0Delta(P1, getSqrtPriceAtTick(180), 50n * E18, false) +
      getAmount0Delta(getSqrtPriceAtTick(60), getSqrtPriceAtTick(1200), 30n * E18, false)
    for (const zeroForOne of [true, false]) {
      let prev = -1n
      let amountIn = 1n
      while (amountIn < 10n ** 24n) {
        const r = simulateExactInput(state, zeroForOne, amountIn, { tickSpacing: 60 })
        expect(r.amountOut >= prev, `amountIn=${amountIn}`).toBe(true)
        expect(r.amountOut <= (zeroForOne ? token1Available : token0Available)).toBe(true)
        prev = r.amountOut
        amountIn = (amountIn * 3n) / 2n + 1n
      }
    }
  })

  it('random inputs: monotone, bounded and never throwing', () => {
    const state = fixtureState('main')
    const r = rng(7)
    const samples: bigint[] = []
    for (let i = 0; i < 300; i++) samples.push(BigInt(Math.floor(r() * 1e9)) * 10n ** BigInt(Math.floor(r() * 12)))
    samples.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const zeroForOne of [true, false]) {
      let prev = 0n
      for (const amountIn of samples) {
        const out = simulateExactInput(state, zeroForOne, amountIn, { tickSpacing: 60 })
        expect(out.amountOut >= prev).toBe(true)
        expect(out.amountIn <= amountIn).toBe(true)
        prev = out.amountOut
      }
    }
  })

  it('reports truncated when the walk would leave the tick window, keeping what was computed', () => {
    const full = fixtureState('main')
    const narrow = fixtureState('main', { lower: -300, upper: 300 })
    const ref = simulateExactInput(full, true, 3n * E18, { tickSpacing: 60 }) // ends at tick -531 on chain
    expect(ref.truncated).toBe(false)
    const cut = simulateExactInput(narrow, true, 3n * E18, { tickSpacing: 60 })
    expect(cut.truncated).toBe(true)
    expect(cut.sqrtPriceX96After).toBe(getSqrtPriceAtTick(-300))
    expect(cut.amountOut).toBeGreaterThan(0n)
    expect(cut.amountOut).toBeLessThan(ref.amountOut)
    expect(cut.amountIn).toBeLessThan(3n * E18)
    expect(cut.liquidityAfter).toBe(100n * E18) // -120 was crossed before the edge

    // an input that stays inside the window is not truncated even with the narrow window
    const inside = simulateExactInput(narrow, true, E18, { tickSpacing: 60 })
    expect(inside.truncated).toBe(false)
    expect(inside.amountOut).toBe(ref.amountOut > 0n ? simulateExactInput(full, true, E18, { tickSpacing: 60 }).amountOut : 0n)

    // upward direction
    const up = simulateExactInput(narrow, false, 3n * E18, { tickSpacing: 60 })
    expect(up.truncated).toBe(true)
    expect(up.sqrtPriceX96After).toBe(getSqrtPriceAtTick(300))
    expect(up.liquidityAfter).toBe(130n * E18)
  })

  it('reports truncated when liquidity runs out with no more known ticks', () => {
    const state = fixtureState('main', { lower: -2000, upper: 2000 })
    const r = simulateExactInput(state, true, 50n * E18, { tickSpacing: 60 })
    expect(r.truncated).toBe(true)
    expect(r.liquidityAfter).toBe(0n)
    // all output was produced before the last tick; matches the on-chain partial fill exactly
    const chain = simSwaps.find((s) => s.pool === 'main' && s.zeroForOne && s.amountSpecified === -50n * E18)!
    expect(r.amountOut).toBe(chain.amount1)
    expect(r.amountIn).toBe(-chain.amount0)
    expect(r.sqrtPriceX96After).toBe(getSqrtPriceAtTick(-2000))
  })

  it('a window narrower than the bitmap word still walks word boundaries correctly', () => {
    // window edge on an uninitialised word boundary must not be mistaken for a tick crossing
    const state = fixtureState('main', { lower: -15360, upper: 15300 })
    const r = simulateExactInput(state, false, 7n * E18, { tickSpacing: 60 })
    expect(r.truncated).toBe(true)
    expect(r.liquidityAfter).toBe(0n)
    expect(r.sqrtPriceX96After).toBe(getSqrtPriceAtTick(15300))
    const chain = simSwaps.find((s) => s.pool === 'main' && !s.zeroForOne && s.amountSpecified === -7n * E18)!
    expect(r.amountOut).toBe(chain.amount0)
  })
})

describe('simulateExactInput never throws for well-formed state', () => {
  const E18 = 10n ** 18n

  it('zero input returns an empty untruncated result', () => {
    const r = simulateExactInput(fixtureState('main'), true, 0n)
    expect(r).toEqual({
      amountIn: 0n,
      amountOut: 0n,
      sqrtPriceX96After: fixtureState('main').sqrtPriceX96,
      tickAfter: 0,
      liquidityAfter: 150n * E18,
      truncated: false,
      feeAmount: 0n,
    })
    expect(() => simulateExactInput(fixtureState('main'), true, -1n)).toThrow(RangeError)
  })

  it('empty tick map and zero liquidity -> truncated, no output', () => {
    const state: PoolState = { ...fixtureState('main'), liquidity: 0n, ticks: new Map() }
    for (const zeroForOne of [true, false]) {
      const r = simulateExactInput(state, zeroForOne, E18)
      expect(r.truncated).toBe(true)
      expect(r.amountOut).toBe(0n)
      expect(r.amountIn).toBe(0n)
    }
  })

  it('price already at the limit -> truncated', () => {
    const state: PoolState = { ...fixtureState('main'), sqrtPriceX96: MIN_PRICE_LIMIT, tick: MIN_TICK, tickWindow: FULL_WINDOW }
    expect(simulateExactInput(state, true, E18, { tickSpacing: 60 }).truncated).toBe(true)
    const top: PoolState = { ...fixtureState('main'), sqrtPriceX96: MAX_PRICE_LIMIT, tick: MAX_TICK - 1 }
    expect(simulateExactInput(top, false, E18, { tickSpacing: 60 }).truncated).toBe(true)
  })

  it('tick outside the window -> truncated', () => {
    const state = fixtureState('main', { lower: 100, upper: 200 })
    const r = simulateExactInput(state, true, E18, { tickSpacing: 60 })
    expect(r.truncated).toBe(true)
    expect(r.amountOut).toBe(0n)
  })

  it('inconsistent tick data (liquidityNet larger than liquidity) -> truncated at the bad crossing', () => {
    const state = fixtureState('main')
    state.ticks.set(-120, { liquidityNet: 10n ** 30n, liquidityGross: 10n ** 30n })
    const r = simulateExactInput(state, true, 3n * E18, { tickSpacing: 60 })
    expect(r.truncated).toBe(true)
    expect(r.sqrtPriceX96After).toBe(getSqrtPriceAtTick(-120))
    expect(r.amountOut).toBeGreaterThan(0n)
  })

  it('100% fee pools: exact input eats everything, exact output is impossible', () => {
    const state = { ...fixtureState('main'), lpFee: 1_000_000 }
    const r = simulateExactInput(state, true, E18, { tickSpacing: 60 })
    expect(r.amountOut).toBe(0n)
    expect(r.amountIn).toBe(E18)
    expect(r.truncated).toBe(false)
    const o = simulateExactOutput(state, true, E18, { tickSpacing: 60 })
    expect(o.truncated).toBe(true)
    expect(o.amountOut).toBe(0n)
  })

  it('exact output beyond available liquidity -> truncated with a partial amount', () => {
    const state = fixtureState('main', { lower: -2000, upper: 2000 })
    const r = simulateExactOutput(state, true, 100n * E18, { tickSpacing: 60 })
    expect(r.truncated).toBe(true)
    expect(r.amountOut).toBeGreaterThan(0n)
    expect(r.amountOut).toBeLessThan(100n * E18)
  })

  it('handles the reference live pools without throwing for a range of inputs', () => {
    // pool 0xba2b9bdf04: native / 0xc8c256e4, fee 30000, spacing 25, tick -100001; no ticks known -> window is one word
    const live: PoolState = {
      poolId: '0xba2b9bdf04fd659448a44ac6cabc27f8565bcdf00f58028ec9a07ccf31286514',
      block: 21112099,
      sqrtPriceX96: 533968626430913993175880612n,
      tick: -100001,
      lpFee: 30000,
      protocolFee: 0,
      tickSpacing: 25,
      liquidity: 156110757352674480799197329519n,
      ticks: new Map(),
      tickWindow: { lower: -100001 - 256 * 25, upper: -100001 + 256 * 25 },
    }
    for (const amountIn of [1n, 10n ** 15n, 10n ** 18n, 10n ** 21n, 10n ** 24n, 10n ** 27n]) {
      for (const zeroForOne of [true, false]) {
        const r = simulateExactInput(live, zeroForOne, amountIn, { tickSpacing: 25 })
        expect(r.amountOut >= 0n).toBe(true)
        if (!r.truncated) expect(r.amountIn).toBe(amountIn)
      }
    }
  })
})

describe('window wider than the tick range', () => {
  it('still reaches the price limit exactly like the chain', () => {
    const state = fixtureState('main', { lower: -10_000_000, upper: 10_000_000 })
    const chain = simSwaps.find((s) => s.pool === 'main' && s.zeroForOne && s.amountSpecified === -50n * 10n ** 18n)!
    const r = simulateExactInput(state, true, 50n * 10n ** 18n, { tickSpacing: 60 })
    expect(r.amountOut).toBe(chain.amount1)
    expect(r.sqrtPriceX96After).toBe(chain.sqrtPriceX96After)
    expect(r.tickAfter).toBe(chain.tickAfter)
    expect(r.truncated).toBe(true)
  })
})
