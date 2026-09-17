/**
 * In-memory run statistics for the live monitor: pure bookkeeping (no I/O, no timers) fed by the
 * bot through small event hooks and read back as a JSON-serialisable {@link StatsSnapshot} or as
 * Prometheus text. Everything is bounded: per-stage latencies live in a ring buffer of the last
 * `latencyWindow` blocks, the opportunity / send lists keep the newest few, and the receipt
 * history used for the hour / day windows is pruned after 24 h. Time comes from an injectable
 * `now()` so windows are unit-testable.
 */
import { formatUnits } from 'viem'
import type { HeadSourceStatus } from '../exec/headSource.js'
import type { MarketSnapshot } from '../exec/market.js'

/** Milliseconds per stage of one block; `probe` is absent when no probe ran. */
export interface StageTimings {
  logs: number
  eval: number
  probe?: number
  sim: number
  send: number
}

export type Stage = keyof StageTimings

export const STAGES: readonly Stage[] = ['logs', 'eval', 'probe', 'sim', 'send']

export interface BlockEvent {
  block: bigint
  timings: StageTimings
  touched: number
  opportunities: number
  candidates: number
}

export interface SimulatedInfo {
  ok: boolean
  profit18?: bigint
  reason?: string
}

export interface OpportunityEvent {
  block: bigint
  /** {@link describeCycle} output. */
  cycle: string
  /** Input amount in the start currency's units, as a decimal string. */
  amountIn: string
  expected18: bigint
  net18: bigint
  probed: boolean
  simulated?: SimulatedInfo
}

export interface SendEvent {
  block: bigint
  hash: string
  expected18: bigint
  tip: bigint
  maxFee: bigint
  gas: bigint
}

export interface ReceiptEvent {
  hash: string
  status: 'success' | 'reverted'
  profit18?: bigint
  feePaid18: bigint
  block: bigint
  txIndex?: number
}

export interface LostEvent {
  hash: string
  reason: string
}

/** Why a plan that would have been sent was not. */
export type WouldSendReason = 'dry-run' | 'no-executor' | 'breaker' | 'gas-budget' | 'in-flight' | 'outbid'

export interface DryRunEvent {
  block: bigint
  cycle: string
  expected18: bigint
  net18: bigint
  reason: WouldSendReason
}

export interface ProbeEvent {
  block: bigint
  touchedHooked: number
  candidates: number
  probes: number
  calls: number
  latencyMs: number
  found: number
}

export interface StaticInfo {
  chainId: number
  dryRun: boolean
  executor: string | null
  trackedPools: number
  cycles: number
  probePools: number
}

export interface GateStatus {
  breakerPaused: boolean
  pausedUntilBlock?: bigint
  consecutiveFailures: number
  budgetSpent18: bigint
  budgetLimit18: bigint
  windowBlocks: number
}

export type SendOutcome = 'pending' | 'success' | 'reverted' | 'lost'

/** A bigint amount rendered both exactly (decimal string) and for humans. */
export interface Money {
  wei: string
  usdc: string
}

export interface GasPrice {
  wei: string
  gwei: string
}

export interface LatencyRow {
  stage: Stage
  samples: number
  p50: number
  p90: number
  max: number
}

