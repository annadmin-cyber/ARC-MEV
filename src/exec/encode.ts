/**
 * Translation of a strategy `Cycle` into the calldata `ArcArbExecutor.execute` expects.
 *
 * A hop can be a Uniswap v4 pool (kind 0, addressed by its `PoolKey`), a v3-style pool (kind 1)
 * or a v2-style pair (kind 2), the latter two addressed by contract address with the token pair
 * and fee carried in the key. Guards are one per distinct pool and carry the price the local
 * simulation was based on: `sqrtPriceX96` for every kind (for a v2 pair that is the value derived
 * from its reserves, `isqrt(reserve1 * 2^192 / reserve0)`, which the contract recomputes on chain
 * as `v2SqrtPriceX96`), so the contract reverts before swapping if a pool moved by more than
 * `toleranceBps` since the state was read.
 */
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem'
import { executorAbi } from '../abi/index.js'
import type { Config } from '../config.js'
import {
  addressToPoolId,
  NATIVE,
  poolKind,
  type Cycle,
  type ExecutorStep,
  type PoolInfo,
  type PoolState,
  type StateGuard,
} from '../types.js'

/** Thrown when a cycle references a pool the caller has no info / state for. */
export class MissingPoolError extends Error {
  constructor(
    readonly poolId: Hex,
    what: 'info' | 'state',
  ) {
    super(`no pool ${what} for ${poolId}`)
    this.name = 'MissingPoolError'
  }
}

/** Thrown when a v3/v2 pool's info lacks the contract address the executor needs. */
export class MissingPoolAddressError extends Error {
  constructor(readonly poolId: Hex) {
    super(`pool ${poolId} is not a v4 pool but has no contract address`)
    this.name = 'MissingPoolAddressError'
  }
}

/** Thrown when a v2 pair's state carries no reserves (its price is derived from them; such a state is malformed). */
export class MissingReservesError extends Error {
  constructor(readonly poolId: Hex) {
    super(`v2 pair ${poolId} has no reserves in its state`)
    this.name = 'MissingReservesError'
  }
}

/**
 * Build the executor step for one hop through `info`:
 *
 * - v4: `kind 0`, `pool` = zero address, `key` = the pool's full `PoolKey`.
 * - v3-style: `kind 1`, `pool` = the pool address, `key.fee` = the pool fee, `tickSpacing 0`, `hooks 0`.
 * - v2-style: `kind 2`, `pool` = the pair address, `key.fee` = the pair fee in pips, `tickSpacing 0`, `hooks 0`.
 *
 * For every kind `key.currency0/currency1` are the pool's token0/token1 and `zeroForOne` the
 * direction. Throws {@link MissingPoolAddressError} for a non-v4 pool without `pool`.
 */
export function stepFor(info: PoolInfo, zeroForOne: boolean): ExecutorStep {
  const kind = poolKind(info)
  if (kind === 0) {
    return {
      kind,
      zeroForOne,
      pool: NATIVE,
      key: { currency0: info.currency0, currency1: info.currency1, fee: info.fee, tickSpacing: info.tickSpacing, hooks: info.hooks },
    }
  }
  if (!info.pool) throw new MissingPoolAddressError(info.poolId)
  return {
    kind,
    zeroForOne,
    pool: info.pool.toLowerCase() as ExecutorStep['pool'],
    key: { currency0: info.currency0, currency1: info.currency1, fee: info.fee, tickSpacing: 0, hooks: NATIVE },
  }
}

/**
 * Build the executor steps for `cycle`, in hop order (see {@link stepFor} for the per-kind
 * layout). Throws {@link MissingPoolError} if a hop's pool is not in `infos`.
 */
export function toExecutorSteps(cycle: Cycle, infos: ReadonlyMap<Hex, PoolInfo>): ExecutorStep[] {
  return cycle.hops.map((hop) => {
    const info = infos.get(hop.poolId)
    if (!info) throw new MissingPoolError(hop.poolId, 'info')
    return stepFor(info, hop.zeroForOne)
  })
}

/**
 * The guard for one pool given its state: v4 `{kind 0, poolId, expected: sqrtPriceX96}`,
 * v3 `{kind 1, poolId: addressToPoolId(pool), expected: sqrtPriceX96}`,
 * v2 `{kind 2, poolId: addressToPoolId(pair), expected: sqrtPriceX96}` (the price the venues layer
 * derived from the reserves; the contract compares it with `v2SqrtPriceX96(reserve0, reserve1)`,
 * so `toleranceBps` means the same for every kind). Without `info` the pool is
 * treated as v4 unless its state carries reserves (then v2, keyed by the state's poolId, which is
 * the left-padded pair address by construction).
 */
export function guardFor(state: PoolState, toleranceBps: number, info?: PoolInfo): StateGuard {
  const kind = info ? poolKind(info) : state.reserves ? 2 : 0
  if (kind === 0) return { kind, poolId: state.poolId, expected: state.sqrtPriceX96, toleranceBps }
  const poolId = info?.pool ? addressToPoolId(info.pool) : state.poolId
  if (kind === 1) return { kind, poolId, expected: state.sqrtPriceX96, toleranceBps }
  if (!state.reserves) throw new MissingReservesError(state.poolId)
  return { kind, poolId, expected: state.sqrtPriceX96, toleranceBps }
}

