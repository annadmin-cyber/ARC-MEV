/**
 * Per-block arbitrage logic: advance the state cache (while the block header is fetched
 * concurrently), hand the cache's replayed logs to the hooked-pool probe (so the PoolManager
 * `Swap`s are fetched once per block, not twice), evaluate the affected cycles locally, probe
 * hooked pools through the V4Quoter, price gas with the next block's base fee, simulate the best
 * candidates on chain and send (or, in dry-run mode, describe) the winner, subject to the
 * circuit breaker and the rolling gas budget. `ArbBot.processBlock` never throws for chain-side
 * problems; the caller's loop logs and moves on.
 */
import type { Address, Hex } from 'viem'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import type { RpcClients } from '../rpc/client.js'
import type { StateCache } from '../state/cache.js'
import { rankOpportunities, type EvaluatedOpportunity, type HookedProbe, type InputBounds } from '../strategy/index.js'
import { poolKind, type PoolInfo, type PoolState } from '../types.js'
import { SendGate } from './breaker.js'
import { readBaseFee, readNextBaseFee, type NextBaseFee } from './gas.js'
import {
  boundsByStart,
  describeCycle,
  evaluateGroups,
  formatFixed,
  formatUsdc,
  pickBest,
  quoteCandidates,
  simulateCandidates,
  type CycleGroup,
  type ExecutionPlan,
  type SimulatedCandidate,
} from './pipeline.js'
import { errorMessage } from './simulate.js'
import type { Sender } from './sender.js'

/** Every this many blocks all cycles are evaluated, not only those touching pools that changed. */
export const FULL_EVAL_EVERY = 20

/** Candidates simulated on chain per block. */
export const MAX_SIMULATIONS = 3

/** Milliseconds spent in each stage of one block. */
export interface BlockTiming {
  logs: number
  eval: number
  probe: number
  sim: number
  send: number
}

/** How many touched pools were of each kind (for the per-block debug line). */
export interface TouchedKinds {
  v4: number
  v3: number
  v2: number
}

/** Count `touched` pool ids by kind according to `infos` (unknown ids count as v4). */
export function touchedKinds(touched: ReadonlySet<Hex>, infos: ReadonlyMap<Hex, PoolInfo>): TouchedKinds {
  const out: TouchedKinds = { v4: 0, v3: 0, v2: 0 }
  for (const id of touched) {
    const info = infos.get(id)
    const kind = info === undefined ? 0 : poolKind(info)
    if (kind === 1) out.v3++
    else if (kind === 2) out.v2++
    else out.v4++
  }
  return out
}

export interface ArbBotDeps {
  clients: RpcClients
  cfg: Config
  cache: StateCache
  infos: Map<Hex, PoolInfo>
  groups: CycleGroup[]
  /** Present only when `DRY_RUN=false`. */
  sender?: Sender
  /** Present when `PROBE_HOOKED_POOLS` is on and the store has hooked pools worth probing. */
  probe?: HookedProbe
  /** Circuit breaker + gas budget; a default one from `cfg` is built when absent. */
  gate?: SendGate
}

export class ArbBot {
  private blocksSinceFullEval = 0
  private readonly cycleCount: number
  /** Tracked pools plus the probe set, for executor encoding and descriptions. */
  private readonly allInfos: Map<Hex, PoolInfo>
  private readonly bounds: Map<Address, InputBounds>
  readonly gate: SendGate

  constructor(private readonly deps: ArbBotDeps) {
    this.cycleCount = deps.groups.reduce((n, g) => n + g.cycles.length, 0)
    this.allInfos = new Map([...deps.infos, ...(deps.probe ? deps.probe.infos() : [])])
    this.bounds = boundsByStart(deps.cfg)
    this.gate = deps.gate ?? new SendGate(deps.cfg)
  }

