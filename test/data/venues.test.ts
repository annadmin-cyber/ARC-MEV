import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, type Hex } from 'viem'
import { MAX_TICK, MIN_TICK } from '../../src/math/tickMath.js'
import { v2Liquidity, v2SqrtPriceX96, v2Tick } from '../../src/math/v2.js'
import { applyV2Reserves, decodeV2Reserves, deriveV2State } from '../../src/state/v2.js'
import { decodeV3BitmapWord, decodeV3Liquidity, decodeV3Slot0, decodeV3Tick, wordAt, wordCount } from '../../src/state/v3.js'

const SQRT_P = 4295128739n * 12345n
const V3_SLOT0_TYPES = [
  { type: 'uint160' },
  { type: 'int24' },
  { type: 'uint16' },
  { type: 'uint16' },
  { type: 'uint16' },
  { type: 'uint8' },
  { type: 'bool' },
] as const
const V3_TICKS_TYPES = [
  { type: 'uint128' },
  { type: 'int128' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'int56' },
  { type: 'uint160' },
  { type: 'uint32' },
  { type: 'bool' },
] as const

describe('v3 return-data decoding (leading words only)', () => {
  it('slot0: canonical 7-tuple, a 2-word fork, and a fork with extra trailing words', () => {
    const canonical = encodeAbiParameters(V3_SLOT0_TYPES, [SQRT_P, -276325, 7, 100, 100, 0, true])
    expect(wordCount(canonical)).toBe(7)
    expect(decodeV3Slot0(canonical)).toEqual({ sqrtPriceX96: SQRT_P, tick: -276325 })
    const twoWords = encodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }], [SQRT_P, 887271])
    expect(decodeV3Slot0(twoWords)).toEqual({ sqrtPriceX96: SQRT_P, tick: 887271 })
    // Slipstream-style (6 fields, no feeProtocol) and a fork with 9 fields both decode the same leading words.
    const six = encodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'bool' }], [SQRT_P, -1, 0, 0, 0, false])
    expect(decodeV3Slot0(six)).toEqual({ sqrtPriceX96: SQRT_P, tick: -1 })
    const nine = `${canonical}${'ab'.repeat(64)}` as Hex
    expect(decodeV3Slot0(nine)).toEqual({ sqrtPriceX96: SQRT_P, tick: -276325 })
    // Too short: one word only.
    expect(() => decodeV3Slot0(encodeAbiParameters([{ type: 'uint160' }], [SQRT_P]))).toThrow(/slot0: expected at least 2 words/)
    expect(() => decodeV3Slot0('0x')).toThrow(/expected at least/)
  })

  it('ticks: canonical 8-tuple with a negative liquidityNet, extra trailing words ignored', () => {
    const data = encodeAbiParameters(V3_TICKS_TYPES, [12345678901234567890n, -12345678901234567890n, 1n, 2n, -3n, 4n, 5, true])
    expect(decodeV3Tick(data)).toEqual({ liquidityGross: 12345678901234567890n, liquidityNet: -12345678901234567890n })
    const positive = encodeAbiParameters([{ type: 'uint128' }, { type: 'int128' }], [5n, 5n])
    expect(decodeV3Tick(positive)).toEqual({ liquidityGross: 5n, liquidityNet: 5n })
    expect(decodeV3Tick(`${positive}${'ff'.repeat(32)}` as Hex)).toEqual({ liquidityGross: 5n, liquidityNet: 5n })
    expect(() => decodeV3Tick(encodeAbiParameters([{ type: 'uint128' }], [5n]))).toThrow(/ticks: expected at least 2 words/)
  })

  it('liquidity and bitmap words come from the first word', () => {
    expect(decodeV3Liquidity(encodeAbiParameters([{ type: 'uint128' }], [(1n << 128n) - 1n]))).toBe((1n << 128n) - 1n)
    expect(decodeV3BitmapWord(encodeAbiParameters([{ type: 'uint256' }], [(1n << 255n) | 1n]))).toBe((1n << 255n) | 1n)
    expect(wordAt(`0x${'00'.repeat(31)}2a${'00'.repeat(32)}`, 0)).toBe(42n)
    expect(wordAt(`0x${'00'.repeat(31)}2a${'00'.repeat(31)}01`, 1)).toBe(1n)
    expect(() => wordAt('0x1234', 0)).toThrow(/expected at least 1 words, got 0/)
  })
})

describe('v2 reserves decoding and state derivation', () => {
  const r0 = 130_000_000_000n
  const r1 = 130_000n * 10n ** 18n
  const info = { poolId: '0x0000000000000000000000005dbf58814d0736fa09b6ad7f290800b805dd383d' as Hex, fee: 3000 }

  it('decodes getReserves() and derives price, tick and liquidity', () => {
    const data = encodeAbiParameters([{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }], [r0, r1, 1_700_000_000])
    expect(decodeV2Reserves(data)).toEqual({ reserve0: r0, reserve1: r1 })
    const state = deriveV2State(info, 21_000_000, { reserve0: r0, reserve1: r1 })
    expect(state.poolId).toBe(info.poolId)
    expect(state.block).toBe(21_000_000)
    expect(state.reserves).toEqual({ reserve0: r0, reserve1: r1 })
    expect(state.sqrtPriceX96).toBe(v2SqrtPriceX96({ reserve0: r0, reserve1: r1 }))
    expect(state.tick).toBe(v2Tick(state.sqrtPriceX96))
    expect(state.liquidity).toBe(v2Liquidity({ reserve0: r0, reserve1: r1 }))
    expect(state.lpFee).toBe(3000)
    expect(state.protocolFee).toBe(0)
    expect(state.tickSpacing).toBe(0)
    expect(state.ticks.size).toBe(0)
    expect(state.tickWindow).toEqual({ lower: MIN_TICK, upper: MAX_TICK })
    // 1e6 USDC-6 vs 1e18 18-dec token per unit: price 1e12 -> sqrt 1e6
    expect(Number(state.sqrtPriceX96) / 2 ** 96).toBeCloseTo(1e6, 3)
  })

  it('applyV2Reserves updates in place and re-derives; an empty pair derives to zero price', () => {
    const state = deriveV2State(info, 1, { reserve0: r0, reserve1: r1 })
    const before = state.sqrtPriceX96
    applyV2Reserves(state, { reserve0: r0 * 2n, reserve1: r1 }, 2)
    expect(state.block).toBe(2)
    expect(state.reserves).toEqual({ reserve0: r0 * 2n, reserve1: r1 })
    expect(state.sqrtPriceX96 < before).toBe(true)
    expect(state.liquidity).toBe(v2Liquidity({ reserve0: r0 * 2n, reserve1: r1 }))
    applyV2Reserves(state, { reserve0: 0n, reserve1: 0n }, 3)
    expect(state.sqrtPriceX96).toBe(0n)
    expect(state.tick).toBe(0)
    expect(state.liquidity).toBe(0n)
  })
})
