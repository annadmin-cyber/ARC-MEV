/**
 * Hooked-pool probing.
 *
 * Hooked Uniswap v4 pools (beforeSwap / afterSwap with return deltas, dynamic fees charged by the
 * hook) cannot be priced by the local tick-walk simulator, but the on-chain `V4Quoter` can price
 * a hop through them exactly. This module keeps a "probe set" of the most active hooked pools with
 * only their `sqrtPriceX96` (plus tick / liquidity / fee from the same `Swap` logs) tracked, and on
 * every block:
 *
 * 1. For every probe pool P on pair (A, B) that was touched (or whose sibling tracked pool Q was
 *    touched), and every tracked pool Q of any kind on the same pair, compute the spot spread
 *    `|ln(priceP / priceQ)|` in bps. Keep pairs above `minSpreadBps`, most-spread first, at most
 *    `maxPerBlock`.
 * 2. For each kept (P, Q) and each start currency S among {A, B}, the two 2-hop cycles
 *    `S -P-> T -Q-> S` and `S -Q-> T -P-> S` are candidates; only the direction whose fee-adjusted
 *    spot rate product exceeds 1 is quoted (the other loses by construction).
 * 3. The kept cycles are quoted at `grid` log-spaced inputs between the start currency's
 *    `minInput` and `maxInput` in one batch of `eth_call`s to `V4Quoter.quoteExactInput`: the
 *    hooked hop on chain, the tracked hop locally with `simulateHop`, chained in cycle order
 *    (P first: quote P then simulate Q on its output; Q first: simulate Q then quote P on its
 *    output). The best grid point is refined once with two more points (a second batch), and the
 *    best sample becomes an `Opportunity` marked `probed` for the normal ranking -> executor
 *    simulation -> send path.
 *
 * All chain I/O goes through the injected {@link ProbeIo}, so the logic is unit-testable with fakes.
 */
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem'
import { poolManagerAbi, v4QuoterAbi } from '../abi/index.js'
import type { StoredPool } from '../discovery/store.js'
import { log } from '../logger.js'
import { simulateHop } from '../math/hop.js'
import type { RawLog } from '../rpc/logs.js'
import { NATIVE, type Cycle, type Hop, type PoolInfo, type PoolState } from '../types.js'
import { cycleId } from './cycles.js'
import { marginalRate, type EvaluatedOpportunity } from './evaluate.js'
import { directionFrom, otherCurrency, pairKey } from './graph.js'
import { fromLog, isBetterSample, toLog, type ProfitSample } from './optimize.js'

/** One `eth_call` of the quoter. */
export interface QuoteCall {
  to: Address
  data: Hex
}

/** Outcome of one quoter call: the raw return data, or why it failed. */
export type QuoteOutcome = { ok: true; data: Hex } | { ok: false; reason: string }

/** Runs a batch of quoter calls at `block` (one JSON-RPC batch) and answers in the same order. */
export type QuoteCaller = (calls: readonly QuoteCall[], block: bigint) => Promise<QuoteOutcome[]>

/** The parts of a pool's `slot0` the probe needs at start-up. */
export interface Slot0Snapshot {
  sqrtPriceX96: bigint
  tick: number
  lpFee: number
}

