import { describe, expect, it } from 'vitest'
import { BotStats, fixed, money, percentile, toFloat18 } from '../../src/monitor/stats.js'

const USDC = 10n ** 18n
const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`
const HASH_C = `0x${'cc'.repeat(32)}`

/** A stats instance with a controllable clock starting at `start` ms. */
function make(start = 1_700_000_000_000, opts: ConstructorParameters<typeof BotStats>[0] = {}) {
  let t = start
  const stats = new BotStats({ now: () => t, ...opts })
  return { stats, advance: (ms: number) => (t += ms), at: () => t }
}

function block(stats: BotStats, n: number, timings: { logs?: number; eval?: number; probe?: number; sim?: number; send?: number } = {}, counts = { touched: 0, opportunities: 0, candidates: 0 }) {
  stats.onBlock({ block: BigInt(n), timings: { logs: 0, eval: 0, sim: 0, send: 0, ...timings }, ...counts })
}

describe('BotStats helpers', () => {
  it('formats money exactly and for humans', () => {
    expect(money(1_234_567_890_000_000_000n)).toEqual({ wei: '1234567890000000000', usdc: '1.234567' })
    expect(money(0n)).toEqual({ wei: '0', usdc: '0' })
    expect(money(-5n * 10n ** 17n)).toEqual({ wei: '-500000000000000000', usdc: '-0.5' })
    expect(fixed(123_450_000_000n, 9, 2)).toBe('123.45')
    expect(toFloat18(15n * 10n ** 17n)).toBe(1.5)
  })

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0)
    expect(percentile([7], 90)).toBe(7)
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(sorted, 50)).toBe(50)
    expect(percentile(sorted, 90)).toBe(90)
    expect(percentile(sorted, 100)).toBe(100)
  })
})

describe('BotStats counters', () => {
  it('counts blocks, opportunities, candidates, would-sends and settled outcomes', () => {
    const { stats } = make()
    block(stats, 100, { logs: 10 }, { touched: 3, opportunities: 4, candidates: 2 })
    block(stats, 101, { logs: 20 }, { touched: 0, opportunities: 1, candidates: 0 })
    stats.onDryRun({ block: 100n, cycle: 'c', expected18: USDC, net18: USDC / 2n, reason: 'dry-run' })
    stats.onDryRun({ block: 101n, cycle: 'c', expected18: USDC, net18: USDC / 2n, reason: 'breaker' })
    stats.onSend({ block: 100n, hash: HASH_A, expected18: USDC, tip: 200n * 10n ** 9n, maxFee: 10n ** 12n, gas: 300_000n })
    stats.onSend({ block: 101n, hash: HASH_B, expected18: USDC, tip: 200n * 10n ** 9n, maxFee: 10n ** 12n, gas: 300_000n })
    stats.onSend({ block: 102n, hash: HASH_C, expected18: USDC, tip: 200n * 10n ** 9n, maxFee: 10n ** 12n, gas: 300_000n })
    stats.onReceipt({ hash: HASH_A, status: 'success', profit18: 2n * USDC, feePaid18: USDC / 10n, block: 101n, txIndex: 3 })
    stats.onReceipt({ hash: HASH_B, status: 'reverted', feePaid18: USDC / 20n, block: 102n })
    stats.onLost({ hash: HASH_C, reason: 'nonce-advanced' })
    stats.onError({ block: 103n, message: 'boom' })

    const s = stats.snapshot()
    expect(s.blocksProcessed).toBe(2)
    expect(s.lastBlock).toBe('101')
    expect(s.errors).toBe(1)
    expect(s.counts).toEqual({
      opportunities: 5,
      candidates: 2,
      dryRunWouldSend: 2,
      wouldSendByReason: { 'dry-run': 1, 'no-executor': 0, breaker: 1, 'gas-budget': 0, 'in-flight': 0, outbid: 0 },
      sends: 3,
      wins: 1,
      reverts: 1,
      lost: 1,
      pending: 0,
    })
    expect(s.profit.total).toEqual(money(2n * USDC))
    expect(s.gasPaid.total).toEqual(money(USDC / 10n + USDC / 20n))
    expect(s.net.total).toEqual(money(2n * USDC - USDC / 10n - USDC / 20n))
    expect(s.winRate).toBeCloseTo(1 / 3)
    // Sends newest first, each with its outcome.
    expect(s.lastSends.map((x) => [x.hash, x.outcome, x.reason, x.minedBlock, x.txIndex])).toEqual([
      [HASH_C, 'lost', 'nonce-advanced', null, null],
      [HASH_B, 'reverted', null, '102', null],
      [HASH_A, 'success', null, '101', 3],
    ])
    expect(s.lastSends[2]?.profit).toEqual(money(2n * USDC))
    expect(s.lastSends[2]?.tip).toEqual({ wei: '200000000000', gwei: '200' })
  })

  it('does not credit profit for a reverted receipt, and a receipt for an unknown hash still counts', () => {
    const { stats } = make()
    stats.onReceipt({ hash: HASH_A, status: 'reverted', profit18: 5n * USDC, feePaid18: USDC, block: 1n })
    const s = stats.snapshot()
    expect(s.counts.reverts).toBe(1)
    expect(s.profit.total.wei).toBe('0')
    expect(s.gasPaid.total.wei).toBe(USDC.toString())
    expect(s.lastSends).toEqual([])
  })

  it('keeps only the newest 30 opportunities and 20 sends', () => {
    const { stats } = make()
    for (let i = 0; i < 45; i++) {
      stats.onOpportunity({ block: BigInt(i), cycle: `cycle ${i}`, amountIn: '1', expected18: USDC, net18: USDC / 2n, probed: i % 2 === 0 })
      stats.onSend({ block: BigInt(i), hash: `0x${i.toString(16).padStart(64, '0')}`, expected18: USDC, tip: 1n, maxFee: 2n, gas: 3n })
    }
    const s = stats.snapshot()
    expect(s.lastOpportunities).toHaveLength(30)
    expect(s.lastOpportunities[0]?.cycle).toBe('cycle 44')
    expect(s.lastOpportunities[29]?.cycle).toBe('cycle 15')
    expect(s.lastSends).toHaveLength(20)
    expect(s.lastSends[0]?.block).toBe('44')
    expect(s.counts.sends).toBe(45)
    expect(s.counts.pending).toBe(20)
  })

  it('records the simulation outcome of an opportunity', () => {
    const { stats } = make()
    stats.onOpportunity({ block: 1n, cycle: 'a', amountIn: '10', expected18: USDC, net18: USDC / 2n, probed: false, simulated: { ok: true, profit18: 3n * USDC } })
    stats.onOpportunity({ block: 1n, cycle: 'b', amountIn: '10', expected18: USDC, net18: USDC / 2n, probed: true, simulated: { ok: false, reason: 'StaleState' } })
    stats.onOpportunity({ block: 2n, cycle: 'c', amountIn: '10', expected18: USDC, net18: -USDC, probed: false })
    const [c, b, a] = stats.snapshot().lastOpportunities
    expect(c?.simulated).toBeNull()
    expect(c?.net.usdc).toBe('-1')
    expect(b?.simulated).toEqual({ ok: false, profit: null, reason: 'StaleState' })
    expect(a?.simulated).toEqual({ ok: true, profit: money(3n * USDC), reason: null })
  })
})

describe('BotStats latency ring buffer', () => {
  it('reports p50 / p90 / max per stage over the last `latencyWindow` blocks only', () => {
    const { stats } = make(0, { latencyWindow: 600 })
    // 700 blocks whose `logs` time equals the block number: the first 100 must have rolled out.
    for (let i = 1; i <= 700; i++) block(stats, i, { logs: i, eval: 1, sim: 0, send: 0 })
    const rows = stats.latency()
    const logs = rows.find((r) => r.stage === 'logs')!
    expect(logs.samples).toBe(600)
    // Window is blocks 101..700: nearest-rank p50 is the 300th value = 400, p90 the 540th = 640.
    expect(logs).toEqual({ stage: 'logs', samples: 600, p50: 400, p90: 640, max: 700 })
    const evalRow = rows.find((r) => r.stage === 'eval')!
    expect(evalRow).toEqual({ stage: 'eval', samples: 600, p50: 1, p90: 1, max: 1 })
    // No probe ran: the probe stage has no samples rather than zeros.
    expect(rows.find((r) => r.stage === 'probe')).toEqual({ stage: 'probe', samples: 0, p50: 0, p90: 0, max: 0 })
  })

  it('includes the probe stage only for blocks that probed', () => {
    const { stats } = make(0, { latencyWindow: 10 })
    block(stats, 1, { probe: 50 })
    block(stats, 2, {})
    block(stats, 3, { probe: 150 })
    expect(stats.latency().find((r) => r.stage === 'probe')).toEqual({ stage: 'probe', samples: 2, p50: 50, p90: 150, max: 150 })
  })

  it('rejects a non-positive window', () => {
    expect(() => new BotStats({ latencyWindow: 0 })).toThrow(RangeError)
  })
})

describe('BotStats time windows (injected clock)', () => {
  it('sums profit and gas over the last hour, today and in total, and blocks over the last minute', () => {
    // Start at 22:30 UTC so "today" and "last hour" differ from "total".
    const start = Date.UTC(2026, 8, 17, 22, 30, 0)
    const { stats, advance } = make(start)
    stats.onReceipt({ hash: HASH_A, status: 'success', profit18: 10n * USDC, feePaid18: USDC, block: 1n })
    advance(30 * 60_000) // 23:00
    stats.onReceipt({ hash: HASH_B, status: 'success', profit18: 5n * USDC, feePaid18: USDC, block: 2n })
    advance(90 * 60_000) // 00:30 next day: A is > 1 h old and yesterday, B is 90 min old (yesterday) too
    stats.onReceipt({ hash: HASH_C, status: 'reverted', feePaid18: USDC / 2n, block: 3n })
    let s = stats.snapshot()
    expect(s.profit.total).toEqual(money(15n * USDC))
    expect(s.profit.lastHour).toEqual(money(0n))
    expect(s.profit.today).toEqual(money(0n))
    expect(s.gasPaid.total).toEqual(money(2n * USDC + USDC / 2n))
    expect(s.gasPaid.lastHour).toEqual(money(USDC / 2n))
    expect(s.gasPaid.today).toEqual(money(USDC / 2n))
    expect(s.net.lastHour).toEqual(money(-USDC / 2n))
    expect(s.uptimeSeconds).toBe(120 * 60)

    advance(20 * 60_000)
    stats.onReceipt({ hash: HASH_A, status: 'success', profit18: USDC, feePaid18: 0n, block: 4n })
    s = stats.snapshot()
    expect(s.profit.lastHour).toEqual(money(USDC))
    expect(s.profit.today).toEqual(money(USDC))
    expect(s.profit.total).toEqual(money(16n * USDC))

    // Receipts older than 24 h are pruned without changing the totals.
    advance(25 * 3_600_000)
    s = stats.snapshot()
    expect(s.profit.total).toEqual(money(16n * USDC))
    expect(s.profit.today).toEqual(money(0n))
  })

  it('counts blocks per minute over a sliding 60 s window', () => {
    const { stats, advance } = make(0)
    for (let i = 0; i < 10; i++) {
      block(stats, i)
      advance(10_000)
    }
    // t = 100 s: blocks at 40..90 s are inside (40 s is exactly 60 s ago and excluded).
    expect(stats.blocksPerMinute()).toBe(5)
    advance(60_000)
    expect(stats.blocksPerMinute()).toBe(0)
    expect(stats.snapshot().blocksProcessed).toBe(10)
  })
})

describe('BotStats snapshot', () => {
  it('serialises to JSON without bigint errors, including head, gate, probe and static info', () => {
    const { stats } = make()
    stats.setStatic({ chainId: 5042, dryRun: true, executor: null, trackedPools: 571, cycles: 1234, probePools: 62 })
    stats.setHead({ mode: 'ws', newest: 123_456n, liveSubscriptions: 2, headsByUrl: { 'wss://a': 10 }, stalls: 1, reconnects: 3 })
    stats.setGate({ breakerPaused: true, pausedUntilBlock: 200n, consecutiveFailures: 3, budgetSpent18: 2n * USDC, budgetLimit18: 5n * USDC, windowBlocks: 7200 })
    stats.onProbe({ block: 10n, touchedHooked: 2, candidates: 3, probes: 1, calls: 5, latencyMs: 120, found: 1 })
    block(stats, 10, { probe: 120 }, { touched: 2, opportunities: 1, candidates: 1 })
    stats.onSend({ block: 10n, hash: HASH_A, expected18: USDC, tip: 1n, maxFee: 2n, gas: 3n })
    const s = stats.snapshot()
    const text = JSON.stringify(s)
    expect(() => JSON.stringify(s)).not.toThrow()
    const back = JSON.parse(text) as typeof s
    expect(back.head).toEqual({ mode: 'ws', newest: '123456', liveSubscriptions: 2, stalls: 1, reconnects: 3 })
    expect(back.gate).toEqual({
      breakerPaused: true,
      pausedUntilBlock: '200',
      consecutiveFailures: 3,
      budgetSpent: money(2n * USDC),
      budgetLimit: money(5n * USDC),
      budgetUsedPct: 40,
      windowBlocks: 7200,
    })
    expect(back.probe).toEqual({ rounds: 1, calls: 5, found: 1, last: { block: '10', touchedHooked: 2, candidates: 3, probes: 1, calls: 5, latencyMs: 120, found: 1 } })
    expect(back.static).toEqual({ chainId: 5042, dryRun: true, executor: null, trackedPools: 571, cycles: 1234, probePools: 62 })
    expect(back.lastSends[0]?.outcome).toBe('pending')
    expect(back.winRate).toBeNull()
    expect(typeof back.startedAt).toBe('string')
  })

  it('starts empty', () => {
    const { stats } = make()
    const s = stats.snapshot()
    expect(s.lastBlock).toBeNull()
    expect(s.head).toBeNull()
    expect(s.gate).toBeNull()
    expect(s.static).toBeNull()
    expect(s.blocksProcessed).toBe(0)
    expect(s.latency.every((r) => r.samples === 0)).toBe(true)
  })

  it('caps the budget percentage at 100 and treats a zero budget as exhausted', () => {
    const { stats } = make()
    stats.setGate({ breakerPaused: false, consecutiveFailures: 0, budgetSpent18: 9n * USDC, budgetLimit18: 5n * USDC, windowBlocks: 10 })
    expect(stats.snapshot().gate?.budgetUsedPct).toBe(100)
    stats.setGate({ breakerPaused: false, consecutiveFailures: 0, budgetSpent18: 0n, budgetLimit18: 0n, windowBlocks: 10 })
    expect(stats.snapshot().gate?.budgetUsedPct).toBe(100)
  })
})

describe('BotStats.toPrometheus', () => {
  it('renders the counters and gauges in exposition format', () => {
    const { stats } = make()
    stats.setStatic({ chainId: 5042, dryRun: false, executor: '0x1', trackedPools: 10, cycles: 20, probePools: 0 })
    stats.setHead({ mode: 'polling', newest: 5n, liveSubscriptions: 0, headsByUrl: {}, stalls: 0, reconnects: 0 })
    stats.setGate({ breakerPaused: true, pausedUntilBlock: 9n, consecutiveFailures: 2, budgetSpent18: 25n * 10n ** 17n, budgetLimit18: 5n * USDC, windowBlocks: 100 })
    block(stats, 7, { logs: 12.5, eval: 3, sim: 40, send: 0 })
    stats.onSend({ block: 7n, hash: HASH_A, expected18: USDC, tip: 1n, maxFee: 2n, gas: 3n })
    stats.onReceipt({ hash: HASH_A, status: 'success', profit18: 15n * 10n ** 17n, feePaid18: 25n * 10n ** 16n, block: 8n })
    stats.onLost({ hash: HASH_B, reason: 'timeout' })
    const text = stats.toPrometheus()
    const lines = text.split('\n')
    expect(text.endsWith('\n')).toBe(true)
    expect(lines).toContain('# TYPE arcmev_blocks_processed_total counter')
    expect(lines).toContain('arcmev_blocks_processed_total 1')
    expect(lines).toContain('arcmev_sends_total 1')
    expect(lines).toContain('arcmev_wins_total 1')
    expect(lines).toContain('arcmev_reverts_total 0')
    expect(lines).toContain('arcmev_lost_total 1')
    expect(lines).toContain('arcmev_profit_usdc 1.5')
    expect(lines).toContain('arcmev_gas_paid_usdc 0.25')
    expect(lines).toContain('arcmev_net_usdc 1.25')
    expect(lines).toContain('arcmev_last_block 7')
    expect(lines).toContain('arcmev_block_latency_ms{stage="logs",quantile="0.5"} 12.5')
    expect(lines).toContain('arcmev_block_latency_ms{stage="sim",quantile="1"} 40')
    expect(lines).toContain('arcmev_block_latency_ms{stage="probe",quantile="0.9"} 0')
    expect(lines).toContain('arcmev_breaker_paused 1')
    expect(lines).toContain('arcmev_budget_spent_usdc 2.5')
    expect(lines).toContain('arcmev_head_mode{mode="polling"} 1')
    expect(lines).toContain('arcmev_head_mode{mode="ws"} 0')
    expect(lines).toContain('arcmev_dry_run 0')
    // Every sample line has a numeric value and every metric has HELP and TYPE lines.
    for (const line of lines) {
      if (line === '' || line.startsWith('#')) continue
      expect(line).toMatch(/^arcmev_[a-z_]+(\{[^}]*\})? -?[0-9.]+$/)
    }
    const names = new Set(lines.filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]))
    for (const name of names) expect(lines.some((l) => l.startsWith(`# HELP ${name} `))).toBe(true)
  })
})