export interface StatsSnapshot {
  now: string
  startedAt: string
  uptimeSeconds: number
  lastBlock: string | null
  lastBlockAt: string | null
  blocksProcessed: number
  blocksPerMinute: number
  errors: number
  latency: LatencyRow[]
  counts: {
    opportunities: number
    candidates: number
    dryRunWouldSend: number
    wouldSendByReason: Record<WouldSendReason, number>
    sends: number
    wins: number
    reverts: number
    lost: number
    pending: number
  }
  profit: { total: Money; lastHour: Money; today: Money }
  gasPaid: { total: Money; lastHour: Money; today: Money }
  net: { total: Money; lastHour: Money; today: Money }
  /** wins / (wins + reverts + lost), or null before the first settled send. */
  winRate: number | null
  head: {
    mode: string
    newest: string | null
    liveSubscriptions: number
    stalls: number
    reconnects: number
  } | null
  gate: {
    breakerPaused: boolean
    pausedUntilBlock: string | null
    consecutiveFailures: number
    budgetSpent: Money
    budgetLimit: Money
    budgetUsedPct: number
    windowBlocks: number
  } | null
  /** Going rate for block position: top-tip quantiles of recent blocks and the tip a send must bid. */
  market: {
    blocks: number
    p50: GasPrice | null
    p75: GasPrice | null
    p90: GasPrice | null
    required: GasPrice | null
  } | null
  probe: {
    rounds: number
    calls: number
    found: number
    last: { block: string; touchedHooked: number; candidates: number; probes: number; calls: number; latencyMs: number; found: number } | null
  }
  static: StaticInfo | null
  lastOpportunities: Array<{
    at: string
    block: string
    cycle: string
    amountIn: string
    expected: Money
    net: Money
    probed: boolean
    simulated: { ok: boolean; profit: Money | null; reason: string | null } | null
  }>
  lastSends: Array<{
    at: string
    block: string
    hash: string
    expected: Money
    tip: GasPrice
    maxFee: GasPrice
    gas: string
    outcome: SendOutcome
    profit: Money | null
    feePaid: Money | null
    minedBlock: string | null
    txIndex: number | null
    reason: string | null
  }>
}

export interface BotStatsOptions {
  /** Clock in ms since the epoch (default `Date.now`). */
  now?: () => number
  /** Blocks kept for the latency percentiles (default 600). */
  latencyWindow?: number
  /** Opportunities kept (default 30). */
  maxOpportunities?: number
  /** Sends kept (default 20). */
  maxSends?: number
}

interface SendRecord {
  at: number
  block: bigint
  hash: string
  expected18: bigint
  tip: bigint
  maxFee: bigint
  gas: bigint
  outcome: SendOutcome
  profit18?: bigint
  feePaid18?: bigint
  minedBlock?: bigint
  txIndex?: number
  reason?: string
}

interface OpportunityRecord extends OpportunityEvent {
  at: number
}

interface Settled {
  at: number
  profit18: bigint
  fee18: bigint
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const DEFAULT_LATENCY_WINDOW = 600
const BLOCK_RATE_WINDOW_MS = 60_000

/** `1234567890000000000n` -> `{ wei: '1234567890000000000', usdc: '1.234567' }`. */
export function money(amount18: bigint): Money {
  return { wei: amount18.toString(), usdc: fixed(amount18, 18, 6) }
}

function gasPrice(wei: bigint): GasPrice {
  return { wei: wei.toString(), gwei: fixed(wei, 9, 2) }
}

/** Format with `decimals`, at most `places` fractional digits, trailing zeros trimmed (sign kept). */
export function fixed(amount: bigint, decimals: number, places: number): string {
  const s = formatUnits(amount, decimals)
  const [whole, frac = ''] = s.split('.')
  const trimmed = frac.slice(0, places).replace(/0+$/, '')
  return trimmed.length > 0 ? `${whole}.${trimmed}` : (whole ?? '0')
}

/** 18-decimal amount as a float for Prometheus (precision loss is fine there). */
export function toFloat18(amount18: bigint): number {
  return Number(formatUnits(amount18, 18))
}

/** Nearest-rank percentile of `sorted` (ascending); 0 when empty. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank] ?? 0
}

export class BotStats {
  private readonly now: () => number
  private readonly latencyWindow: number
  private readonly maxOpportunities: number
  private readonly maxSends: number
  private readonly startedAt: number

  private lastBlock: bigint | undefined
  private lastBlockAt: number | undefined
  private blocksProcessed = 0
  private errors = 0
  /** Ring of the last `latencyWindow` blocks' timings (undefined until filled). */
  private readonly ring: Array<StageTimings | undefined>
  private ringNext = 0
  private ringSize = 0
  /** Wall-clock times of recent blocks, for blocks/min (pruned to the last minute). */
  private blockTimes: number[] = []