/** Chain access the probe needs; see `src/exec/probeIo.ts` for the live implementation. */
export interface ProbeIo {
  call: QuoteCaller
  /** PoolManager `Swap` logs for the inclusive block range (already topic-filtered). */
  fetchSwapLogs(fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>
  /** `slot0` of the given v4 pools at `block`; pools missing from the result stay unpriced. */
  readSlot0s(poolIds: readonly Hex[], block: bigint): Promise<Map<Hex, Slot0Snapshot>>
}

export interface ProbeSettings {
  /** V4Quoter contract address. */
  quoter: Address
  /** (hooked, tracked) pool pairs quoted per block, most-spread first. */
  maxPerBlock: number
  /** Only pairs whose spot prices differ by more than this many bps are quoted. */
  minSpreadBps: number
  /** Log-spaced inputs per quoted cycle. */
  grid: number
  /** Blocks of `Swap` logs replayed at most when the probe falls behind the head. Default 50. */
  maxReplayBlocks?: number
  /**
   * PoolManager address (lower-cased). When set, `observeSwapLogs` ignores logs from any other
   * emitter, so the unfiltered per-block logs of the state cache can be handed to the probe.
   */
  poolManager?: Address
}

/** Input bounds per start currency, in that currency's own units. */
export interface InputBounds {
  minInput: bigint
  maxInput: bigint
}

/** What the probe tracks for a hooked pool between blocks. */
export interface ProbePrice {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  /** Swap fee the pool charged in its last swap (the `fee` field of the Swap event), pips. */
  lpFee: number
  block: number
}

/** A (hooked, tracked) pool pair worth quoting. */
export interface ProbeCandidate {
  hooked: PoolInfo
  tracked: PoolInfo
  spreadBps: number
}

/** A concrete cycle to quote and how its hops split between chain and local simulation. */
export interface ProbeCycle {
  cycle: Cycle
  hooked: PoolInfo
  tracked: PoolInfo
  /** True when the hooked pool is the first hop (quote first, then simulate). */
  hookedFirst: boolean
  hookedZeroForOne: boolean
  trackedZeroForOne: boolean
  bounds: InputBounds
}

export interface ProbeResult {
  opportunities: ProbedOpportunity[]
  /** Pairs above the spread threshold before the cap. */
  candidates: number
  /** Cycles quoted. */
  probes: number
  /** Quoter `eth_call`s issued (both batches). */
  calls: number
  /** Wall time spent in the quoter batches, ms. */
  latencyMs: number
  /** Probe pools touched by Swap logs this block. */
  touchedHooked: number
}

/** An opportunity produced by the probe. */
export interface ProbedOpportunity extends EvaluatedOpportunity {
  probed: true
  /** The quoter's gas estimate for the hooked hop at the chosen input (0 if unavailable). */
  quoterGas: bigint
}

const Q96 = 2 ** 96
const DEFAULT_MAX_REPLAY_BLOCKS = 50
/** Topic0 of the PoolManager `Swap` event (the only log the probe reads). */
const V4_SWAP_TOPIC = toEventSelector(poolManagerAbi.find((i) => i.type === 'event' && i.name === 'Swap') as AbiEvent)

/** Logs another component already fetched for a block range (see `StateCache.applyBlock`). */
export interface PrefetchedLogs {
  /** First block the logs cover (inclusive); they must extend to the block `advance` is called with. */
  fromBlock: bigint
  logs: readonly RawLog[]
}

/**
 * Choose the probe set from the discovery store: hooked pools with liquidity that share a pair
 * (with a start currency on it) with at least one tracked pool, most active first
 * (`swapCount` desc, `lastSwapBlock` desc, `poolId` asc), at most `maxPools`.
 */
export function selectProbePools(
  pools: Iterable<StoredPool>,
  tracked: readonly PoolInfo[],
  startCurrencies: ReadonlySet<Address>,
  maxPools = 500,
): PoolInfo[] {
  const trackedPairs = new Set<string>()
  for (const p of tracked) {
    if (startCurrencies.has(p.currency0) || startCurrencies.has(p.currency1)) trackedPairs.add(pairKey(p.currency0, p.currency1))
  }
  const candidates: StoredPool[] = []
  for (const p of pools) {
    if (p.hooks === NATIVE || (p.kind ?? 0) !== 0) continue
    if (p.liquidity === undefined || BigInt(p.liquidity) <= 0n) continue
    if (!trackedPairs.has(pairKey(p.currency0, p.currency1))) continue
    candidates.push(p)
  }
  candidates.sort((a, b) => {
    const swaps = (b.swapCount ?? 0) - (a.swapCount ?? 0)
    if (swaps !== 0) return swaps
    const last = (b.lastSwapBlock ?? -1) - (a.lastSwapBlock ?? -1)
    if (last !== 0) return last
    return a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0
  })
  return candidates.slice(0, Math.max(0, maxPools)).map((p) => ({
    poolId: p.poolId,
    currency0: p.currency0,
    currency1: p.currency1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: p.hooks,
    block: p.block,
  }))
}

/** Spot price (token1 per token0) of a sqrtPriceX96, as a float for ranking only. */
export function spotPrice(sqrtPriceX96: bigint): number {
  const s = Number(sqrtPriceX96) / Q96
  return s * s
}

/** `|ln(a / b)|` in basis points; `Infinity` when either price is not positive. */
export function spreadBps(priceA: number, priceB: number): number {
  if (!(priceA > 0) || !(priceB > 0)) return Number.POSITIVE_INFINITY
  return Math.abs(Math.log(priceA / priceB)) * 10_000
}

/** ABI-encode `V4Quoter.quoteExactInput` for one hop through `pool` from `input`. */
export function encodeQuoteExactInput(pool: PoolInfo, input: Address, exactAmount: bigint): Hex {
  const output = otherCurrency(pool, input)
  return encodeFunctionData({
    abi: v4QuoterAbi,
    functionName: 'quoteExactInput',
    args: [
      {
        exactCurrency: input,
        path: [{ intermediateCurrency: output, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks, hookData: '0x' }],
        exactAmount,
      },
    ],
  })
}

/** Decode a successful `quoteExactInput` return value. */
export function decodeQuote(data: Hex): { amountOut: bigint; gasEstimate: bigint } {
  const [amountOut, gasEstimate] = decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInput', data })
  return { amountOut, gasEstimate }
}

/** `n` log-spaced integers from `min` to `max` inclusive (deduplicated, ascending). */
export function logGrid(min: bigint, max: bigint, n: number): bigint[] {
  const lo = min < 1n ? 1n : min
  if (max < lo) return []
  if (lo === max) return [lo]
  const points = Math.max(2, n)
  const a = toLog(lo)
  const b = toLog(max)
  const out: bigint[] = []
  for (let i = 0; i < points; i++) {
    const x = fromLog(a + ((b - a) * i) / (points - 1), lo, max)
    if (out.length === 0 || x !== out[out.length - 1]) out.push(x)
  }
  return out
}

const MAX_UINT128 = (1n << 128n) - 1n

export class HookedProbe {
  private readonly prices = new Map<Hex, ProbePrice>()
  private readonly probeInfos = new Map<Hex, PoolInfo>()
  /** pairKey -> probe pools on the pair. */
  private readonly probeByPair = new Map<string, PoolInfo[]>()
  /** pairKey -> tracked pools on the pair. */
  private readonly trackedByPair = new Map<string, PoolInfo[]>()
  private readonly maxReplayBlocks: number
  private lastBlock: bigint | undefined

