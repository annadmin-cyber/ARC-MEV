/**
 * Translation of a strategy `Cycle` into the calldata `ArcArbExecutor.execute` expects.
 *
 * Every hop of a cycle is a Uniswap v4 pool (kind 0); the executor's v3/v2 kinds are not produced
 * here because discovery only knows v4 pools. Guards are one per distinct pool and carry the
 * sqrtPriceX96 the local simulation was based on, so the contract reverts before swapping if a
 * pool moved by more than `toleranceBps` since the state was read.
 */
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem'
import { executorAbi } from '../abi/index.js'
import type { Config } from '../config.js'
import { NATIVE, type Cycle, type ExecutorStep, type PoolInfo, type PoolState, type StateGuard } from '../types.js'

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

/**
 * Build the executor steps for `cycle`, in hop order. Each step is a v4 hop whose key is the
 * pool's `PoolKey` (currency0, currency1, fee, tickSpacing, hooks) and whose direction is the
 * hop's `zeroForOne`. Throws {@link MissingPoolError} if a hop's pool is not in `infos`.
 */
export function toExecutorSteps(cycle: Cycle, infos: ReadonlyMap<Hex, PoolInfo>): ExecutorStep[] {
  return cycle.hops.map((hop) => {
    const info = infos.get(hop.poolId)
    if (!info) throw new MissingPoolError(hop.poolId, 'info')
    return {
      kind: 0,
      zeroForOne: hop.zeroForOne,
      pool: NATIVE,
      key: {
        currency0: info.currency0,
        currency1: info.currency1,
        fee: info.fee,
        tickSpacing: info.tickSpacing,
        hooks: info.hooks,
      },
    }
  })
}

/**
 * One v4 price guard per distinct pool of `cycle` (first occurrence order), expecting the
 * `sqrtPriceX96` currently held in `states`. Throws {@link MissingPoolError} if a state is missing.
 * `toleranceBps` is the deviation the contract tolerates; 0 means the price must match exactly.
 */
export function toGuards(cycle: Cycle, states: ReadonlyMap<Hex, PoolState>, toleranceBps: number): StateGuard[] {
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
    guards.push({ kind: 0, poolId: hop.poolId, expected: state.sqrtPriceX96, toleranceBps })
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
): StateGuard[] {
  if (cfg.GUARD_TOLERANCE_BPS === 0) return []
  return toGuards(cycle, states, cfg.GUARD_TOLERANCE_BPS)
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
