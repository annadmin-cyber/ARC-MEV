import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem'
import { executorAbi } from '../../src/abi/index.js'
import { decodeExecute, encodeExecute, guardsForConfig, MissingPoolError, toExecutorSteps, toGuards } from '../../src/exec/encode.js'
import { NATIVE, type Cycle } from '../../src/types.js'
import { CYCLE, HOOK, INFOS, P1, P2, Q96, STATES, TOKEN_B } from './helpers.js'

/** `cast sig "execute((uint8,bool,address,(address,address,uint24,int24,address))[],uint256,uint256,(uint8,bytes32,uint160,uint24)[])"` */
const EXECUTE_SELECTOR = '0x1f24a1b5'

describe('toExecutorSteps', () => {
  it('builds one v4 step per hop, in hop order, with the pool key and direction', () => {
    const steps = toExecutorSteps(CYCLE, INFOS)
    expect(steps).toEqual([
      {
        kind: 0,
        zeroForOne: true,
        pool: NATIVE,
        key: { currency0: NATIVE, currency1: TOKEN_B, fee: 3000, tickSpacing: 60, hooks: NATIVE },
      },
      {
        kind: 0,
        zeroForOne: false,
        pool: NATIVE,
        key: { currency0: NATIVE, currency1: TOKEN_B, fee: 10000, tickSpacing: 200, hooks: HOOK },
      },
    ])
  })

  it('throws MissingPoolError for a hop whose pool is unknown', () => {
    const cycle: Cycle = { ...CYCLE, hops: [CYCLE.hops[0]!, { poolId: '0xdead' as Hex, zeroForOne: false }] }
    expect(() => toExecutorSteps(cycle, INFOS)).toThrow(MissingPoolError)
  })
})

describe('toGuards', () => {
  it('emits one guard per distinct pool with the state sqrtPrice and the tolerance', () => {
    const guards = toGuards(CYCLE, STATES, 1)
    expect(guards).toEqual([
      { kind: 0, poolId: P1.poolId, expected: Q96 + Q96 / 50n, toleranceBps: 1 },
      { kind: 0, poolId: P2.poolId, expected: Q96 - Q96 / 50n, toleranceBps: 1 },
    ])
  })

  it('de-duplicates pools that appear twice in a cycle', () => {
    const cycle: Cycle = { ...CYCLE, hops: [...CYCLE.hops, { poolId: P1.poolId, zeroForOne: false }] }
    expect(toGuards(cycle, STATES, 5).map((g) => g.poolId)).toEqual([P1.poolId, P2.poolId])
  })

  it('throws on a missing state and on an invalid tolerance', () => {
    expect(() => toGuards(CYCLE, new Map(), 1)).toThrow(MissingPoolError)
    expect(() => toGuards(CYCLE, STATES, -1)).toThrow(RangeError)
    expect(() => toGuards(CYCLE, STATES, 0x1000000)).toThrow(RangeError)
    expect(() => toGuards(CYCLE, STATES, 1.5)).toThrow(RangeError)
  })

  it('guardsForConfig returns no guards when GUARD_TOLERANCE_BPS is 0', () => {
    expect(guardsForConfig({ GUARD_TOLERANCE_BPS: 0 }, CYCLE, STATES)).toEqual([])
    expect(guardsForConfig({ GUARD_TOLERANCE_BPS: 3 }, CYCLE, STATES)).toHaveLength(2)
  })
})

describe('encodeExecute', () => {
  const steps = toExecutorSteps(CYCLE, INFOS)
  const guards = toGuards(CYCLE, STATES, 2)
  const amountIn = 1_234_567_890_123_456_789n
  const minProfit = 50_000_000_000_000_000n

  it('produces execute() calldata with the selector cast computes', () => {
    const data = encodeExecute(steps, amountIn, minProfit, guards)
    expect(data.slice(0, 10)).toBe(EXECUTE_SELECTOR)
    // Identical to what viem produces when handed the structs directly.
    expect(data).toBe(encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [steps, amountIn, minProfit, guards] }))
  })

  it('round-trips through viem decodeFunctionData and decodeExecute', () => {
    const data = encodeExecute(steps, amountIn, minProfit, guards)
    const decoded = decodeFunctionData({ abi: executorAbi, data })
    if (decoded.functionName !== 'execute') throw new Error(`decoded ${decoded.functionName}`)
    const [dSteps, dAmountIn, dMinProfit, dGuards] = decoded.args
    expect(dAmountIn).toBe(amountIn)
    expect(dMinProfit).toBe(minProfit)
    expect(dSteps).toHaveLength(2)
    expect(dSteps[0]!.zeroForOne).toBe(true)
    expect(dSteps[1]!.zeroForOne).toBe(false)
    expect(dSteps[1]!.key.hooks.toLowerCase()).toBe(HOOK)
    expect(dSteps[1]!.key.tickSpacing).toBe(200)
    expect(dGuards).toHaveLength(2)
    expect(dGuards[0]!.expected).toBe(Q96 + Q96 / 50n)
    expect(dGuards[1]!.toleranceBps).toBe(2)

    expect(decodeExecute(data)).toEqual({ steps, amountIn, minProfit, guards })
  })

  it('accepts an empty guard list and rejects an empty plan or negative amounts', () => {
    const data = encodeExecute(steps, amountIn, 0n, [])
    expect(decodeExecute(data).guards).toEqual([])
    expect(() => encodeExecute([], amountIn, 0n, [])).toThrow(RangeError)
    expect(() => encodeExecute(steps, -1n, 0n, [])).toThrow(RangeError)
  })
})
