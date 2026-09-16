/**
 * `PoolState` for Uniswap-v2-style pairs: the reserves are the state; `sqrtPriceX96`, `tick` and
 * `liquidity` are derived from them so ranking, spot-price prefilters and guards work uniformly
 * across kinds. `ticks` is empty and the tick window spans the whole range (nothing to walk).
 */
import { type Hex } from 'viem'
import { v2Liquidity, v2SqrtPriceX96, v2Tick, type V2Reserves } from '../math/v2.js'
import { MAX_TICK, MIN_TICK } from '../math/tickMath.js'
import type { PoolInfo, PoolState } from '../types.js'
import { wordAt } from './v3.js'

/** Decode `(uint112 reserve0, uint112 reserve1, uint32)` from a `getReserves()` return blob. */
export function decodeV2Reserves(data: Hex): V2Reserves {
  const mask = (1n << 112n) - 1n
  return { reserve0: wordAt(data, 0, 'getReserves') & mask, reserve1: wordAt(data, 1, 'getReserves') & mask }
}

/** Build the full `PoolState` of a v2-style pair from its reserves. */
export function deriveV2State(info: Pick<PoolInfo, 'poolId' | 'fee'>, block: number, reserves: V2Reserves): PoolState {
  const state: PoolState = {
    poolId: info.poolId,
    block,
    sqrtPriceX96: 0n,
    tick: 0,
    lpFee: info.fee,
    protocolFee: 0,
    liquidity: 0n,
    tickSpacing: 0,
    ticks: new Map(),
    tickWindow: { lower: MIN_TICK, upper: MAX_TICK },
    reserves: { reserve0: reserves.reserve0, reserve1: reserves.reserve1 },
  }
  applyV2Reserves(state, reserves, block)
  return state
}

/** Update a v2 state in place from a `Sync` (new reserves), re-deriving price, tick and liquidity. */
export function applyV2Reserves(state: PoolState, reserves: V2Reserves, block: number): void {
  state.reserves = { reserve0: reserves.reserve0, reserve1: reserves.reserve1 }
  state.sqrtPriceX96 = v2SqrtPriceX96(reserves)
  state.tick = v2Tick(state.sqrtPriceX96)
  state.liquidity = v2Liquidity(reserves)
  state.block = block
}