  constructor(
    private readonly settings: ProbeSettings,
    private readonly io: ProbeIo,
    private readonly tracked: ReadonlyMap<Hex, PoolInfo>,
    probePools: readonly PoolInfo[],
    private readonly startCurrencies: ReadonlyMap<Address, number>,
  ) {
    if (!Number.isInteger(settings.maxPerBlock) || settings.maxPerBlock < 0) throw new RangeError('probe: maxPerBlock must be >= 0')
    if (!Number.isInteger(settings.grid) || settings.grid < 2) throw new RangeError('probe: grid must be >= 2')
    if (!(settings.minSpreadBps >= 0)) throw new RangeError('probe: minSpreadBps must be >= 0')
    this.maxReplayBlocks = settings.maxReplayBlocks ?? DEFAULT_MAX_REPLAY_BLOCKS
    for (const p of probePools) {
      if (this.tracked.has(p.poolId)) continue
      this.probeInfos.set(p.poolId, p)
      push(this.probeByPair, pairKey(p.currency0, p.currency1), p)
    }
    for (const p of tracked.values()) push(this.trackedByPair, pairKey(p.currency0, p.currency1), p)
  }

  /** The probe set. */
  get pools(): PoolInfo[] {
    return [...this.probeInfos.values()]
  }

  /** Probe pools by id (for executor encoding / cycle descriptions). */
  infos(): Map<Hex, PoolInfo> {
    return new Map(this.probeInfos)
  }

  /** Block the tracked prices correspond to (undefined before `init` / the first `advance`). */
  get block(): bigint | undefined {
    return this.lastBlock
  }

  /** Last known price data of a probe pool. */
  price(poolId: Hex): ProbePrice | undefined {
    return this.prices.get(poolId)
  }

  /** Number of probe pools with a known price. */
  get pricedCount(): number {
    return this.prices.size
  }

