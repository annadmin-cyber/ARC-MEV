/**
 * The per-block decision pipeline shared by the bot loop (`src/main.ts`) and the one-shot scanner
 * (`src/cli/scan.ts`): evaluate cycles (per start currency, so input bounds are scaled to that
 * currency's decimals), rank, price the gas, simulate the best few on chain and turn the winner
 * into a ready-to-sign transaction.
 */
import { formatUnits, type Address, type Hex } from 'viem'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { makeSimulator } from '../math/hop.js'
import type { RpcClients } from '../rpc/client.js'
import { cyclesTouching, evaluateAll, from18, rankOpportunities, to18, type EvaluatedOpportunity, type InputBounds } from '../strategy/index.js'
import { NATIVE, poolKind, type Cycle, type ExecutorStep, type PoolInfo, type PoolState, type StateGuard } from '../types.js'
import { encodeExecute, guardsForConfig, toExecutorSteps } from './encode.js'
import { feePolicy, type FeeQuote } from './gas.js'
import type { PreparedTx } from './sender.js'
import { simulateOnChain, type SimulationResult } from './simulate.js'

/** Arc's single-transaction gas cap. */
export const TX_GAS_CAP = 16_777_216n

/** Headroom added to an `eth_estimateGas` result (numerator / denominator). */
const GAS_HEADROOM = { num: 12n, den: 10n }

/** Cycles that share a start currency, with the input bounds expressed in that currency's units. */
export interface CycleGroup {
  start: Address
  decimals: number
  cycles: Cycle[]
  /** poolId -> cycles of this group touching it (for incremental evaluation). */
  index: Map<Hex, Cycle[]>
  minInput: bigint
  maxInput: bigint
}

/**
 * Optimiser input bounds for a start currency with `decimals`: `maxInput` is `MAX_INPUT_USDC_WEI`
 * scaled from 18 decimals to the currency's, and `minInput` is `MIN_PROFIT_USDC_WEI` scaled the
 * same way (an input smaller than the minimum profit cannot plausibly earn it), never below 1.
 */
export function inputBoundsFor(cfg: Pick<Config, 'MIN_PROFIT_USDC_WEI' | 'MAX_INPUT_USDC_WEI'>, decimals: number): InputBounds {
  const minInput = from18(cfg.MIN_PROFIT_USDC_WEI, decimals)
  return { minInput: minInput < 1n ? 1n : minInput, maxInput: from18(cfg.MAX_INPUT_USDC_WEI, decimals) }
}

/** {@link inputBoundsFor} for every configured start currency, keyed by (lower-cased) address. */
export function boundsByStart(cfg: Pick<Config, 'startCurrencies' | 'MIN_PROFIT_USDC_WEI' | 'MAX_INPUT_USDC_WEI'>): Map<Address, InputBounds> {
  const out = new Map<Address, InputBounds>()
  for (const [start, decimals] of cfg.startCurrencies) out.set(start, inputBoundsFor(cfg, decimals))
  return out
}

/**
 * Group `cycles` by start currency with the optimiser bounds of {@link inputBoundsFor}. Cycles
 * whose start currency has no configured decimals are dropped with a warning.
 */
export function groupCycles(
  cfg: Pick<Config, 'startCurrencies' | 'MIN_PROFIT_USDC_WEI' | 'MAX_INPUT_USDC_WEI'>,
  cycles: readonly Cycle[],
): CycleGroup[] {
  const byStart = new Map<Address, Cycle[]>()
  for (const cycle of cycles) {
    const start = cycle.start.toLowerCase() as Address
    const list = byStart.get(start)
    if (list) list.push(cycle)
    else byStart.set(start, [cycle])
  }
  const groups: CycleGroup[] = []
  for (const [start, list] of byStart) {
    const decimals = cfg.startCurrencies.get(start)
    if (decimals === undefined) {
      log.warn({ start, cycles: list.length }, 'dropping cycles: start currency has no configured decimals')
      continue
    }
    groups.push({ start, decimals, cycles: list, index: cyclesTouching(list), ...inputBoundsFor(cfg, decimals) })
  }
  return groups
}

/**
 * Evaluate every group against `states` with the exact local simulator (dispatching on each
 * pool's kind: v4 / v3 tick walk, v2 constant product) and return the ranked opportunities
 * (USDC-normalised, best first, at most one per pool). With `touched`, only cycles through a
 * touched pool are evaluated.
 */
export function evaluateGroups(
  cfg: Pick<Config, 'startCurrencies'>,
  groups: readonly CycleGroup[],
  states: Map<Hex, PoolState>,
  infos: Map<Hex, PoolInfo>,
  block: bigint,
  touched?: Set<Hex>,
): EvaluatedOpportunity[] {
  const all: EvaluatedOpportunity[] = []
  const simulate = makeSimulator(infos)
  for (const group of groups) {
    const opps = evaluateAll(group.cycles, states, infos, simulate, {
      minInput: group.minInput,
      maxInput: group.maxInput,
      block: Number(block),
      ...(touched ? { touched, index: group.index } : {}),
    })
    all.push(...opps)
  }
  return rankOpportunities(all, cfg.startCurrencies)
}