  private opportunities = 0
  private candidates = 0
  private wouldSend: Record<WouldSendReason, number> = { 'dry-run': 0, 'no-executor': 0, breaker: 0, 'gas-budget': 0, 'in-flight': 0, outbid: 0 }
  private sends = 0
  private wins = 0
  private reverts = 0
  private lostCount = 0

  private profitTotal18 = 0n
  private feeTotal18 = 0n
  /** Settled receipts of the last 24 h, oldest first. */
  private settled: Settled[] = []

  private head: HeadSourceStatus | undefined
  private gate: GateStatus | undefined
  private market: MarketSnapshot | undefined
  private staticInfo: StaticInfo | undefined
  private probeRounds = 0
  private probeCalls = 0
  private probeFound = 0
  private lastProbe: ProbeEvent | undefined

  /** Newest first. */
  private readonly recentOpportunities: OpportunityRecord[] = []
  /** Newest first. */
  private readonly recentSends: SendRecord[] = []

  constructor(opts: BotStatsOptions = {}) {
    this.now = opts.now ?? Date.now
    this.latencyWindow = opts.latencyWindow ?? DEFAULT_LATENCY_WINDOW
    if (!Number.isInteger(this.latencyWindow) || this.latencyWindow < 1) throw new RangeError('BotStats: latencyWindow must be >= 1')
    this.maxOpportunities = opts.maxOpportunities ?? 30
    this.maxSends = opts.maxSends ?? 20
    this.startedAt = this.now()
    this.ring = new Array<StageTimings | undefined>(this.latencyWindow).fill(undefined)
  }

  // ---- hooks called by the bot ----

  onBlock(e: BlockEvent): void {
    const at = this.now()
    this.blocksProcessed++
    this.lastBlock = e.block
    this.lastBlockAt = at
    this.opportunities += e.opportunities
    this.candidates += e.candidates
    this.ring[this.ringNext] = { ...e.timings }
    this.ringNext = (this.ringNext + 1) % this.latencyWindow
    if (this.ringSize < this.latencyWindow) this.ringSize++
    this.blockTimes.push(at)
    this.pruneBlockTimes(at)
  }

  /** A block's processing threw (the loop moves on); counted separately from processed blocks. */
  onError(_e: { block: bigint; message: string }): void {
    this.errors++
  }

  onOpportunity(o: OpportunityEvent): void {
    this.recentOpportunities.unshift({ ...o, at: this.now() })
    if (this.recentOpportunities.length > this.maxOpportunities) this.recentOpportunities.length = this.maxOpportunities
  }

  onProbe(p: ProbeEvent): void {
    this.probeRounds++
    this.probeCalls += p.calls
    this.probeFound += p.found
    this.lastProbe = p
  }

  onDryRun(d: DryRunEvent): void {
    this.wouldSend[d.reason]++
  }

  onSend(s: SendEvent): void {
    this.sends++
    this.recentSends.unshift({ ...s, at: this.now(), outcome: 'pending' })
    if (this.recentSends.length > this.maxSends) this.recentSends.length = this.maxSends
  }

  onReceipt(r: ReceiptEvent): void {
    const at = this.now()
    if (r.status === 'success') this.wins++
    else this.reverts++
    const profit18 = r.status === 'success' ? (r.profit18 ?? 0n) : 0n
    this.profitTotal18 += profit18
    this.feeTotal18 += r.feePaid18
    this.settled.push({ at, profit18, fee18: r.feePaid18 })
    this.pruneSettled(at)
    const record = this.recentSends.find((s) => s.hash.toLowerCase() === r.hash.toLowerCase())
    if (record) {
      record.outcome = r.status
      record.feePaid18 = r.feePaid18
      record.minedBlock = r.block
      if (r.profit18 !== undefined) record.profit18 = r.profit18
      if (r.txIndex !== undefined) record.txIndex = r.txIndex
    }
  }