  /**
   * Synthetic `PoolState`s for the priced probe pools: `sqrtPriceX96`, `tick`, `liquidity` and
   * `lpFee` are real, the tick map is empty and the window is the current tick only, so they can
   * back price guards and cycle descriptions but never a local simulation.
   */
  states(): Map<Hex, PoolState> {
    const out = new Map<Hex, PoolState>()
    for (const [poolId, price] of this.prices) {
      const info = this.probeInfos.get(poolId)
      if (!info) continue
      out.set(poolId, {
        poolId,
        block: price.block,
        sqrtPriceX96: price.sqrtPriceX96,
        tick: price.tick,
        lpFee: price.lpFee,
        protocolFee: 0,
        liquidity: price.liquidity,
        tickSpacing: info.tickSpacing,
        ticks: new Map(),
        tickWindow: { lower: price.tick, upper: price.tick },
      })
    }
    return out
  }

  /** Seed every probe pool's price from `slot0` at `block` (one extsload batch on chain). */
  async init(block: bigint): Promise<void> {
    const ids = [...this.probeInfos.keys()]
    if (ids.length > 0) {
      const snapshots = await this.io.readSlot0s(ids, block)
      for (const [poolId, s] of snapshots) {
        if (!this.probeInfos.has(poolId) || s.sqrtPriceX96 <= 0n) continue
        this.prices.set(poolId, { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick, liquidity: 0n, lpFee: s.lpFee, block: Number(block) })
      }
    }
    this.lastBlock = block
    log.info({ block, probePools: ids.length, priced: this.prices.size }, 'probe: initialised')
  }

  /**
   * Advance the tracked prices to `block` and return the probe pools that swapped. With
   * `prefetched` logs that start no later than the block after the last one seen (the state
   * cache's replayed logs, which carry every PoolManager `Swap`), they are applied without any
   * chain access; otherwise the PoolManager `Swap` logs from the block after the last one seen up
   * to `block` (at most `maxReplayBlocks` back) are fetched through the io.
   */
  async advance(block: bigint, prefetched?: PrefetchedLogs): Promise<Set<Hex>> {
    if (this.lastBlock !== undefined && block <= this.lastBlock) return new Set()
    let from = this.lastBlock === undefined ? block : this.lastBlock + 1n
    const oldest = block - BigInt(this.maxReplayBlocks) + 1n
    if (from < oldest) from = oldest < 0n ? 0n : oldest
    const logs = prefetched && prefetched.fromBlock <= from ? prefetched.logs : await this.io.fetchSwapLogs(from, block)
    const touched = this.observeSwapLogs(logs)
    this.lastBlock = block
    return touched
  }

  /**
   * Apply PoolManager logs: `Swap`s of probe pools update the tracked price. Logs that are not a
   * v4 `Swap` (or, when `settings.poolManager` is set, not emitted by the PoolManager) are ignored,
   * so a mixed, unfiltered log batch may be passed. Returns the pools touched.
   */
  observeSwapLogs(logs: readonly RawLog[]): Set<Hex> {
    const touched = new Set<Hex>()
    const poolManager = this.settings.poolManager?.toLowerCase()
    for (const raw of logs) {
      if (raw.topics[0]?.toLowerCase() !== V4_SWAP_TOPIC) continue
      if (poolManager !== undefined && raw.address.toLowerCase() !== poolManager) continue
      const poolId = raw.topics[1]?.toLowerCase() as Hex | undefined
      if (poolId === undefined || !this.probeInfos.has(poolId)) continue
      let decoded: ReturnType<typeof decodeEventLog<typeof poolManagerAbi, 'Swap'>>
      try {
        decoded = decodeEventLog({ abi: poolManagerAbi, eventName: 'Swap', data: raw.data, topics: raw.topics })
      } catch {
        continue
      }
      const { sqrtPriceX96, liquidity, tick, fee } = decoded.args
      if (sqrtPriceX96 <= 0n) continue
      this.prices.set(poolId, { sqrtPriceX96, tick, liquidity, lpFee: fee, block: Number(raw.blockNumber) })
      touched.add(poolId)
    }
    return touched
  }

