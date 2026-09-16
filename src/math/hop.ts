/**
 * Kind-aware hop simulation: one entry point for v4 pools, v3-style pools and v2-style pairs, plus
 * a `Simulator` factory for the strategy layer (which only sees `PoolState`s).
 */
import type { Hex } from 'viem'
import { poolKind, type PoolInfo, type PoolState, type Simulator, type SwapResult } from '../types.js'
import { simulateExactInput } from './simulate.js'
import { simulateV2ExactInput } from './v2.js'

/**
 * Simulate an exact-input swap through `info`'s pool at `state`, dispatching on the pool kind:
 * - v4: `simulateExactInput` as is (LP fee and protocol fee from the state).
 * - v3-style: `simulateExactInput` with the protocol fee forced to 0. A v3 protocol fee is carved
 *   out of the LP fee (`feeProtocol` in slot0) and does not change the swap output, so the walk
 *   uses `lpFee = info.fee` alone.
 * - v2-style: the constant-product formula on `state.reserves` with `info.fee` pips. A v2 state
 *   without reserves yields a truncated zero result rather than an exception.
 * Never throws for well-formed state (a negative input is a programming error and does throw).
 */
export function simulateHop(
  info: Pick<PoolInfo, 'kind' | 'fee' | 'tickSpacing'>,
  state: PoolState,
  zeroForOne: boolean,
  amountIn: bigint,
): SwapResult {
  switch (poolKind(info)) {
    case 0:
      return simulateExactInput(state, zeroForOne, amountIn)
    case 1: {
      const v3State = state.protocolFee === 0 ? state : { ...state, protocolFee: 0 }
      return simulateExactInput(v3State, zeroForOne, amountIn, info.tickSpacing >= 1 ? { tickSpacing: info.tickSpacing } : {})
    }
    case 2: {
      if (!state.reserves) return noReserves(state, amountIn)
      return simulateV2ExactInput(state.reserves, info.fee, zeroForOne, amountIn)
    }
  }
}

/**
 * Build a `Simulator` closure that looks each state's pool up in `infos` and delegates to
 * {@link simulateHop}. A state whose pool is not in `infos` is treated by shape: with `reserves`
 * it is simulated as a v2 pair using `state.lpFee` as the fee, otherwise as a v4 pool.
 */
export function makeSimulator(infos: ReadonlyMap<Hex, PoolInfo>): Simulator {
  return (state: PoolState, zeroForOne: boolean, amountIn: bigint): SwapResult => {
    const info = infos.get(state.poolId)
    if (info) return simulateHop(info, state, zeroForOne, amountIn)
    if (state.reserves) return simulateV2ExactInput(state.reserves, state.lpFee, zeroForOne, amountIn)
    return simulateExactInput(state, zeroForOne, amountIn)
  }
}

function noReserves(state: PoolState, amountIn: bigint): SwapResult {
  if (amountIn < 0n) throw new RangeError(`simulateHop: amountIn must be >= 0, got ${amountIn}`)
  return {
    amountIn: 0n,
    amountOut: 0n,
    sqrtPriceX96After: state.sqrtPriceX96,
    tickAfter: state.tick,
    liquidityAfter: state.liquidity,
    truncated: true,
    feeAmount: 0n,
  }
}