  onLost(l: LostEvent): void {
    this.lostCount++
    const record = this.recentSends.find((s) => s.hash.toLowerCase() === l.hash.toLowerCase())
    if (record) {
      record.outcome = 'lost'
      record.reason = l.reason
    }
  }

  setStatic(info: StaticInfo): void {
    this.staticInfo = { ...info }
  }

  setHead(status: HeadSourceStatus): void {
    this.head = { ...status, headsByUrl: { ...status.headsByUrl } }
  }

  setGate(gate: GateStatus): void {
    this.gate = { ...gate }
  }

  setMarket(market: MarketSnapshot): void {
    this.market = { ...market }
  }

  // ---- read side ----

  /** Percentiles per stage over the ring buffer. */
  latency(): LatencyRow[] {
    const rows: LatencyRow[] = []
    for (const stage of STAGES) {
      const values: number[] = []
      for (let i = 0; i < this.ringSize; i++) {
        const v = this.ring[i]?.[stage]
        if (v !== undefined) values.push(v)
      }
      values.sort((a, b) => a - b)
      rows.push({ stage, samples: values.length, p50: percentile(values, 50), p90: percentile(values, 90), max: values[values.length - 1] ?? 0 })
    }
    return rows
  }

  /** Blocks processed in the last minute. */
  blocksPerMinute(): number {
    const at = this.now()
    this.pruneBlockTimes(at)
    return this.blockTimes.length
  }