  /**
   * The (hooked, tracked) pairs worth quoting given what changed this block: every priced probe
   * pool that was touched, paired with every tracked pool on its pair; plus every priced probe
   * pool paired with a touched tracked pool on its pair. Filtered by the spread threshold and
   * sorted most-spread first (not yet capped).
   */
  selectCandidates(touchedHooked: ReadonlySet<Hex>, touchedTracked: ReadonlySet<Hex>, states: ReadonlyMap<Hex, PoolState>): ProbeCandidate[] {
    const seen = new Set<string>()
    const out: ProbeCandidate[] = []
    const consider = (hooked: PoolInfo, tracked: PoolInfo): void => {
      const key = `${hooked.poolId}|${tracked.poolId}`
      if (seen.has(key)) return
      seen.add(key)
      const price = this.prices.get(hooked.poolId)
      const state = states.get(tracked.poolId)
      if (!price || !state) return
      const spread = spreadBps(spotPrice(price.sqrtPriceX96), spotPrice(state.sqrtPriceX96))
      if (!Number.isFinite(spread) || spread <= this.settings.minSpreadBps) return
      out.push({ hooked, tracked, spreadBps: spread })
    }
    for (const id of touchedHooked) {
      const hooked = this.probeInfos.get(id)
      if (!hooked) continue
      for (const tracked of this.trackedByPair.get(pairKey(hooked.currency0, hooked.currency1)) ?? []) consider(hooked, tracked)
    }
    for (const id of touchedTracked) {
      const tracked = this.tracked.get(id)
      if (!tracked) continue
      for (const hooked of this.probeByPair.get(pairKey(tracked.currency0, tracked.currency1)) ?? []) consider(hooked, tracked)
    }
    out.sort((a, b) => b.spreadBps - a.spreadBps || (a.hooked.poolId < b.hooked.poolId ? -1 : 1))
    return out
  }

  /**
   * The cycles to quote for a candidate pair: for each start currency on the pair, the direction
   * whose fee-adjusted spot rate product exceeds 1 (the hooked pool's last swap fee is used for
   * its hop). The other direction is skipped: it loses by construction at the current prices.
   */
  cyclesFor(candidate: ProbeCandidate, states: ReadonlyMap<Hex, PoolState>, bounds: ReadonlyMap<Address, InputBounds>): ProbeCycle[] {
    const { hooked, tracked } = candidate
    const price = this.prices.get(hooked.poolId)
    const trackedState = states.get(tracked.poolId)
    if (!price || !trackedState) return []
    const hookedState = this.states().get(hooked.poolId)
    if (!hookedState) return []
    const out: ProbeCycle[] = []
    for (const start of [hooked.currency0, hooked.currency1]) {
      if (!this.startCurrencies.has(start)) continue
      const b = bounds.get(start)
      if (!b || b.maxInput < 1n) continue
      const mid = otherCurrency(hooked, start)
      const hookedOut = directionFrom(hooked, start)
      const trackedOut = directionFrom(tracked, start)
      // S -P-> mid -Q-> S
      const viaHookedFirst = marginalRate(hookedState, hookedOut) * marginalRate(trackedState, !trackedOut)
      // S -Q-> mid -P-> S
      const viaTrackedFirst = marginalRate(trackedState, trackedOut) * marginalRate(hookedState, !hookedOut)
      if (viaHookedFirst > 1) {
        const hops: Hop[] = [
          { poolId: hooked.poolId, zeroForOne: hookedOut },
          { poolId: tracked.poolId, zeroForOne: !trackedOut },
        ]
        out.push({ cycle: { id: cycleId(hops), start, hops }, hooked, tracked, hookedFirst: true, hookedZeroForOne: hookedOut, trackedZeroForOne: !trackedOut, bounds: b })
      }
      if (viaTrackedFirst > 1) {
        const hops: Hop[] = [
          { poolId: tracked.poolId, zeroForOne: trackedOut },
          { poolId: hooked.poolId, zeroForOne: !hookedOut },
        ]
        out.push({ cycle: { id: cycleId(hops), start, hops }, hooked, tracked, hookedFirst: false, hookedZeroForOne: !hookedOut, trackedZeroForOne: trackedOut, bounds: b })
      }
    }
    return out
  }

