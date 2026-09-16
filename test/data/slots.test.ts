import { describe, expect, it } from 'vitest'
import { hexToBigInt, toHex } from 'viem'
import {
  MAX_TICK,
  MIN_TICK,
  bitmapWordSlot,
  compressTick,
  decodeSlot0,
  decodeTickWord,
  decodeUint128,
  encodeSlot0,
  encodeTickWord,
  int256ToWord,
  liquiditySlot,
  poolStateSlot,
  setBits,
  slot0Slot,
  tickBitmapMappingSlot,
  tickFromBit,
  tickInfoSlot,
  tickPosition,
  ticksInWord,
  ticksMappingSlot,
  wordPosBounds,
  wordPosOfTick,
  wordTickRange,
  wordTickSpan,
} from '../../src/state/slots.js'
import { LIVE_POOLS, SLOT_VECTORS } from './fixtures.js'

describe('storage slots vs Solidity vectors', () => {
  const { poolId } = SLOT_VECTORS

  it('pool state / slot0 / liquidity / mapping slots', () => {
    expect(poolStateSlot(poolId)).toBe(SLOT_VECTORS.stateSlot)
    expect(slot0Slot(poolId)).toBe(SLOT_VECTORS.slot0Slot)
    expect(liquiditySlot(poolId)).toBe(SLOT_VECTORS.liquiditySlot)
    expect(ticksMappingSlot(poolId)).toBe(SLOT_VECTORS.ticksMappingSlot)
    expect(tickBitmapMappingSlot(poolId)).toBe(SLOT_VECTORS.tickBitmapSlot)
  })

  it.each(SLOT_VECTORS.tickInfoSlots)('tickInfoSlot(tick=$tick)', ({ tick, slot }) => {
    expect(tickInfoSlot(poolId, tick)).toBe(slot)
  })

  it.each(SLOT_VECTORS.bitmapWordSlots)('bitmapWordSlot(wordPos=$wordPos)', ({ wordPos, slot }) => {
    expect(bitmapWordSlot(poolId, wordPos)).toBe(slot)
  })

  it('sign-extends negative keys to int256', () => {
    expect(int256ToWord(-1n)).toBe('0x' + 'ff'.repeat(32))
    expect(int256ToWord(0n)).toBe('0x' + '00'.repeat(32))
    expect(int256ToWord(BigInt(MIN_TICK))).toBe(toHex((1n << 256n) - 887272n, { size: 32 }))
  })

  it('rejects out-of-range keys', () => {
    expect(() => tickInfoSlot(poolId, 2 ** 23)).toThrow(RangeError)
    expect(() => bitmapWordSlot(poolId, 2 ** 15)).toThrow(RangeError)
    expect(() => tickInfoSlot(poolId, 1.5)).toThrow(RangeError)
  })
})

describe('slot0 codec', () => {
  it.each(LIVE_POOLS.map((p) => [p.poolId.slice(0, 12), p] as const))('round-trips live pool %s', (_, p) => {
    const slot0 = { sqrtPriceX96: BigInt(p.sqrtPriceX96), tick: p.tick, protocolFee: p.protocolFee, lpFee: p.lpFee }
    const word = encodeSlot0(slot0)
    expect(decodeSlot0(word)).toEqual(slot0)
    // Manual layout check: sqrtPrice in the low 160 bits, tick in the next 24 (two's complement).
    const v = hexToBigInt(word)
    expect(v & ((1n << 160n) - 1n)).toBe(BigInt(p.sqrtPriceX96))
    expect((v >> 160n) & 0xffffffn).toBe(BigInt.asUintN(24, BigInt(p.tick)))
    expect((v >> 184n) & 0xffffffn).toBe(BigInt(p.protocolFee))
    expect(v >> 208n).toBe(BigInt(p.lpFee))
  })

  it('decodes the documented example word from StateLibrary', () => {
    // 0x000000|000bb8|000000|ffff75|0000000000000000fe3aa841ba359daa0ea9eff7
    const word = '0x000000000bb8000000ffff750000000000000000fe3aa841ba359daa0ea9eff7'
    expect(decodeSlot0(word)).toEqual({
      lpFee: 3000,
      protocolFee: 0,
      tick: -139,
      sqrtPriceX96: 0xfe3aa841ba359daa0ea9eff7n,
    })
  })

  it('decodes a protocol-fee bearing word with a positive tick and max values', () => {
    const s = { sqrtPriceX96: (1n << 160n) - 1n, tick: 8388607, protocolFee: 0xfff | (0xfff << 12), lpFee: 0xffffff }
    expect(decodeSlot0(encodeSlot0(s))).toEqual(s)
    const n = { sqrtPriceX96: 4295128739n, tick: -8388608, protocolFee: 1234, lpFee: 0x800000 }
    expect(decodeSlot0(encodeSlot0(n))).toEqual(n)
  })

  it('reads uint128 liquidity from the low bits', () => {
    expect(decodeUint128(toHex((1n << 128n) - 1n, { size: 32 }))).toBe((1n << 128n) - 1n)
    expect(decodeUint128(toHex(BigInt(LIVE_POOLS[0]!.liquidity), { size: 32 }))).toBe(BigInt(LIVE_POOLS[0]!.liquidity))
  })
})