  /**
   * Handle block `block`: apply its logs (fetching the header at the same time), feed the replayed
   * logs to the probe (it fetches its own only when the cache refetched instead of replaying),
   * evaluate cycles touching the pools that changed (all cycles every {@link FULL_EVAL_EVERY}
   * blocks), probe hooked pools, and act on the best opportunity if any clears the profit bar
   * after gas and on-chain simulation.
   */
  async processBlock(block: bigint, skipped: bigint): Promise<void> {
    const { cfg, cache, clients, groups, probe } = this.deps
    const timing: BlockTiming = { logs: 0, eval: 0, probe: 0, sim: 0, send: 0 }
    const started = performance.now()

    const [{ touched, replayed }, header] = await Promise.all([
      cache.applyBlock(block),
      readNextBaseFee(clients, block).catch((error: unknown) => {
        log.warn({ block, err: errorMessage(error) }, 'could not read the block header, falling back to the latest base fee')
        return undefined
      }),
    ])
    let touchedHooked = new Set<Hex>()
    if (probe) {
      try {
        touchedHooked = await probe.advance(block, replayed)
      } catch (error) {
        log.warn({ block, err: errorMessage(error) }, 'probe: swap logs unavailable this block')
      }
    }
    timing.logs = elapsed(started)
    const kinds = touchedKinds(touched, this.allInfos)

    const full = this.blocksSinceFullEval >= FULL_EVAL_EVERY
    this.blocksSinceFullEval = full ? 0 : this.blocksSinceFullEval + 1
    const tEval = performance.now()
    let opps = full || touched.size > 0 ? evaluateGroups(cfg, groups, cache.all(), this.allInfos, block, full ? undefined : touched) : []
    timing.eval = elapsed(tEval)

    let states: ReadonlyMap<Hex, PoolState> = cache.all()
    if (probe && (touchedHooked.size > 0 || touched.size > 0)) {
      const tProbe = performance.now()
      const result = await probe.probe(block, states, this.bounds, touchedHooked, touched)
      timing.probe = elapsed(tProbe)
      log.debug(
        { block, touchedHooked: result.touchedHooked, candidates: result.candidates, probes: result.probes, calls: result.calls, latencyMs: result.latencyMs, found: result.opportunities.length },
        'probe: done',
      )
      if (result.opportunities.length > 0) {
        for (const opp of result.opportunities) {
          log.debug({ block, cycle: describeCycle(opp.cycle, this.allInfos), amountIn: opp.amountIn, grossProfit: opp.grossProfit, quoterGas: opp.quoterGas }, 'probe: quoted opportunity')
        }
        opps = rankOpportunities([...opps, ...result.opportunities], cfg.startCurrencies)
        states = new Map([...cache.all(), ...probe.states()])
      }
    }

    if (opps.length === 0) {
      log.debug({ block, skipped, touched: touched.size, touchedKinds: kinds, touchedHooked: touchedHooked.size, full, timing }, 'block: no opportunity')
      return
    }

    const baseFee = await this.baseFeeFor(header)
    const candidates = quoteCandidates(cfg, opps, baseFee, MAX_SIMULATIONS)
    const best = opps[0]
    if (candidates.length === 0 || !best) {
      log.info(
        {
          block,
          opportunities: opps.length,
          bestGrossUsdc: best?.grossProfitUsdc === undefined ? undefined : formatUsdc(best.grossProfitUsdc),
          bestProbed: best?.probed ?? false,
          nextBaseFeeGwei: formatFixed(baseFee, 9, 2),
          touchedKinds: kinds,
          timing,
        },
        'opportunities found but none clears gas + MIN_PROFIT',
      )
      return
    }

    if (!cfg.EXECUTOR_ADDRESS) {
      const top = candidates[0]
      if (top) {
        log.info(
          {
            block,
            cycle: describeCycle(top.opp.cycle, this.allInfos),
            probed: top.opp.probed ?? false,
            amountIn: top.opp.amountIn,
            expectedGrossUsdc: formatUsdc(top.expected18),
            netUsdc: formatUsdc(top.quote.net),
            tipGwei: formatFixed(top.quote.maxPriorityFeePerGas, 9, 2),
            timing,
          },
          'would send (not simulated: EXECUTOR_ADDRESS is not set)',
        )
      }
      return
    }

    const tSim = performance.now()
    const simulated = await simulateCandidates(clients, cfg, candidates, states as Map<Hex, PoolState>, this.allInfos, block)
    timing.sim = elapsed(tSim)
    const plan = pickBest(cfg, simulated, baseFee)
    if (!plan) {
      log.info({ block, candidates: simulated.map((s) => this.summariseSim(s)), timing }, 'candidates rejected by on-chain simulation')
      return
    }

    const tSend = performance.now()
    await this.act(plan, block)
    timing.send = elapsed(tSend)
    log.debug({ block, timing, cycles: this.cycleCount }, 'block done')
  }

