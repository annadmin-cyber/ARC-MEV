/**
 * One-shot opportunity scan: load the pool store, select the tracked pools (any kind), read their
 * state at the current head, evaluate every 2- and 3-hop cycle locally, probe the hooked pools
 * that share a pair with a tracked pool through the V4Quoter (when `PROBE_HOOKED_POOLS` is on),
 * and print the top 20 with each hop's kind / venue and a `probed` mark. When `EXECUTOR_ADDRESS`
 * is configured each printed row is also simulated on chain.
 *
 *   npm run scan
 */
import type { Hex } from 'viem'
import { loadConfig } from '../config.js'
import { loadPoolStore, selectTrackedPools } from '../discovery/index.js'
import { readNextBaseFee } from '../exec/gas.js'
import { boundsByStart, describeCycle, evaluateGroups, formatFixed, formatUsdc, groupCycles, venueLabel, type CycleGroup } from '../exec/pipeline.js'
import { guardsForConfig, toExecutorSteps } from '../exec/encode.js'
import { probeIoFor, probeSettingsFor } from '../exec/probeIo.js'
import { simulateOnChain, type SimulationResult } from '../exec/simulate.js'
import { log } from '../logger.js'
import { limiter, makeClients } from '../rpc/client.js'
import { safeHead } from '../rpc/logs.js'
import { fetchPoolStates } from '../state/reader.js'
import { buildCycles, HookedProbe, rankOpportunities, selectProbePools, type EvaluatedOpportunity } from '../strategy/index.js'
import { poolKind, type PoolInfo, type PoolState } from '../types.js'

const TOP_N = 20

async function main(): Promise<void> {
  const cfg = loadConfig()
  const clients = makeClients(cfg)
  const store = await loadPoolStore(cfg)
  const tracked = selectTrackedPools(cfg, store, { startCurrencies: new Set(cfg.startCurrencies.keys()) })
  if (tracked.length === 0) {
    console.log('no tracked pools: run `npm run discover` first')
    return
  }
  const infos = new Map<Hex, PoolInfo>(tracked.map((p) => [p.poolId, p]))
  const cycles = buildCycles(tracked, new Set(cfg.startCurrencies.keys()), 3)
  const groups = groupCycles(cfg, cycles)
  const kinds = { v4: 0, v3: 0, v2: 0 }
  for (const p of tracked) kinds[poolKind(p) === 0 ? 'v4' : poolKind(p) === 1 ? 'v3' : 'v2']++
  log.info({ pools: tracked.length, kinds, cycles: cycles.length }, 'scan: pools and cycles ready')

  const block = await safeHead(clients.http)
  const t0 = Date.now()
  const states = await fetchPoolStates(clients, cfg, tracked, block)
  const tFetch = Date.now() - t0
  let opps: EvaluatedOpportunity[] = evaluateGroups(cfg, groups, states, infos, block)
  const tEval = Date.now() - t0 - tFetch
  log.info({ block, states: states.size, opportunities: opps.length, fetchMs: tFetch, evalMs: tEval }, 'scan: evaluated')

  const allInfos = new Map(infos)
  const allStates: Map<Hex, PoolState> = new Map(states)
  if (cfg.PROBE_HOOKED_POOLS) {
    const probePools = selectProbePools(Object.values(store.pools), tracked, new Set(cfg.startCurrencies.keys()))
    if (probePools.length > 0) {
      const probe = new HookedProbe(probeSettingsFor(cfg), probeIoFor(clients, cfg), infos, probePools, cfg.startCurrencies)
      await probe.init(block)
      const tProbe = Date.now()
      // A one-shot scan treats every priced hooked pool as "touched" and lets the spread threshold and cap decide.
      const result = await probe.probe(block, states, boundsByStart(cfg), new Set(probe.pools.map((p) => p.poolId)), new Set())
      log.info(
        { block, probePools: probePools.length, priced: probe.pricedCount, candidates: result.candidates, probes: result.probes, calls: result.calls, quoterMs: result.latencyMs, totalMs: Date.now() - tProbe, found: result.opportunities.length },
        'scan: hooked pools probed',
      )
      for (const [id, info] of probe.infos()) allInfos.set(id, info)
      for (const [id, state] of probe.states()) allStates.set(id, state)
      if (result.opportunities.length > 0) opps = rankOpportunities([...opps, ...result.opportunities], cfg.startCurrencies)
    }
  }

  const top = opps.slice(0, TOP_N)
  const sims = cfg.EXECUTOR_ADDRESS ? await simulateTop(clients, cfg, top, allStates, allInfos, block) : undefined
  console.log(renderTable(top, groups, allInfos, sims))
  if (opps.length === 0) console.log(`no profitable cycle at block ${block} (${cycles.length} cycles over ${tracked.length} pools)`)
  else {
    const fee = await readNextBaseFee(clients, block)
    console.log(
      `\nblock ${block}, next base fee ${formatFixed(fee.nextBaseFee, 9, 2)} gwei (${fee.source}), gas at GAS_LIMIT=${cfg.GAS_LIMIT}: ${formatUsdc(BigInt(cfg.GAS_LIMIT) * fee.nextBaseFee)} USDC (before tip)`,
    )
  }
}