/** An opportunity whose expected profit covers gas with margin, with the fee quote that says so. */
export interface Candidate {
  opp: EvaluatedOpportunity
  /** Expected gross profit in USDC wei (18 decimals). */
  expected18: bigint
  /** Fee quote at `cfg.QUOTE_GAS` (before any gas estimate exists). */
  quote: FeeQuote
}

/**
 * Keep the opportunities whose net profit at the current base fee and `cfg.QUOTE_GAS` exceeds
 * `MIN_PROFIT_USDC_WEI`, in ranking order, at most `max` of them.
 */
export function quoteCandidates(
  cfg: Pick<Config, 'TIP_SHARE' | 'MIN_PRIORITY_FEE_WEI' | 'MAX_PRIORITY_FEE_WEI' | 'MAX_FEE_PER_GAS_WEI' | 'GAS_SAFETY' | 'QUOTE_GAS' | 'MIN_PROFIT_USDC_WEI'>,
  opps: readonly EvaluatedOpportunity[],
  baseFee: bigint,
  max = 3,
): Candidate[] {
  const out: Candidate[] = []
  for (const opp of opps) {
    if (out.length >= max) break
    const expected18 = opp.grossProfitUsdc
    if (expected18 === undefined) continue
    const quote = feePolicy(cfg, baseFee, expected18, BigInt(cfg.QUOTE_GAS))
    if (!quote || quote.net <= cfg.MIN_PROFIT_USDC_WEI) continue
    out.push({ opp, expected18, quote })
  }
  return out
}

/** A candidate together with its executor calldata inputs and the on-chain simulation outcome. */
export interface SimulatedCandidate {
  candidate: Candidate
  steps: ExecutorStep[]
  guards: StateGuard[]
  result: SimulationResult
}

/** Encode and simulate every candidate at `block` (in parallel; callers pass at most a few). */
export async function simulateCandidates(
  clients: Pick<RpcClients, 'http'>,
  cfg: Pick<Config, 'PRIVATE_KEY' | 'EXECUTOR_ADDRESS' | 'GAS_LIMIT' | 'GUARD_TOLERANCE_BPS'>,
  candidates: readonly Candidate[],
  states: Map<Hex, PoolState>,
  infos: Map<Hex, PoolInfo>,
  block: bigint,
): Promise<SimulatedCandidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      let steps: ExecutorStep[]
      let guards: StateGuard[]
      try {
        steps = toExecutorSteps(candidate.opp.cycle, infos)
        guards = guardsForConfig(cfg, candidate.opp.cycle, states, infos)
      } catch (error) {
        return { candidate, steps: [], guards: [], result: { ok: false, reason: `encode: ${(error as Error).message}` } }
      }
      const result = await simulateOnChain(clients, cfg, candidate.opp, steps, guards, block)
      return { candidate, steps, guards, result }
    }),
  )
}

/** The chosen opportunity, fully priced with its simulated profit and estimated gas. */
export interface ExecutionPlan {
  candidate: Candidate
  steps: ExecutorStep[]
  guards: StateGuard[]
  /** Profit returned by the on-chain simulation, in start currency units. */
  simulatedProfit: bigint
  /** The same in USDC wei (18 decimals). */
  simulatedProfit18: bigint
  /** Gas limit for the transaction (estimate plus headroom, or `cfg.GAS_LIMIT`). */
  gas: bigint
  gasSource: 'estimate' | 'config'
  /** Fee quote at `gas` and the simulated profit. */
  quote: FeeQuote
  /** `minProfit` argument for `execute`, in start currency units: minimum net profit plus the safe gas cost. */
  minProfit: bigint
  tx: PreparedTx
}

/**
 * Among the simulated candidates, pick the one with the highest net profit after re-pricing gas
 * with the simulated profit and the estimated gas limit; `undefined` when none simulates
 * successfully with a net above `MIN_PROFIT_USDC_WEI`.
 */
export function pickBest(
  cfg: Pick<
    Config,
    | 'TIP_SHARE'
    | 'MIN_PRIORITY_FEE_WEI'
    | 'MAX_PRIORITY_FEE_WEI'
    | 'MAX_FEE_PER_GAS_WEI'
    | 'GAS_SAFETY'
    | 'GAS_LIMIT'
    | 'MIN_PROFIT_USDC_WEI'
    | 'startCurrencies'
    | 'EXECUTOR_ADDRESS'
  >,
  simulated: readonly SimulatedCandidate[],
  baseFee: bigint,
): ExecutionPlan | undefined {
  let best: ExecutionPlan | undefined
  for (const sim of simulated) {
    const plan = planFor(cfg, sim, baseFee)
    if (plan && (!best || plan.quote.net > best.quote.net)) best = plan
  }
  return best
}