  /** The next block's base fee from the header read alongside the logs, or the latest base fee as a fallback. */
  private async baseFeeFor(header: NextBaseFee | undefined): Promise<bigint> {
    if (header) return header.nextBaseFee
    const { baseFee } = await readBaseFee(this.deps.clients)
    return (baseFee * 1125n) / 1000n
  }

  /** Send the plan, or describe what would be sent in dry-run mode / while sending is blocked. */
  private async act(plan: ExecutionPlan, block: bigint): Promise<void> {
    const { cfg, sender } = this.deps
    const opp = plan.candidate.opp
    const details = {
      block,
      cycle: describeCycle(opp.cycle, this.allInfos),
      probed: opp.probed ?? false,
      amountIn: opp.amountIn,
      expectedGrossUsdc: formatUsdc(plan.candidate.expected18),
      simulatedGrossUsdc: formatUsdc(plan.simulatedProfit18),
      netUsdc: formatUsdc(plan.quote.net),
      minProfit: plan.minProfit,
      gas: plan.gas,
      gasSource: plan.gasSource,
      maxFeeGwei: formatFixed(plan.quote.maxFeePerGas, 9, 2),
      tipGwei: formatFixed(plan.quote.maxPriorityFeePerGas, 9, 2),
      gasCostUsdc: formatUsdc(plan.quote.gasCost),
      guards: plan.guards.length,
      truncated: opp.truncated,
    }
    if (cfg.DRY_RUN || !sender) {
      log.info(details, 'would send (DRY_RUN)')
      return
    }
    const blocked = this.gate.check(block)
    if (blocked) {
      if (blocked.kind === 'breaker') log.warn({ ...details, pausedUntil: blocked.until }, 'would send (circuit breaker paused sending)')
      else log.warn({ ...details, spentUsdc: formatUsdc(blocked.spent), budgetUsdc: formatUsdc(blocked.budget), freesAt: blocked.freesAt }, 'would send (gas budget exhausted)')
      return
    }
    if (!sender.canSend(block)) {
      log.warn({ ...details, inFlight: sender.inFlight }, 'skipping: a transaction is still in flight')
      return
    }
    const sent = await sender.send(plan.tx, block)
    log.info({ ...details, hash: sent.hash, nonce: sent.nonce, sentTo: sent.sentTo }, 'sent')
    // Do not hold up the block loop for the receipt; the in-flight guard prevents double sends.
    void sender
      .waitForReceipt(sent.hash)
      .then((summary) => this.settle(block, summary))
      .catch((error: unknown) => {
        log.warn({ err: error, hash: sent.hash }, 'receipt wait failed')
        this.settle(block, undefined)
      })
  }

  /** Feed a receipt (or its absence) to the breaker and the gas budget. */
  private settle(sentAtBlock: bigint, summary: Awaited<ReturnType<Sender['waitForReceipt']>>): void {
    const tripped = summary ? this.gate.onReceipt(summary.blockNumber, summary.status, summary.feePaid) : this.gate.onLost(sentAtBlock)
    if (tripped) {
      log.warn(
        { pausedUntil: this.gate.breaker.pausedUntilBlock(), trips: this.gate.breaker.tripCount, maxConsecutive: this.gate.breaker.maxConsecutive },
        'circuit breaker tripped: sending paused',
      )
    }
  }

  private summariseSim(sim: SimulatedCandidate): Record<string, unknown> {
    return {
      cycle: describeCycle(sim.candidate.opp.cycle, this.allInfos),
      probed: sim.candidate.opp.probed ?? false,
      amountIn: sim.candidate.opp.amountIn,
      expectedGrossUsdc: formatUsdc(sim.candidate.expected18),
      ...(sim.result.ok ? { simulatedProfit: sim.result.profit, gas: sim.result.gas } : { reason: sim.result.reason }),
    }
  }
}

function elapsed(since: number): number {
  return Math.round((performance.now() - since) * 10) / 10
}

/** Re-exported so callers of the bot can type its opportunities without importing the strategy. */
export type { EvaluatedOpportunity }