  /**
   * Run the probe for `block`: pick the candidates (capped at `maxPerBlock` pairs that yield at
   * least one quotable cycle), quote every kept cycle on a `grid` of inputs in one batch, refine
   * the best grid point of each cycle with two more inputs in a second batch, and return the
   * profitable cycles as opportunities (unranked).
   */
  async probe(
    block: bigint,
    states: ReadonlyMap<Hex, PoolState>,
    bounds: ReadonlyMap<Address, InputBounds>,
    touchedHooked: ReadonlySet<Hex>,
    touchedTracked: ReadonlySet<Hex>,
  ): Promise<ProbeResult> {
    const result: ProbeResult = { opportunities: [], candidates: 0, probes: 0, calls: 0, latencyMs: 0, touchedHooked: touchedHooked.size }
    const candidates = this.selectCandidates(touchedHooked, touchedTracked, states)
    result.candidates = candidates.length
    const cycles: ProbeCycle[] = []
    let pairs = 0
    for (const candidate of candidates) {
      if (pairs >= this.settings.maxPerBlock) break
      const forPair = this.cyclesFor(candidate, states, bounds)
      if (forPair.length === 0) continue
      pairs++
      cycles.push(...forPair)
    }
    if (cycles.length === 0) return result
    result.probes = cycles.length

    const started = performance.now()
    const runs = cycles.map((pc) => new CycleRun(pc, states.get(pc.tracked.poolId) as PoolState))
    // Batch 1: the grid.
    for (const run of runs) run.plan(logGrid(run.pc.bounds.minInput, run.pc.bounds.maxInput, this.settings.grid))
    result.calls += await this.quoteBatch(runs, block)
    // Batch 2: refine around each cycle's best grid point.
    for (const run of runs) run.plan(run.refinementInputs())
    result.calls += await this.quoteBatch(runs, block)
    result.latencyMs = Math.round((performance.now() - started) * 10) / 10

    for (const run of runs) {
      const best = run.best
      if (!best || best.sample.profit <= 0n) continue
      result.opportunities.push({
        cycle: run.pc.cycle,
        amountIn: best.sample.amountIn,
        amountOut: best.sample.amountOut,
        grossProfit: best.sample.profit,
        block: Number(block),
        truncated: best.sample.truncated,
        evaluations: run.evaluations,
        probed: true,
        quoterGas: best.quoterGas,
      })
    }
    return result
  }

  /** Issue every planned call of every run in one batch and let the runs consume their answers. */
  private async quoteBatch(runs: readonly CycleRun[], block: bigint): Promise<number> {
    const calls: QuoteCall[] = []
    const owners: Array<{ run: CycleRun; index: number }> = []
    for (const run of runs) {
      for (const [index, call] of run.pendingCalls(this.settings.quoter).entries()) {
        calls.push(call)
        owners.push({ run, index })
      }
    }
    if (calls.length === 0) return 0
    let outcomes: QuoteOutcome[]
    try {
      outcomes = await this.io.call(calls, block)
    } catch (error) {
      log.warn({ err: error, calls: calls.length, block }, 'probe: quoter batch failed')
      outcomes = calls.map(() => ({ ok: false, reason: 'batch failed' }))
    }
    if (outcomes.length !== calls.length) {
      log.warn({ expected: calls.length, got: outcomes.length }, 'probe: quoter batch answered with the wrong length')
      outcomes = calls.map((_, i) => outcomes[i] ?? { ok: false, reason: 'missing answer' })
    }
    owners.forEach(({ run, index }, i) => run.consume(index, outcomes[i] as QuoteOutcome))
    for (const run of runs) run.finishBatch()
    return calls.length
  }
}

/** A sample of a probed cycle with the quoter's gas estimate for the hooked hop. */
interface ProbeSample {
  sample: ProfitSample
  quoterGas: bigint
}

/**
 * Per-cycle bookkeeping across the two batches: which inputs are planned, the quoter call each
 * needs (with the local hop already simulated when the tracked pool comes first), and the samples
 * produced so far.
 */
class CycleRun {
  readonly samples: ProbeSample[] = []
  private pending: Array<{ amountIn: bigint; quoteIn: bigint; truncated: boolean; outcome?: QuoteOutcome }> = []
  private readonly tried = new Set<bigint>()

  constructor(
    readonly pc: ProbeCycle,
    private readonly trackedState: PoolState,
  ) {}

  get evaluations(): number {
    return this.samples.length
  }

