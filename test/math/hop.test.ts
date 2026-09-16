import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { makeSimulator, simulateHop } from '../../src/math/hop.js'
import { simulateExactInput } from '../../src/math/simulate.js'
import { simulateV2ExactInput, v2Liquidity, v2SqrtPriceX96, v2Tick } from '../../src/math/v2.js'
import { MAX_TICK, MIN_TICK } from '../../src/math/tickMath.js'
import { addressToPoolId, type PoolInfo, type PoolState } from '../../src/types.js'
import { fixtureState } from './helpers.js'

const E18 = 10n ** 18n
const ZERO = '0x0000000000000000000000000000000000000000' as const
const V3_ADDR = '0x82916bee18fcef517b26c72d7cb5f13694e1db41' as const
const V2_ADDR = '0x5dbf58814d0736fa09b6ad7f290800b805dd383d' as const

const base = { currency0: '0x1000000000000000000000000000000000000001', currency1: '0x2000000000000000000000000000000000000002', hooks: ZERO, block: 1 } as const

/** The `pf` fixture (fee 500 with a 500-pip protocol fee on zeroForOne) as v4 and as a v3 pool. */
const pfState = fixtureState('pf')
const v4Info: PoolInfo = { ...base, poolId: pfState.poolId, fee: 500, tickSpacing: 10 }
const v3Info: PoolInfo = { ...base, poolId: addressToPoolId(V3_ADDR), fee: 500, tickSpacing: 10, kind: 1, pool: V3_ADDR, venue: 'uniswap-v3' }
const v2Info: PoolInfo = { ...base, poolId: addressToPoolId(V2_ADDR), fee: 3000, tickSpacing: 0, kind: 2, pool: V2_ADDR, venue: 'uniswap-v2' }
const reserves = { reserve0: 10n ** 24n, reserve1: 2n * 10n ** 24n }

function v2State(info: PoolInfo): PoolState {
  const sqrtPriceX96 = v2SqrtPriceX96(reserves)
  return {
    poolId: info.poolId,
    block: 1,
    sqrtPriceX96,
    tick: v2Tick(sqrtPriceX96),
    lpFee: info.fee,
    protocolFee: 0,
    liquidity: v2Liquidity(reserves),
    tickSpacing: 0,
    ticks: new Map(),
    tickWindow: { lower: MIN_TICK, upper: MAX_TICK },
    reserves: { ...reserves },
  }
}

describe('simulateHop', () => {
  it('v4 pools are simulated with their protocol fee (identical to simulateExactInput)', () => {
    const r = simulateHop(v4Info, pfState, true, E18)
    expect(r).toEqual(simulateExactInput(pfState, true, E18))
    expect(r.amountOut).toBeGreaterThan(0n)
  })

  it('v3-style pools ignore the protocol fee field and do not mutate the state', () => {
    const state: PoolState = { ...pfState, poolId: v3Info.poolId, protocolFee: pfState.protocolFee }
    expect(state.protocolFee).not.toBe(0)
    const v3 = simulateHop(v3Info, state, true, E18)
    const expected = simulateExactInput({ ...state, protocolFee: 0 }, true, E18, { tickSpacing: 10 })
    expect(v3).toEqual(expected)
    // The v4 walk with the protocol fee active charges more and outputs less.
    const asV4 = simulateExactInput(state, true, E18)
    expect(v3.amountOut).toBeGreaterThan(asV4.amountOut)
    expect(state.protocolFee).toBe(pfState.protocolFee)
    // A v3 state that already has protocolFee 0 is used as is (no copy needed) and gives the same numbers.
    const clean: PoolState = { ...state, protocolFee: 0 }
    expect(simulateHop(v3Info, clean, true, E18)).toEqual(v3)
    expect(simulateHop(v3Info, clean, false, E18)).toEqual(simulateExactInput(clean, false, E18, { tickSpacing: 10 }))
  })

  it('v2-style pairs use the constant-product formula on the reserves with info.fee', () => {
    const state = v2State(v2Info)
    const r = simulateHop(v2Info, state, true, E18)
    expect(r).toEqual(simulateV2ExactInput(reserves, 3000, true, E18))
    expect(r.amountOut).toBeGreaterThan(0n)
    // fee from info, not from the state
    const cheaper = simulateHop({ ...v2Info, fee: 0 }, state, true, E18)
    expect(cheaper.amountOut).toBeGreaterThan(r.amountOut)
    // a v2 state without reserves cannot be simulated: truncated, nothing out, nothing thrown
    const { reserves: _drop, ...bare } = state
    const none = simulateHop(v2Info, bare as PoolState, true, E18)
    expect(none.truncated).toBe(true)
    expect(none.amountOut).toBe(0n)
    expect(none.amountIn).toBe(0n)
    expect(none.sqrtPriceX96After).toBe(state.sqrtPriceX96)
    expect(() => simulateHop(v2Info, bare as PoolState, true, -1n)).toThrow(RangeError)
  })
})

describe('makeSimulator', () => {
  it('dispatches on the state\'s pool id and falls back by shape for unknown pools', () => {
    const infos = new Map<Hex, PoolInfo>([
      [v4Info.poolId, v4Info],
      [v3Info.poolId, v3Info],
      [v2Info.poolId, v2Info],
    ])
    const simulate = makeSimulator(infos)
    const v3State: PoolState = { ...pfState, poolId: v3Info.poolId }
    expect(simulate(pfState, true, E18)).toEqual(simulateHop(v4Info, pfState, true, E18))
    expect(simulate(v3State, true, E18)).toEqual(simulateHop(v3Info, v3State, true, E18))
    expect(simulate(v2State(v2Info), false, E18)).toEqual(simulateHop(v2Info, v2State(v2Info), false, E18))
    // Unknown pool with reserves -> v2 with the state's lpFee; unknown without reserves -> v4.
    const unknownV2: PoolState = { ...v2State(v2Info), poolId: '0x00000000000000000000000000000000000000000000000000000000000000ee', lpFee: 500 }
    expect(simulate(unknownV2, true, E18)).toEqual(simulateV2ExactInput(reserves, 500, true, E18))
    const unknownV4: PoolState = { ...pfState, poolId: '0x00000000000000000000000000000000000000000000000000000000000000ef' }
    expect(simulate(unknownV4, true, E18)).toEqual(simulateExactInput(unknownV4, true, E18))
  })
})
