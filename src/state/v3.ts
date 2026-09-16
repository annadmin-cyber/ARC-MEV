/**
 * Decoding of Uniswap-v3-style pool reads from their leading return words only, so that forks
 * whose `slot0()` / `ticks()` return extra (or fewer) trailing fields still decode:
 *
 * - `slot0()`: word 0 = `uint160 sqrtPriceX96`, word 1 = `int24 tick` (sign-extended to 32 bytes).
 * - `ticks(int24)`: word 0 = `uint128 liquidityGross`, word 1 = `int128 liquidityNet`.
 * - `liquidity()`: word 0 = `uint128`. `tickBitmap(int16)`: word 0 = `uint256`.
 */
import { hexToBigInt, type Hex } from 'viem'
import type { TickData } from '../types.js'

const MASK_128 = (1n << 128n) - 1n
const MASK_160 = (1n << 160n) - 1n

/** Number of 32-byte words in an ABI return blob. */
export function wordCount(data: Hex): number {
  return Math.floor((data.length - 2) / 64)
}

/** The `index`-th 32-byte word of `data` as an unsigned bigint. Throws when the blob is too short. */
export function wordAt(data: Hex, index: number, what = 'return data'): bigint {
  const start = 2 + index * 64
  if (data.length < start + 64) throw new Error(`${what}: expected at least ${index + 1} words, got ${wordCount(data)}`)
  return hexToBigInt(`0x${data.slice(start, start + 64)}`)
}

/** Leading words of a v3 `slot0()` result. */
export interface V3Slot0 {
  sqrtPriceX96: bigint
  tick: number
}

/** Decode `sqrtPriceX96` and `tick` from a v3-style `slot0()` return blob (extra trailing words ignored). */
export function decodeV3Slot0(data: Hex): V3Slot0 {
  return {
    sqrtPriceX96: wordAt(data, 0, 'slot0') & MASK_160,
    tick: Number(BigInt.asIntN(24, wordAt(data, 1, 'slot0'))),
  }
}

/** Decode `liquidityGross` / `liquidityNet` from a v3-style `ticks(int24)` return blob (extra words ignored). */
export function decodeV3Tick(data: Hex): TickData {
  return {
    liquidityGross: wordAt(data, 0, 'ticks') & MASK_128,
    liquidityNet: BigInt.asIntN(128, wordAt(data, 1, 'ticks')),
  }
}

/** Decode a `uint128` from the first return word (`liquidity()`). */
export function decodeV3Liquidity(data: Hex): bigint {
  return wordAt(data, 0, 'liquidity') & MASK_128
}

/** Decode a `uint256` bitmap word from the first return word (`tickBitmap(int16)`). */
export function decodeV3BitmapWord(data: Hex): bigint {
  return wordAt(data, 0, 'tickBitmap')
}
