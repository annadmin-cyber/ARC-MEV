/**
 * Per-block arbitrage logic: advance the state cache, evaluate the affected cycles, price gas,
 * simulate the best candidates on chain and send (or, in dry-run mode, describe) the winner.
 * `ArbBot.processBlock` never throws for chain-side problems; the caller's loop logs and moves on.
 */
import type { Hex } from 'viem'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import type { RpcClients } from '../rpc/client.js'
import type { StateCache } from '../state/cache.js'
import type { PoolInfo } from '../types.js'
import { readBaseFee } from './gas.js'
import {
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
import type { Sender } from './sender.js'

/** Every this many blocks all cycles are evaluated, not only those touching pools that changed. */
export const FULL_EVAL_EVERY = 20

/** Candidates simulated on chain per block. */
export const MAX_SIMULATIONS = 3

/** Milliseconds spent in each stage of one block. */
export interface BlockTiming {
  logs: number
  eval: number
  sim: number
  send: number
}

export interface ArbBotDeps {
  clients: RpcClients
  cfg: Config
  cache: StateCache
  infos: Map<Hex, PoolInfo>
  groups: CycleGroup[]
  /** Present only when `DRY_RUN=false`. */
  sender?: Sender
}

export class ArbBot {
  private blocksSinceFullEval = 0
  private readonly cycleCount: number

  constructor(private readonly deps: ArbBotDeps) {
    this.cycleCount = deps.groups.reduce((n, g) => n + g.cycles.length, 0)
  }

  /**
   * Handle block `block`: apply its logs, evaluate cycles touching the pools that changed (all
   * cycles every {@link FULL_EVAL_EVERY} blocks), and act on the best opportunity if any clears
   * the profit bar after gas and on-chain simulation.
   */
  async processBlock(block: bigint, skipped: bigint): Promise<void> {
    const { cfg, cache, clients, infos, groups } = this.deps
    const timing: BlockTiming = { logs: 0, eval: 0, sim: 0, send: 0 }
    const started = performance.now()

    const { touched } = await cache.applyBlock(block)
    timing.logs = elapsed(started)

    const full = this.blocksSinceFullEval >= FULL_EVAL_EVERY
    this.blocksSinceFullEval = full ? 0 : this.blocksSinceFullEval + 1
    const tEval = performance.now()
    const opps = full || touched.size > 0 ? evaluateGroups(cfg, groups, cache.all(), infos, block, full ? undefined : touched) : []
    timing.eval = elapsed(tEval)

    if (opps.length === 0) {
      log.debug({ block, skipped, touched: touched.size, full, timing }, 'block: no opportunity')
      return
    }

    const { baseFee } = await readBaseFee(clients)
    const candidates = quoteCandidates(cfg, opps, baseFee, MAX_SIMULATIONS)
    const best = opps[0]
    if (candidates.length === 0 || !best) {
      log.info(
        {
          block,
          opportunities: opps.length,
          bestGrossUsdc: best?.grossProfitUsdc === undefined ? undefined : formatUsdc(best.grossProfitUsdc),
          baseFeeGwei: formatFixed(baseFee, 9, 2),
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
            cycle: describeCycle(top.opp.cycle, infos),
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
    const simulated = await simulateCandidates(clients, cfg, candidates, cache.all(), infos, block)
    timing.sim = elapsed(tSim)
    const plan = pickBest(cfg, simulated, baseFee)
    if (!plan) {
      log.info({ block, candidates: simulated.map((s) => summariseSim(s, infos)), timing }, 'candidates rejected by on-chain simulation')
      return
    }

    const tSend = performance.now()
    await this.act(plan, block)
    timing.send = elapsed(tSend)
    log.debug({ block, timing, cycles: this.cycleCount }, 'block done')
  }

  /** Send the plan, or describe what would be sent in dry-run mode. */
  private async act(plan: ExecutionPlan, block: bigint): Promise<void> {
    const { cfg, infos, sender } = this.deps
    const details = {
      block,
      cycle: describeCycle(plan.candidate.opp.cycle, infos),
      amountIn: plan.candidate.opp.amountIn,
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
      truncated: plan.candidate.opp.truncated,
    }
    if (cfg.DRY_RUN || !sender) {
      log.info(details, 'would send (DRY_RUN)')
      return
    }
    if (!sender.canSend(block)) {
      log.warn({ ...details, inFlight: sender.inFlight }, 'skipping: a transaction is still in flight')
      return
    }
    const sent = await sender.send(plan.tx, block)
    log.info({ ...details, hash: sent.hash, nonce: sent.nonce, sentTo: sent.sentTo }, 'sent')
    // Do not hold up the block loop for the receipt; the in-flight guard prevents double sends.
    void sender.waitForReceipt(sent.hash).catch((error: unknown) => log.warn({ err: error, hash: sent.hash }, 'receipt wait failed'))
  }
}

function elapsed(since: number): number {
  return Math.round((performance.now() - since) * 10) / 10
}

function summariseSim(sim: SimulatedCandidate, infos: Map<Hex, PoolInfo>): Record<string, unknown> {
  return {
    cycle: describeCycle(sim.candidate.opp.cycle, infos),
    amountIn: sim.candidate.opp.amountIn,
    expectedGrossUsdc: formatUsdc(sim.candidate.expected18),
    ...(sim.result.ok ? { simulatedProfit: sim.result.profit, gas: sim.result.gas } : { reason: sim.result.reason }),
  }
}