/** Turn one successful simulation into a plan, or `undefined` if it does not clear the profit bar. */
export function planFor(
  cfg: Parameters<typeof pickBest>[0],
  sim: SimulatedCandidate,
  baseFee: bigint,
): ExecutionPlan | undefined {
  if (!sim.result.ok || !cfg.EXECUTOR_ADDRESS) return undefined
  const decimals = cfg.startCurrencies.get(sim.candidate.opp.cycle.start.toLowerCase() as Address)
  if (decimals === undefined) return undefined
  const gas = sim.result.gasSource === 'estimate' ? withHeadroom(sim.result.gas) : capGas(BigInt(cfg.GAS_LIMIT))
  const simulatedProfit18 = to18(sim.result.profit, decimals)
  const quote = feePolicy(cfg, baseFee, simulatedProfit18, gas)
  if (!quote || quote.net <= cfg.MIN_PROFIT_USDC_WEI) return undefined
  const minProfit = from18(cfg.MIN_PROFIT_USDC_WEI + quote.safeGasCost, decimals)
  const data = encodeExecute(sim.steps, sim.candidate.opp.amountIn, minProfit, sim.guards)
  return {
    candidate: sim.candidate,
    steps: sim.steps,
    guards: sim.guards,
    simulatedProfit: sim.result.profit,
    simulatedProfit18,
    gas,
    gasSource: sim.result.gasSource,
    quote,
    minProfit,
    tx: {
      to: cfg.EXECUTOR_ADDRESS.toLowerCase() as Address,
      data,
      gas,
      maxFeePerGas: quote.maxFeePerGas,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    },
  }
}

/** Estimate + 20 %, capped at the chain's transaction gas cap. */
export function withHeadroom(estimate: bigint): bigint {
  return capGas((estimate * GAS_HEADROOM.num) / GAS_HEADROOM.den)
}

/** `gas` clamped to the chain's per-transaction gas cap. */
export function capGas(gas: bigint): bigint {
  return gas > TX_GAS_CAP ? TX_GAS_CAP : gas
}

/** `1234567890000000000` -> `"1.234568"` (USDC with 18 decimals, 6 shown). */
export function formatUsdc(amount18: bigint): string {
  return formatFixed(amount18, 18, 6)
}

/** Format `amount` with `decimals`, showing at most `places` fractional digits (trailing zeros trimmed). */
export function formatFixed(amount: bigint, decimals: number, places: number): string {
  const s = formatUnits(amount, decimals)
  const [whole, frac = ''] = s.split('.')
  const trimmed = frac.slice(0, places).replace(/0+$/, '')
  return trimmed.length > 0 ? `${whole}.${trimmed}` : (whole ?? '0')
}

/** Short label for a currency: `native` for address(0), `usdc` for the ERC-20 predeploy, else `0xabcd…ef01`. */
export function currencyLabel(currency: Address): string {
  const c = currency.toLowerCase()
  if (c === NATIVE) return 'native'
  if (c === '0x3600000000000000000000000000000000000000') return 'usdc'
  return `${c.slice(0, 6)}…${c.slice(-4)}`
}

/**
 * Short venue tag for a pool: empty for a hookless v4 pool, `hook` for a hooked v4 pool,
 * `v3`/`v2` (with `:<venue>` when discovery recorded the factory name) for the other kinds.
 */
export function venueLabel(info: Pick<PoolInfo, 'kind' | 'hooks' | 'venue'>): string {
  const kind = poolKind(info)
  if (kind === 0) return info.hooks.toLowerCase() === NATIVE ? '' : 'hook'
  const base = kind === 1 ? 'v3' : 'v2'
  return info.venue ? `${base}:${info.venue}` : base
}

/**
 * One-line description of a cycle with each hop's pool tag ({@link poolTag}), venue tag and fee:
 * `native -[ba2b9bdf 3%]-> 0xc8c2…3e22 -[82916bee v3:uniswap-v3 0.01%]-> native`.
 */
export function describeCycle(cycle: Cycle, infos: ReadonlyMap<Hex, PoolInfo>): string {
  let text = currencyLabel(cycle.start.toLowerCase() as Address)
  for (const hop of cycle.hops) {
    const info = infos.get(hop.poolId)
    const next = info === undefined ? undefined : hop.zeroForOne ? info.currency1 : info.currency0
    const fee = info === undefined ? '?' : feePercent(info.fee)
    const venue = info === undefined ? '' : venueLabel(info)
    text += ` -[${poolTag(hop.poolId, info)}${venue ? ` ${venue}` : ''} ${fee}]-> ${next === undefined ? '?' : currencyLabel(next)}`
  }
  return text
}

/**
 * Eight hex digits identifying a pool in logs: the first eight of a v4 pool id, or of the contract
 * address of a v3/v2 pool (whose pool id is the address left-padded with zeros, which would print
 * as `00000000`).
 */
export function poolTag(poolId: Hex, info?: Pick<PoolInfo, 'kind' | 'pool'>): string {
  const address = info && poolKind(info) !== 0 ? info.pool : undefined
  return (address ?? poolId).slice(2, 10)
}

/** `3000` -> `"0.3%"`, `0x800000` -> `"dyn"`. */
export function feePercent(fee: number): string {
  if ((fee & 0x800000) !== 0) return 'dyn'
  return `${formatFixed(BigInt(fee), 4, 4)}%`
}
