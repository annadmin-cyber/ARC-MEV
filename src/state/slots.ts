import { encodePacked, hexToBigInt, keccak256, toHex, type Hex } from 'viem'
import type { TickData } from '../types.js'

/**
 * Pure storage-slot arithmetic for Uniswap v4 `PoolManager`, mirroring
 * `v4-core/src/libraries/StateLibrary.sol` (see docs/IMPLEMENTATION_SPEC.md, "PoolManager
 * storage layout"). Verified bit-for-bit against `contracts/test/vectors/SlotVectors.t.sol`.
 */

/** Storage index of `mapping(PoolId => Pool.State) pools` in PoolManager. */
export const POOLS_SLOT = 6n
/** Offsets inside `Pool.State`. */
export const LIQUIDITY_OFFSET = 3n
export const TICKS_OFFSET = 4n
export const TICK_BITMAP_OFFSET = 5n
export const POSITIONS_OFFSET = 6n

/** Tick bounds from `TickMath.sol`. */
export const MIN_TICK = -887272
export const MAX_TICK = 887272

const MASK_24 = 0xffffffn
const MASK_128 = (1n << 128n) - 1n
const MASK_160 = (1n << 160n) - 1n

/** `int256(x)` as an unsigned 32-byte hex word (two's complement). */
export function int256ToWord(value: bigint): Hex {
  return toHex(BigInt.asUintN(256, value), { size: 32 })
}

/** Add `offset` to a 32-byte slot (wrapping mod 2^256, as the EVM does). */
export function addSlot(slot: Hex, offset: bigint): Hex {
  return toHex(BigInt.asUintN(256, hexToBigInt(slot) + offset), { size: 32 })
}

/** `keccak256(abi.encodePacked(poolId, uint256(6)))` = slot of `pools[poolId]`. */
export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodePacked(['bytes32', 'uint256'], [poolId, POOLS_SLOT]))
}

/** Slot of `pools[poolId].slot0` (offset 0). */
export function slot0Slot(poolId: Hex): Hex {
  return poolStateSlot(poolId)
}

/** Slot of `pools[poolId].liquidity` (offset 3). */
export function liquiditySlot(poolId: Hex): Hex {
  return addSlot(poolStateSlot(poolId), LIQUIDITY_OFFSET)
}

/** Slot of the `mapping(int24 => TickInfo) ticks` inside the pool state (offset 4). */
export function ticksMappingSlot(poolId: Hex): Hex {
  return addSlot(poolStateSlot(poolId), TICKS_OFFSET)
}

/** Slot of the `mapping(int16 => uint256) tickBitmap` inside the pool state (offset 5). */
export function tickBitmapMappingSlot(poolId: Hex): Hex {
  return addSlot(poolStateSlot(poolId), TICK_BITMAP_OFFSET)
}

/**
 * Slot of word 0 of `pools[poolId].ticks[tick]`:
 * `keccak256(abi.encodePacked(int256(tick), ticksMappingSlot))`.
 */
export function tickInfoSlot(poolId: Hex, tick: number): Hex {
  assertInt(tick, 'tick', -(2 ** 23), 2 ** 23 - 1)
  return keccak256(encodePacked(['bytes32', 'bytes32'], [int256ToWord(BigInt(tick)), ticksMappingSlot(poolId)]))
}

/**
 * Slot of `pools[poolId].tickBitmap[wordPos]`:
 * `keccak256(abi.encodePacked(int256(int16(wordPos)), tickBitmapMappingSlot))`.
 */
export function bitmapWordSlot(poolId: Hex, wordPos: number): Hex {
  assertInt(wordPos, 'wordPos', -(2 ** 15), 2 ** 15 - 1)
  return keccak256(
    encodePacked(['bytes32', 'bytes32'], [int256ToWord(BigInt(wordPos)), tickBitmapMappingSlot(poolId)]),
  )
}

/** Decoded `Pool.State.slot0`. */
export interface Slot0 {
  sqrtPriceX96: bigint
  tick: number
  protocolFee: number
  lpFee: number
}

/**
 * Decode the packed slot0 word:
 * `[24 bits lpFee][24 bits protocolFee][24 bits tick][160 bits sqrtPriceX96]`, tick sign-extended.
 */
export function decodeSlot0(word: Hex): Slot0 {
  const v = hexToBigInt(word)
  return {
    sqrtPriceX96: v & MASK_160,
    tick: Number(BigInt.asIntN(24, (v >> 160n) & MASK_24)),
    protocolFee: Number((v >> 184n) & MASK_24),
    lpFee: Number((v >> 208n) & MASK_24),
  }
}