  get best(): ProbeSample | undefined {
    let best: ProbeSample | undefined
    for (const s of this.samples) if (!best || isBetterSample(s.sample, best.sample)) best = s
    return best
  }

  /** Schedule `inputs` for the next batch (skipping inputs already sampled). */
  plan(inputs: readonly bigint[]): void {
    this.pending = []
    for (const amountIn of inputs) {
      if (amountIn <= 0n || this.tried.has(amountIn)) continue
      this.tried.add(amountIn)
      if (this.pc.hookedFirst) {
        this.pending.push({ amountIn, quoteIn: amountIn, truncated: false })
        continue
      }
      const local = simulateHop(this.pc.tracked, this.trackedState, this.pc.trackedZeroForOne, amountIn)
      if (local.amountOut <= 0n) {
        // Nothing reaches the hooked hop: record the dead end without spending a call.
        this.samples.push({ sample: { amountIn, amountOut: 0n, profit: -amountIn, truncated: true }, quoterGas: 0n })
        continue
      }
      this.pending.push({ amountIn, quoteIn: local.amountOut, truncated: local.truncated })
    }
  }

  /** The quoter calls for the pending inputs, in order. */
  pendingCalls(quoter: Address): QuoteCall[] {
    const input = this.pc.hookedZeroForOne ? this.pc.hooked.currency0 : this.pc.hooked.currency1
    return this.pending.map((p) => ({ to: quoter, data: encodeQuoteExactInput(this.pc.hooked, input, p.quoteIn > MAX_UINT128 ? MAX_UINT128 : p.quoteIn) }))
  }

  consume(index: number, outcome: QuoteOutcome): void {
    const p = this.pending[index]
    if (p) p.outcome = outcome
  }

  /** Turn every answered pending call into a sample. */
  finishBatch(): void {
    for (const p of this.pending) {
      const outcome = p.outcome ?? { ok: false, reason: 'unanswered' }
      if (!outcome.ok) {
        log.debug({ cycle: this.pc.cycle.id, amountIn: p.amountIn, reason: outcome.reason }, 'probe: quote failed')
        this.samples.push({ sample: { amountIn: p.amountIn, amountOut: 0n, profit: -p.amountIn, truncated: true }, quoterGas: 0n })
        continue
      }
      let quoted: { amountOut: bigint; gasEstimate: bigint }
      try {
        quoted = decodeQuote(outcome.data)
      } catch (error) {
        log.debug({ cycle: this.pc.cycle.id, data: outcome.data, err: error }, 'probe: undecodable quote')
        this.samples.push({ sample: { amountIn: p.amountIn, amountOut: 0n, profit: -p.amountIn, truncated: true }, quoterGas: 0n })
        continue
      }
      if (this.pc.hookedFirst) {
        const local = simulateHop(this.pc.tracked, this.trackedState, this.pc.trackedZeroForOne, quoted.amountOut)
        this.samples.push({
          sample: { amountIn: p.amountIn, amountOut: local.amountOut, profit: local.amountOut - p.amountIn, truncated: local.truncated },
          quoterGas: quoted.gasEstimate,
        })
      } else {
        this.samples.push({
          sample: { amountIn: p.amountIn, amountOut: quoted.amountOut, profit: quoted.amountOut - p.amountIn, truncated: p.truncated },
          quoterGas: quoted.gasEstimate,
        })
      }
    }
    this.pending = []
  }

  /**
   * Two inputs at the log-midpoints between the best sample and its grid neighbours (or one
   * neighbour at the ends). Empty when there is nothing to refine.
   */
  refinementInputs(): bigint[] {
    const best = this.best
    if (!best || this.samples.length < 2) return []
    const inputs = [...this.tried].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const i = inputs.indexOf(best.sample.amountIn)
    if (i < 0) return []
    const { minInput, maxInput } = this.pc.bounds
    const out: bigint[] = []
    const left = inputs[i - 1]
    const right = inputs[i + 1]
    if (left !== undefined) out.push(fromLog((toLog(left) + toLog(best.sample.amountIn)) / 2, minInput, maxInput))
    if (right !== undefined) out.push(fromLog((toLog(best.sample.amountIn) + toLog(right)) / 2, minInput, maxInput))
    return out.filter((x) => !this.tried.has(x))
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}
