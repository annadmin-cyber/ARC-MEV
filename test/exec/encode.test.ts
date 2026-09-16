import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem'
import { executorAbi } from '../../src/abi/index.js'
import {
  decodeExecute,
  encodeExecute,
  guardFor,
  guardsForConfig,
  MissingPoolAddressError,
  MissingPoolError,
  MissingReservesError,
  stepFor,
  toExecutorSteps,
  toGuards,
} from '../../src/exec/encode.js'
import { addressToPoolId, NATIVE, type Cycle, type PoolInfo } from '../../src/types.js'
import { v2SqrtPriceX96 } from '../../src/math/v2.js'
import { CYCLE, HOOK, INFOS, MIXED_CYCLE, MIXED_INFOS, MIXED_STATES, P1, P2, P3, P4, Q96, STATES, TOKEN_B, TOKEN_C, V2_PAIR, V2_RESERVES, V2_SQRT_PRICE, V3_POOL } from './helpers.js'

/**
 * Reference calldata printed by `forge test --match-contract ExecCalldataVectors -vv`
 * (`contracts/test/vectors/ExecCalldataVectors.t.sol`, Solidity `abi.encodeCall`). Regenerate
 * with `npx tsx test/exec/calldata-vector.ts` and the forge command; both must print these.
 */
const FORGE_VECTOR_V4: Hex = '0x1f24a1b50000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000112210f47de9811500000000000000000000000000000000000000000000000000b1a2bc2ec5000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c8c256e41c6cc5fcbf6a8e3b1b53f5778f033e220000000000000000000000000000000000000000000000000000000000000bb8000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c8c256e41c6cc5fcbf6a8e3b1b53f5778f033e22000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a10000000000000000000000000000000000000001051eb851eb851eb851eb851e0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a20000000000000000000000000000000000000000fae147ae147ae147ae147ae20000000000000000000000000000000000000000000000000000000000000002'
const FORGE_VECTOR_MIXED: Hex = '0x1f24a1b500000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000000000303900000000000000000000000000000000000000000000000000000000000003a000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c8c256e41c6cc5fcbf6a8e3b1b53f5778f033e220000000000000000000000000000000000000000000000000000000000000bb8000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000082916bee18fcef517b26c72d7cb5f13694e1db41000000000000000000000000c8c256e41c6cc5fcbf6a8e3b1b53f5778f033e22000000000000000000000000d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d100000000000000000000000000000000000000000000000000000000000001f400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000005dbf58814d0736fa09b6ad7f290800b805dd383d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d10000000000000000000000000000000000000000000000000000000000000bb8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a10000000000000000000000000000000000000001051eb851eb851eb851eb851e0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000100000000000000000000000082916bee18fcef517b26c72d7cb5f13694e1db410000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000020000000000000000000000005dbf58814d0736fa09b6ad7f290800b805dd383d00000000000000000000000000000000000000016a09e667f3bcc908b2fb13660000000000000000000000000000000000000000000000000000000000000003'

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

  it('emits kind 1 / kind 2 steps addressed by contract with tickSpacing and hooks zeroed', () => {
    const steps = toExecutorSteps(MIXED_CYCLE, MIXED_INFOS)
    expect(steps).toEqual([
      { kind: 0, zeroForOne: true, pool: NATIVE, key: { currency0: NATIVE, currency1: TOKEN_B, fee: 3000, tickSpacing: 60, hooks: NATIVE } },
      { kind: 1, zeroForOne: true, pool: V3_POOL, key: { currency0: TOKEN_B, currency1: TOKEN_C, fee: 500, tickSpacing: 0, hooks: NATIVE } },
      { kind: 2, zeroForOne: false, pool: V2_PAIR, key: { currency0: NATIVE, currency1: TOKEN_C, fee: 3000, tickSpacing: 0, hooks: NATIVE } },
    ])
    // Mixed-case addresses in the info are lower-cased in the step.
    const upper: PoolInfo = { ...P4, pool: V2_PAIR.toUpperCase().replace('0X', '0x') as Address }
    expect(stepFor(upper, true).pool).toBe(V2_PAIR)
    const { pool: _noPool, ...v3WithoutAddress } = P3
    expect(() => stepFor(v3WithoutAddress, true)).toThrow(MissingPoolAddressError)
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

  it('builds v3 and v2 guards on sqrtPrice (v2: derived from the reserves), keyed by the left-padded address', () => {
    const guards = toGuards(MIXED_CYCLE, MIXED_STATES, 3, MIXED_INFOS)
    expect(guards).toEqual([
      { kind: 0, poolId: P1.poolId, expected: Q96 + Q96 / 50n, toleranceBps: 3 },
      { kind: 1, poolId: addressToPoolId(V3_POOL), expected: 2n * Q96, toleranceBps: 3 },
      { kind: 2, poolId: addressToPoolId(V2_PAIR), expected: V2_SQRT_PRICE, toleranceBps: 3 },
    ])
    expect(guardsForConfig({ GUARD_TOLERANCE_BPS: 3 }, MIXED_CYCLE, MIXED_STATES, MIXED_INFOS)).toEqual(guards)
  })

  it('infers the kind from the state when no info is given, and rejects a v2 state without reserves', () => {
    const v2State = MIXED_STATES.get(P4.poolId)!
    expect(guardFor(v2State, 1)).toEqual({ kind: 2, poolId: P4.poolId, expected: V2_SQRT_PRICE, toleranceBps: 1 })
    expect(guardFor(MIXED_STATES.get(P3.poolId)!, 1)).toEqual({ kind: 0, poolId: P3.poolId, expected: 2n * Q96, toleranceBps: 1 })
    expect(guardFor(MIXED_STATES.get(P3.poolId)!, 1, P3).kind).toBe(1)
    const { reserves: _drop, ...noReserves } = v2State
    expect(() => guardFor(noReserves, 1, P4)).toThrow(MissingReservesError)
    // A non-v4 info without an address falls back to the state's poolId (already the padded address).
    const { pool: _noPair, ...v2WithoutAddress } = P4
    expect(guardFor(v2State, 1, v2WithoutAddress).poolId).toBe(P4.poolId)
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

  it('matches the Solidity abi.encodeCall reference byte for byte (v4-only and mixed v4+v3+v2 plans)', () => {
    expect(encodeExecute(steps, amountIn, minProfit, guards)).toBe(FORGE_VECTOR_V4)
    const mixed = encodeExecute(toExecutorSteps(MIXED_CYCLE, MIXED_INFOS), 10n ** 18n, 12_345n, toGuards(MIXED_CYCLE, MIXED_STATES, 3, MIXED_INFOS))
    expect(mixed).toBe(FORGE_VECTOR_MIXED)
    const decoded = decodeExecute(mixed)
    expect(decoded.steps.map((s) => s.kind)).toEqual([0, 1, 2])
    expect(decoded.guards.map((g) => g.kind)).toEqual([0, 1, 2])
    expect(decoded.guards[2]!.expected).toBe(V2_SQRT_PRICE)
    // The contract's guard compares against v2SqrtPriceX96(reserve0, reserve1); the fixture state carries exactly that.
    expect(V2_SQRT_PRICE).toBe(v2SqrtPriceX96(V2_RESERVES))
  })

  it('accepts an empty guard list and rejects an empty plan or negative amounts', () => {
    const data = encodeExecute(steps, amountIn, 0n, [])
    expect(decodeExecute(data).guards).toEqual([])
    expect(() => encodeExecute([], amountIn, 0n, [])).toThrow(RangeError)
    expect(() => encodeExecute(steps, -1n, 0n, [])).toThrow(RangeError)
  })
})