/** Inverse of {@link decodeSlot0}; used by tests and by the cache to keep fixtures honest. */
export function encodeSlot0(s: Slot0): Hex {
  if (s.sqrtPriceX96 < 0n || s.sqrtPriceX96 > MASK_160) throw new Error('encodeSlot0: sqrtPriceX96 out of uint160')
  assertInt(s.tick, 'tick', -(2 ** 23), 2 ** 23 - 1)
  assertInt(s.protocolFee, 'protocolFee', 0, 2 ** 24 - 1)
  assertInt(s.lpFee, 'lpFee', 0, 2 ** 24 - 1)
  const v =
    (BigInt(s.lpFee) << 208n) |
    (BigInt(s.protocolFee) << 184n) |
    (BigInt.asUintN(24, BigInt(s.tick)) << 160n) |
    s.sqrtPriceX96
  return toHex(v, { size: 32 })
}

/** Decode word 0 of `TickInfo`: `[int128 liquidityNet (high)][uint128 liquidityGross (low)]`. */
export function decodeTickWord(word: Hex): TickData {
  const v = hexToBigInt(word)
  return {
    liquidityNet: BigInt.asIntN(128, v >> 128n),
    liquidityGross: v & MASK_128,
  }
}

/** Inverse of {@link decodeTickWord}. */
export function encodeTickWord(t: TickData): Hex {
  return toHex((BigInt.asUintN(128, t.liquidityNet) << 128n) | (t.liquidityGross & MASK_128), { size: 32 })
}

/** `uint128` in the low bits of a word (e.g. the liquidity slot). */
export function decodeUint128(word: Hex): bigint {
  return hexToBigInt(word) & MASK_128
}

/** `TickBitmap.compress`: `floor(tick / tickSpacing)` rounding toward negative infinity. */
export function compressTick(tick: number, tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error(`compressTick: bad tickSpacing ${tickSpacing}`)
  return Math.floor(tick / tickSpacing)
}

/** `TickBitmap.position`: word index (arithmetic shift) and bit index of a compressed tick. */
export function tickPosition(compressed: number): { wordPos: number; bitPos: number } {
  return { wordPos: compressed >> 8, bitPos: compressed & 0xff }
}

/** Bitmap word that holds the current tick of a pool. */
export function wordPosOfTick(tick: number, tickSpacing: number): number {
  return tickPosition(compressTick(tick, tickSpacing)).wordPos
}

/** The tick represented by bit `bitPos` of bitmap word `wordPos`: `(wordPos * 256 + bitPos) * tickSpacing`. */
export function tickFromBit(wordPos: number, bitPos: number, tickSpacing: number): number {
  return (wordPos * 256 + bitPos) * tickSpacing
}

/** Inclusive tick range [first bit, last bit] of the *initialisable* ticks marked by one bitmap word. */
export function wordTickRange(wordPos: number, tickSpacing: number): { lower: number; upper: number } {
  return { lower: tickFromBit(wordPos, 0, tickSpacing), upper: tickFromBit(wordPos, 255, tickSpacing) }
}

/**
 * Inclusive range of *every* tick whose compressed tick falls in bitmap word `wordPos`:
 * `[bit0 * spacing, (bit255 + 1) * spacing - 1]`. A pool whose current tick is in this span has
 * its bitmap word covered by that word (`wordPosOfTick(tick) === wordPos`).
 */
export function wordTickSpan(wordPos: number, tickSpacing: number): { lower: number; upper: number } {
  const r = wordTickRange(wordPos, tickSpacing)
  return { lower: r.lower, upper: r.upper + tickSpacing - 1 }
}

/** Bit positions (0..255, ascending) set in a bitmap word. */
export function setBits(word: bigint): number[] {
  const bits: number[] = []
  let v = word
  let pos = 0
  while (v !== 0n) {
    if (v & 1n) bits.push(pos)
    v >>= 1n
    pos++
  }
  return bits
}

/** Ticks initialised according to one bitmap word, ascending. */
export function ticksInWord(wordPos: number, word: bigint, tickSpacing: number): number[] {
  return setBits(word).map((bit) => tickFromBit(wordPos, bit, tickSpacing))
}

/** Valid bitmap word range for a tick spacing: only words that intersect [MIN_TICK, MAX_TICK]. */
export function wordPosBounds(tickSpacing: number): { min: number; max: number } {
  return {
    min: tickPosition(compressTick(MIN_TICK, tickSpacing)).wordPos,
    max: tickPosition(compressTick(MAX_TICK, tickSpacing)).wordPos,
  }
}

function assertInt(value: number, name: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`)
  }
}