async function simulateTop(
  clients: ReturnType<typeof makeClients>,
  cfg: ReturnType<typeof loadConfig>,
  opps: EvaluatedOpportunity[],
  states: Map<Hex, PoolState>,
  infos: Map<Hex, PoolInfo>,
  block: bigint,
): Promise<SimulationResult[]> {
  const limit = limiter(2)
  return Promise.all(
    opps.map((opp) =>
      limit(async (): Promise<SimulationResult> => {
        try {
          const steps = toExecutorSteps(opp.cycle, infos)
          const guards = guardsForConfig(cfg, opp.cycle, states, infos)
          return await simulateOnChain(clients, cfg, opp, steps, guards, block)
        } catch (error) {
          return { ok: false, reason: (error as Error).message }
        }
      }),
    ),
  )
}

/** `v4`, `v4:hook`, `v3:uniswap-v3`, ... per hop, joined with `>`. */
function kindsOf(opp: EvaluatedOpportunity, infos: Map<Hex, PoolInfo>): string {
  return opp.cycle.hops
    .map((h) => {
      const info = infos.get(h.poolId)
      if (!info) return '?'
      const label = venueLabel(info)
      return poolKind(info) === 0 ? (label ? `v4:${label}` : 'v4') : label
    })
    .join('>')
}

/** Fixed-width text table of the opportunities. */
function renderTable(
  opps: EvaluatedOpportunity[],
  groups: CycleGroup[],
  infos: Map<Hex, PoolInfo>,
  sims: SimulationResult[] | undefined,
): string {
  const decimalsOf = new Map(groups.map((g) => [g.start, g.decimals] as const))
  const header = ['#', 'amountIn', 'gross', 'gross USDC', 'hops', 'kinds', 'probed', 'trunc', ...(sims ? ['simulated'] : []), 'cycle']
  const rows = opps.map((opp, i) => {
    const dec = decimalsOf.get(opp.cycle.start) ?? 18
    const sim = sims?.[i]
    return [
      String(i + 1),
      formatFixed(opp.amountIn, dec, 6),
      formatFixed(opp.grossProfit, dec, 6),
      opp.grossProfitUsdc === undefined ? '?' : formatUsdc(opp.grossProfitUsdc),
      String(opp.cycle.hops.length),
      kindsOf(opp, infos),
      opp.probed ? 'yes' : 'no',
      opp.truncated ? 'yes' : 'no',
      ...(sims ? [sim === undefined ? '' : sim.ok ? `ok ${formatFixed(sim.profit, dec, 6)} gas ${sim.gas}` : sim.reason] : []),
      describeCycle(opp.cycle, infos),
    ]
  })
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)))
  const line = (cells: string[]): string => cells.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join('  ')
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'scan failed')
  // pino writes stdout asynchronously; flush so the error line survives process.exit.
  log.flush(() => process.exit(1))
})