describe('tick info word codec', () => {
  it('splits liquidityNet (int128 high) and liquidityGross (uint128 low)', () => {
    const cases = [
      { liquidityNet: -1n, liquidityGross: 1n },
      { liquidityNet: 123456789n, liquidityGross: 123456789n },
      { liquidityNet: -(1n << 127n), liquidityGross: (1n << 128n) - 1n },
      { liquidityNet: (1n << 127n) - 1n, liquidityGross: 0n },
    ]
    for (const c of cases) expect(decodeTickWord(encodeTickWord(c))).toEqual(c)
    // liquidityNet = -5, gross = 5: high half is two's complement of 5.
    const word = toHex((BigInt.asUintN(128, -5n) << 128n) | 5n, { size: 32 })
    expect(decodeTickWord(word)).toEqual({ liquidityNet: -5n, liquidityGross: 5n })
  })
})

describe('tick bitmap arithmetic', () => {
  it('compressTick floors toward negative infinity like TickBitmap.compress', () => {
    expect(compressTick(-1, 60)).toBe(-1)
    expect(compressTick(-60, 60)).toBe(-1)
    expect(compressTick(-61, 60)).toBe(-2)
    expect(compressTick(59, 60)).toBe(0)
    expect(compressTick(60, 60)).toBe(1)
    expect(compressTick(-100001, 25)).toBe(-4001)
    expect(compressTick(MIN_TICK, 1)).toBe(MIN_TICK)
  })

  it('tickPosition is an arithmetic shift for negative compressed ticks', () => {
    expect(tickPosition(0)).toEqual({ wordPos: 0, bitPos: 0 })
    expect(tickPosition(255)).toEqual({ wordPos: 0, bitPos: 255 })
    expect(tickPosition(256)).toEqual({ wordPos: 1, bitPos: 0 })
    expect(tickPosition(-1)).toEqual({ wordPos: -1, bitPos: 255 })
    expect(tickPosition(-256)).toEqual({ wordPos: -1, bitPos: 0 })
    expect(tickPosition(-257)).toEqual({ wordPos: -2, bitPos: 255 })
    expect(tickPosition(-887272)).toEqual({ wordPos: -3466, bitPos: 24 })
    expect(tickPosition(887272)).toEqual({ wordPos: 3465, bitPos: 232 })
  })

  it('bit -> tick is the inverse of compress + position for every spacing', () => {
    for (const spacing of [1, 10, 25, 60, 200, 400]) {
      for (const tick of [MIN_TICK, -100001, -60, -1, 0, 1, 60, 12345, MAX_TICK]) {
        const compressed = compressTick(tick, spacing)
        const { wordPos, bitPos } = tickPosition(compressed)
        const aligned = compressed * spacing
        expect(tickFromBit(wordPos, bitPos, spacing)).toBe(aligned)
        expect(aligned <= tick && tick - aligned < spacing).toBe(true)
        expect(wordPosOfTick(tick, spacing)).toBe(wordPos)
      }
    }
  })

  it('wordTickRange covers exactly the 256 bits of a word', () => {
    expect(wordTickRange(0, 60)).toEqual({ lower: 0, upper: 255 * 60 })
    expect(wordTickRange(-1, 60)).toEqual({ lower: -256 * 60, upper: -60 })
    expect(wordTickRange(-3466, 1)).toEqual({ lower: -887296, upper: -887041 })
    // The span additionally covers the ticks between the last bit and the next word.
    expect(wordTickSpan(0, 60)).toEqual({ lower: 0, upper: 256 * 60 - 1 })
    expect(wordTickSpan(-1, 60)).toEqual({ lower: -256 * 60, upper: -1 })
    for (const spacing of [1, 25, 60]) {
      for (const tick of [-100001, -1, 0, 59, 12345]) {
        const w = wordPosOfTick(tick, spacing)
        const span = wordTickSpan(w, spacing)
        expect(tick >= span.lower && tick <= span.upper).toBe(true)
        expect(wordPosOfTick(span.lower, spacing)).toBe(w)
        expect(wordPosOfTick(span.upper, spacing)).toBe(w)
        expect(wordPosOfTick(span.upper + 1, spacing)).toBe(w + 1)
      }
    }
  })

  it('setBits / ticksInWord enumerate ascending', () => {
    const word = (1n << 0n) | (1n << 7n) | (1n << 255n)
    expect(setBits(word)).toEqual([0, 7, 255])
    expect(setBits(0n)).toEqual([])
    expect(ticksInWord(-1, word, 10)).toEqual([-2560, -2490, -10])
    expect(ticksInWord(2, 1n << 3n, 60)).toEqual([(512 + 3) * 60])
  })

  it('wordPosBounds shrink with tick spacing', () => {
    expect(wordPosBounds(1)).toEqual({ min: -3466, max: 3465 })
    expect(wordPosBounds(60)).toEqual({ min: -58, max: 57 })
    const b = wordPosBounds(25)
    expect(b.min).toBe(tickPosition(compressTick(MIN_TICK, 25)).wordPos)
    expect(b.max).toBe(tickPosition(compressTick(MAX_TICK, 25)).wordPos)
  })
})
