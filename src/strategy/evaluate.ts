import type { Address, Hex } from 'viem'
import { log } from '../logger.js'
import type { Cycle, Opportunity, PoolInfo, PoolState, Simulator } from '../types.js'
import { cyclesTouching, selectTouched } from './cycles.js'
import { inputCurrency, outputCurrency } from './graph.js'
import { optimizeInput, type ProfitSample } from './optimize.js'

export interface EvaluateOptions {
  /** Smallest input to try, in the start currency's own units. */
  minInput: bigint
  /** Largest input to try, in the start currency's own units. */
  maxInput: bigint
  /** Block the states were read at (copied into the opportunity). */
  block: number
  /**
   * Skip the search when the product of marginal prices (net of fees) at the current state is
   * <= 1, i.e. an infinitesimal trade already loses. Exact for concave v4 swap curves; only
   * disable for simulators whose output is not concave in the input. Default true.
   */
  spotPrefilter?: boolean
  gridPoints?: number
  goldenIterations?: number
  refineEvaluations?: number
}

/** An `Opportunity` with search diagnostics. Structurally assignable to `Opportunity`. */
export interface EvaluatedOpportunity extends Opportunity {
  /** True if the best sample relied on a truncated hop (profit is a lower bound). */
  truncated: boolean
  /** Distinct inputs evaluated by the optimizer. */
  evaluations: number
}

const Q96 = 2 ** 96
const FEE_DENOMINATOR = 1_000_000

/**
 * Optimise the input for one cycle and return it as an opportunity, or `null` when the cycle is
 * not currently profitable, when a hop's state or info is missing, or when the cycle is malformed
 * (hop outputs do not chain / it does not close on `cycle.start`).
 */
export function evaluateCycle(
  cycle: Cycle,
  states: Map<Hex, PoolState>,
  infos: Map<Hex, PoolInfo>,
  simulate: Simulator,
  opts: EvaluateOptions,
): EvaluatedOpportunity | null {
  const hops = resolveHops(cycle, states, infos)
  if (!hops) return null
  if ((opts.spotPrefilter ?? true) && !spotProfitable(hops)) return null

  const result = optimizeInput((x) => chainProfit(hops, simulate, x), {
    minInput: opts.minInput,
    maxInput: opts.maxInput,
    ...(opts.gridPoints !== undefined ? { gridPoints: opts.gridPoints } : {}),
    ...(opts.goldenIterations !== undefined ? { goldenIterations: opts.goldenIterations } : {}),
    ...(opts.refineEvaluations !== undefined ? { refineEvaluations: opts.refineEvaluations } : {}),
  })
  if (!result || result.best.profit <= 0n) return null
  const { best } = result
  return {
    cycle,
    amountIn: best.amountIn,
    amountOut: best.amountOut,
    grossProfit: best.profit,
    block: opts.block,
    truncated: best.truncated,
    evaluations: result.evaluations,
  }
}

export interface EvaluateAllOptions extends EvaluateOptions {
  /** When given, only cycles touching one of these pools are evaluated. */
  touched?: Set<Hex>
  /** Optional index from `cyclesTouching` to speed up the `touched` filter. */
  index?: Map<Hex, Cycle[]>
}

/**
 * Evaluate many cycles against one block's states. Returns every profitable opportunity in the
 * cycles' order (unranked; see `rankOpportunities`). With `opts.touched` only affected cycles run.
 */
export function evaluateAll(
  cycles: Cycle[],
  states: Map<Hex, PoolState>,
  infos: Map<Hex, PoolInfo>,
  simulate: Simulator,
  opts: EvaluateAllOptions,
): EvaluatedOpportunity[] {
  const { touched, index, ...single } = opts
  const candidates = touched ? selectTouched(cycles, touched, index ?? cyclesTouching(cycles)) : cycles
  const out: EvaluatedOpportunity[] = []
  for (const cycle of candidates) {
    const opp = evaluateCycle(cycle, states, infos, simulate, single)
    if (opp) out.push(opp)
  }
  return out
}

/** A hop with its state and info bound, ready to simulate. */
interface ResolvedHop {
  state: PoolState
  info: PoolInfo
  zeroForOne: boolean
}

/**
 * Bind states / infos to hops and verify the path chains and closes. Returns `null` (and logs at
 * debug) when something is missing or inconsistent instead of throwing, so one bad cycle cannot
 * stall a block.
 */
function resolveHops(cycle: Cycle, states: Map<Hex, PoolState>, infos: Map<Hex, PoolInfo>): ResolvedHop[] | null {
  if (cycle.hops.length === 0) return null
  const start = cycle.start.toLowerCase() as Address
  let current = start
  const hops: ResolvedHop[] = []
  for (const hop of cycle.hops) {
    const state = states.get(hop.poolId)
    const info = infos.get(hop.poolId)
    if (!state || !info) {
      log.debug({ cycle: cycle.id, poolId: hop.poolId }, 'cycle skipped: missing state or info')
      return null
    }
    if (inputCurrency(info, hop.zeroForOne) !== current) {
      log.debug({ cycle: cycle.id, poolId: hop.poolId }, 'cycle skipped: hop input does not chain')
      return null
    }
    current = outputCurrency(info, hop.zeroForOne)
    hops.push({ state, info, zeroForOne: hop.zeroForOne })
  }
  if (current !== start) {
    log.debug({ cycle: cycle.id }, 'cycle skipped: does not close on start currency')
    return null
  }
  return hops
}

/** Effective swap fee (hundredths of a bip) for a direction, as in `Pool.swap`. */
export function effectiveSwapFee(state: PoolState, zeroForOne: boolean): number {
  const protocolFee = zeroForOne ? state.protocolFee & 0xfff : state.protocolFee >> 12
  if (protocolFee === 0) return state.lpFee
  return protocolFee + state.lpFee - Math.floor((protocolFee * state.lpFee) / FEE_DENOMINATOR)
}

/** Marginal output per unit of input at the current price, net of the swap fee (float, ranking only). */
export function marginalRate(state: PoolState, zeroForOne: boolean): number {
  const sqrtP = Number(state.sqrtPriceX96) / Q96
  const price = zeroForOne ? sqrtP * sqrtP : 1 / (sqrtP * sqrtP)
  return price * (1 - effectiveSwapFee(state, zeroForOne) / FEE_DENOMINATOR)
}

/** True if an infinitesimal trade around the cycle gains (product of marginal rates > 1). */
function spotProfitable(hops: ResolvedHop[]): boolean {
  let product = 1
  for (const hop of hops) product *= marginalRate(hop.state, hop.zeroForOne)
  // Tiny slack for float rounding; the exact search decides borderline cases.
  return product > 1 - 1e-9
}

/**
 * Run `amountIn` through every hop. A truncated hop contributes its partial output (a lower bound
 * on the real output) and the sample is marked truncated. A throwing simulator (which the math
 * contract forbids) is treated as zero output so the search continues.
 */
function chainProfit(hops: ResolvedHop[], simulate: Simulator, amountIn: bigint): ProfitSample {
  let amount = amountIn
  let truncated = false
  for (const hop of hops) {
    if (amount <= 0n) {
      amount = 0n
      break
    }
    try {
      const res = simulate(hop.state, hop.zeroForOne, amount)
      truncated = truncated || res.truncated
      amount = res.amountOut
    } catch (err) {
      log.debug({ err, poolId: hop.state.poolId, amount }, 'simulator threw; treating as zero output')
      return { amountIn, amountOut: 0n, profit: -amountIn, truncated: true }
    }
  }
  return { amountIn, amountOut: amount, profit: amount - amountIn, truncated }
}