/**
 * One guard per distinct pool of `cycle` (first occurrence order), expecting the value currently
 * held in `states` (see {@link guardFor}). `infos` supplies each pool's kind; without it every pool
 * is v4 unless its state has reserves. Throws {@link MissingPoolError} if a state is missing.
 * `toleranceBps` is the deviation the contract tolerates; 0 means the value must match exactly.
 */
export function toGuards(
  cycle: Cycle,
  states: ReadonlyMap<Hex, PoolState>,
  toleranceBps: number,
  infos?: ReadonlyMap<Hex, PoolInfo>,
): StateGuard[] {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 0xffffff) {
    throw new RangeError(`toGuards: toleranceBps must be a uint24, got ${toleranceBps}`)
  }
  const seen = new Set<Hex>()
  const guards: StateGuard[] = []
  for (const hop of cycle.hops) {
    if (seen.has(hop.poolId)) continue
    seen.add(hop.poolId)
    const state = states.get(hop.poolId)
    if (!state) throw new MissingPoolError(hop.poolId, 'state')
    guards.push(guardFor(state, toleranceBps, infos?.get(hop.poolId)))
  }
  return guards
}

/**
 * Guards as configured: `cfg.GUARD_TOLERANCE_BPS === 0` disables guards entirely (an empty guard
 * list), otherwise {@link toGuards} with that tolerance.
 */
export function guardsForConfig(
  cfg: Pick<Config, 'GUARD_TOLERANCE_BPS'>,
  cycle: Cycle,
  states: ReadonlyMap<Hex, PoolState>,
  infos?: ReadonlyMap<Hex, PoolInfo>,
): StateGuard[] {
  if (cfg.GUARD_TOLERANCE_BPS === 0) return []
  return toGuards(cycle, states, cfg.GUARD_TOLERANCE_BPS, infos)
}

/** ABI-encode `execute(steps, amountIn, minProfit, guards)`. */
export function encodeExecute(
  steps: readonly ExecutorStep[],
  amountIn: bigint,
  minProfit: bigint,
  guards: readonly StateGuard[],
): Hex {
  if (steps.length === 0) throw new RangeError('encodeExecute: at least one step is required')
  if (amountIn < 0n || minProfit < 0n) throw new RangeError('encodeExecute: amounts must be non-negative')
  return encodeFunctionData({
    abi: executorAbi,
    functionName: 'execute',
    args: [steps.map(abiStep), amountIn, minProfit, guards.map(abiGuard)],
  })
}

/** Decoded arguments of an `execute` call (the inverse of {@link encodeExecute}). */
export interface DecodedExecute {
  steps: ExecutorStep[]
  amountIn: bigint
  minProfit: bigint
  guards: StateGuard[]
}

/** Decode `execute` calldata back into bot-side types (addresses / ids lower-cased). */
export function decodeExecute(data: Hex): DecodedExecute {
  const decoded = decodeFunctionData({ abi: executorAbi, data })
  if (decoded.functionName !== 'execute') {
    throw new Error(`decodeExecute: expected execute calldata, got ${decoded.functionName}`)
  }
  const [steps, amountIn, minProfit, guards] = decoded.args
  return {
    steps: steps.map((s) => ({
      kind: asKind(s.kind),
      zeroForOne: s.zeroForOne,
      pool: s.pool.toLowerCase() as ExecutorStep['pool'],
      key: {
        currency0: s.key.currency0.toLowerCase() as ExecutorStep['key']['currency0'],
        currency1: s.key.currency1.toLowerCase() as ExecutorStep['key']['currency1'],
        fee: s.key.fee,
        tickSpacing: s.key.tickSpacing,
        hooks: s.key.hooks.toLowerCase() as ExecutorStep['key']['hooks'],
      },
    })),
    amountIn,
    minProfit,
    guards: guards.map((g) => ({
      kind: asKind(g.kind),
      poolId: g.poolId.toLowerCase() as Hex,
      expected: g.expected,
      toleranceBps: g.toleranceBps,
    })),
  }
}

function asKind(kind: number): ExecutorStep['kind'] {
  if (kind === 0 || kind === 1 || kind === 2) return kind
  throw new Error(`decodeExecute: unknown pool kind ${kind}`)
}

/** Shape a step exactly as the ABI struct expects (no extra properties, plain numbers for uint8/uint24/int24). */
function abiStep(step: ExecutorStep) {
  return {
    kind: step.kind,
    zeroForOne: step.zeroForOne,
    pool: step.pool,
    key: {
      currency0: step.key.currency0,
      currency1: step.key.currency1,
      fee: step.key.fee,
      tickSpacing: step.key.tickSpacing,
      hooks: step.key.hooks,
    },
  }
}

function abiGuard(guard: StateGuard) {
  return { kind: guard.kind, poolId: guard.poolId, expected: guard.expected, toleranceBps: guard.toleranceBps }
}