  snapshot(): StatsSnapshot {
    const at = this.now()
    this.pruneSettled(at)
    const hourStart = at - HOUR_MS
    const dayStart = new Date(at).setUTCHours(0, 0, 0, 0)
    const sum = (since: number): { profit: bigint; fee: bigint } => {
      let profit = 0n
      let fee = 0n
      for (const s of this.settled) {
        if (s.at < since) continue
        profit += s.profit18
        fee += s.fee18
      }
      return { profit, fee }
    }
    const hour = sum(hourStart)
    const day = sum(dayStart)
    const settledCount = this.wins + this.reverts + this.lostCount
    const gate = this.gate
    return {
      now: new Date(at).toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((at - this.startedAt) / 1000)),
      lastBlock: this.lastBlock === undefined ? null : this.lastBlock.toString(),
      lastBlockAt: this.lastBlockAt === undefined ? null : new Date(this.lastBlockAt).toISOString(),
      blocksProcessed: this.blocksProcessed,
      blocksPerMinute: this.blocksPerMinute(),
      errors: this.errors,
      latency: this.latency(),
      counts: {
        opportunities: this.opportunities,
        candidates: this.candidates,
        dryRunWouldSend: Object.values(this.wouldSend).reduce((a, b) => a + b, 0),
        wouldSendByReason: { ...this.wouldSend },
        sends: this.sends,
        wins: this.wins,
        reverts: this.reverts,
        lost: this.lostCount,
        pending: this.recentSends.filter((s) => s.outcome === 'pending').length,
      },
      profit: { total: money(this.profitTotal18), lastHour: money(hour.profit), today: money(day.profit) },
      gasPaid: { total: money(this.feeTotal18), lastHour: money(hour.fee), today: money(day.fee) },
      net: { total: money(this.profitTotal18 - this.feeTotal18), lastHour: money(hour.profit - hour.fee), today: money(day.profit - day.fee) },
      winRate: settledCount === 0 ? null : this.wins / settledCount,
      head: this.head
        ? {
            mode: this.head.mode,
            newest: this.head.newest === undefined ? null : this.head.newest.toString(),
            liveSubscriptions: this.head.liveSubscriptions,
            stalls: this.head.stalls,
            reconnects: this.head.reconnects,
          }
        : null,
      gate: gate
        ? {
            breakerPaused: gate.breakerPaused,
            pausedUntilBlock: gate.pausedUntilBlock === undefined ? null : gate.pausedUntilBlock.toString(),
            consecutiveFailures: gate.consecutiveFailures,
            budgetSpent: money(gate.budgetSpent18),
            budgetLimit: money(gate.budgetLimit18),
            budgetUsedPct: gate.budgetLimit18 <= 0n ? 100 : Math.min(100, Number((gate.budgetSpent18 * 10_000n) / gate.budgetLimit18) / 100),
            windowBlocks: gate.windowBlocks,
          }
        : null,
      market: this.market
        ? {
            blocks: this.market.blocks,
            p50: this.market.p50 === null ? null : gasPrice(this.market.p50),
            p75: this.market.p75 === null ? null : gasPrice(this.market.p75),
            p90: this.market.p90 === null ? null : gasPrice(this.market.p90),
            required: this.market.required === null ? null : gasPrice(this.market.required),
          }
        : null,
      probe: {
        rounds: this.probeRounds,
        calls: this.probeCalls,
        found: this.probeFound,
        last: this.lastProbe ? { ...this.lastProbe, block: this.lastProbe.block.toString() } : null,
      },
      static: this.staticInfo ? { ...this.staticInfo } : null,
      lastOpportunities: this.recentOpportunities.map((o) => ({
        at: new Date(o.at).toISOString(),
        block: o.block.toString(),
        cycle: o.cycle,
        amountIn: o.amountIn,
        expected: money(o.expected18),
        net: money(o.net18),
        probed: o.probed,
        simulated: o.simulated
          ? { ok: o.simulated.ok, profit: o.simulated.profit18 === undefined ? null : money(o.simulated.profit18), reason: o.simulated.reason ?? null }
          : null,
      })),
      lastSends: this.recentSends.map((s) => ({
        at: new Date(s.at).toISOString(),
        block: s.block.toString(),
        hash: s.hash,
        expected: money(s.expected18),
        tip: gasPrice(s.tip),
        maxFee: gasPrice(s.maxFee),
        gas: s.gas.toString(),
        outcome: s.outcome,
        profit: s.profit18 === undefined ? null : money(s.profit18),
        feePaid: s.feePaid18 === undefined ? null : money(s.feePaid18),
        minedBlock: s.minedBlock === undefined ? null : s.minedBlock.toString(),
        txIndex: s.txIndex ?? null,
        reason: s.reason ?? null,
      })),
    }
  }

  /** Prometheus text exposition (version 0.0.4). */
  toPrometheus(): string {
    const s = this.snapshot()
    const lines: string[] = []
    const metric = (name: string, type: 'counter' | 'gauge', help: string, samples: Array<[labels: string, value: number]>): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`)
    }
    metric('arcmev_blocks_processed_total', 'counter', 'Blocks processed since start.', [['', s.blocksProcessed]])
    metric('arcmev_block_errors_total', 'counter', 'Blocks whose processing threw.', [['', s.errors]])
    metric('arcmev_opportunities_total', 'counter', 'Ranked opportunities seen.', [['', s.counts.opportunities]])
    metric('arcmev_candidates_total', 'counter', 'Opportunities that cleared gas and MIN_PROFIT.', [['', s.counts.candidates]])
    metric('arcmev_would_send_total', 'counter', 'Plans that were not sent, by reason.', (Object.keys(s.counts.wouldSendByReason) as WouldSendReason[]).map((r) => [`{reason="${r}"}`, s.counts.wouldSendByReason[r]]))
    metric('arcmev_sends_total', 'counter', 'Transactions sent.', [['', s.counts.sends]])
    metric('arcmev_wins_total', 'counter', 'Transactions mined successfully.', [['', s.counts.wins]])
    metric('arcmev_reverts_total', 'counter', 'Transactions reverted on chain.', [['', s.counts.reverts]])
    metric('arcmev_lost_total', 'counter', 'Transactions never mined.', [['', s.counts.lost]])
    metric('arcmev_profit_usdc', 'counter', 'Realised profit in USDC.', [['', toFloat18(BigInt(s.profit.total.wei))]])
    metric('arcmev_gas_paid_usdc', 'counter', 'Gas paid in USDC.', [['', toFloat18(BigInt(s.gasPaid.total.wei))]])
    metric('arcmev_net_usdc', 'gauge', 'Profit minus gas in USDC.', [['', toFloat18(BigInt(s.net.total.wei))]])
    metric('arcmev_last_block', 'gauge', 'Last block processed.', [['', s.lastBlock === null ? 0 : Number(s.lastBlock)]])
    metric('arcmev_blocks_per_minute', 'gauge', 'Blocks processed in the last minute.', [['', s.blocksPerMinute]])
    metric('arcmev_uptime_seconds', 'gauge', 'Seconds since start.', [['', s.uptimeSeconds]])
    metric(
      'arcmev_block_latency_ms',
      'gauge',
      `Per-stage latency over the last ${this.latencyWindow} blocks.`,
      s.latency.flatMap((row) => [
        [`{stage="${row.stage}",quantile="0.5"}`, row.p50],
        [`{stage="${row.stage}",quantile="0.9"}`, row.p90],
        [`{stage="${row.stage}",quantile="1"}`, row.max],
      ]),
    )
    metric('arcmev_breaker_paused', 'gauge', '1 while the circuit breaker pauses sending.', [['', s.gate?.breakerPaused ? 1 : 0]])
    metric('arcmev_breaker_consecutive_failures', 'gauge', 'Failed sends since the last success.', [['', s.gate?.consecutiveFailures ?? 0]])
    metric('arcmev_budget_spent_usdc', 'gauge', 'Gas paid inside the rolling budget window, in USDC.', [['', s.gate ? toFloat18(BigInt(s.gate.budgetSpent.wei)) : 0]])
    metric('arcmev_budget_limit_usdc', 'gauge', 'Rolling gas budget in USDC.', [['', s.gate ? toFloat18(BigInt(s.gate.budgetLimit.wei)) : 0]])
    const modes = ['ws', 'ws-stalled', 'polling']
    metric('arcmev_head_mode', 'gauge', '1 for the active head source mode.', modes.map((m) => [`{mode="${m}"}`, s.head?.mode === m ? 1 : 0]))
    metric('arcmev_head_live_subscriptions', 'gauge', 'newHeads subscriptions currently delivering.', [['', s.head?.liveSubscriptions ?? 0]])
    metric('arcmev_dry_run', 'gauge', '1 in dry-run mode.', [['', s.static?.dryRun === false ? 0 : 1]])
    metric('arcmev_tracked_pools', 'gauge', 'Pools tracked.', [['', s.static?.trackedPools ?? 0]])
    metric('arcmev_probe_rounds_total', 'counter', 'Probe rounds run.', [['', s.probe.rounds]])
    metric('arcmev_probe_calls_total', 'counter', 'Quoter calls issued by the probe.', [['', s.probe.calls]])
    return lines.join('\n') + '\n'
  }

  private pruneBlockTimes(at: number): void {
    const cutoff = at - BLOCK_RATE_WINDOW_MS
    let drop = 0
    while (drop < this.blockTimes.length && (this.blockTimes[drop] as number) <= cutoff) drop++
    if (drop > 0) this.blockTimes = this.blockTimes.slice(drop)
  }

  private pruneSettled(at: number): void {
    const cutoff = at - DAY_MS
    let drop = 0
    while (drop < this.settled.length && (this.settled[drop] as Settled).at < cutoff) drop++
    if (drop > 0) this.settled = this.settled.slice(drop)
  }
}
