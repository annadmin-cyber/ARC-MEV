/**
 * One-shot opportunity scan: load the pool store, select the tracked pools, read their state at
 * the current head, evaluate every 2- and 3-hop cycle and print the top 20. When
 * `EXECUTOR_ADDRESS` is configured each printed row is also simulated on chain.
 *
 *   npm run scan
 */
import type { Hex } from 'viem'
import { loadConfig } from '../config.js'
import { loadPoolStore, selectTrackedPools } from '../discovery/index.js'
import { readBaseFee } from '../exec/gas.js'
import { describeCycle, evaluateGroups, formatFixed, formatUsdc, groupCycles, type CycleGroup } from '../exec/pipeline.js'
import { guardsForConfig, toExecutorSteps } from '../exec/encode.js'
import { simulateOnChain, type SimulationResult } from '../exec/simulate.js'
import { log } from '../logger.js'
import { limiter, makeClients } from '../rpc/client.js'
import { safeHead } from '../rpc/logs.js'
import { fetchPoolStates } from '../state/reader.js'
import { buildCycles, type EvaluatedOpportunity } from '../strategy/index.js'
import type { PoolInfo } from '../types.js'

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
  log.info({ pools: tracked.length, cycles: cycles.length }, 'scan: pools and cycles ready')

  const block = await safeHead(clients.http)
  const t0 = Date.now()
  const states = await fetchPoolStates(clients, cfg, tracked, block)
  const tFetch = Date.now() - t0
  const opps = evaluateGroups(cfg, groups, states, infos, block)
  const tEval = Date.now() - t0 - tFetch
  log.info({ block, states: states.size, opportunities: opps.length, fetchMs: tFetch, evalMs: tEval }, 'scan: evaluated')

  const top = opps.slice(0, TOP_N)
  const sims = cfg.EXECUTOR_ADDRESS ? await simulateTop(clients, cfg, top, states, infos, block) : undefined
  console.log(renderTable(top, groups, infos, sims))
  if (opps.length === 0) console.log(`no profitable cycle at block ${block} (${cycles.length} cycles over ${tracked.length} pools)`)
  else {
    const { baseFee } = await readBaseFee(clients)
    console.log(`\nblock ${block}, base fee ${formatFixed(baseFee, 9, 2)} gwei, gas at GAS_LIMIT=${cfg.GAS_LIMIT}: ${formatUsdc(BigInt(cfg.GAS_LIMIT) * baseFee)} USDC (before tip)`)
  }
}

async function simulateTop(
  clients: ReturnType<typeof makeClients>,
  cfg: ReturnType<typeof loadConfig>,
  opps: EvaluatedOpportunity[],
  states: Awaited<ReturnType<typeof fetchPoolStates>>,
  infos: Map<Hex, PoolInfo>,
  block: bigint,
): Promise<SimulationResult[]> {
  const limit = limiter(2)
  return Promise.all(
    opps.map((opp) =>
      limit(async (): Promise<SimulationResult> => {
        try {
          const steps = toExecutorSteps(opp.cycle, infos)
          const guards = guardsForConfig(cfg, opp.cycle, states)
          return await simulateOnChain(clients, cfg, opp, steps, guards, block)
        } catch (error) {
          return { ok: false, reason: (error as Error).message }
        }
      }),
    ),
  )
}

/** Fixed-width text table of the opportunities. */
function renderTable(
  opps: EvaluatedOpportunity[],
  groups: CycleGroup[],
  infos: Map<Hex, PoolInfo>,
  sims: SimulationResult[] | undefined,
): string {
  const decimalsOf = new Map(groups.map((g) => [g.start, g.decimals] as const))
  const header = ['#', 'amountIn', 'gross', 'gross USDC', 'hops', 'trunc', ...(sims ? ['simulated'] : []), 'cycle']
  const rows = opps.map((opp, i) => {
    const dec = decimalsOf.get(opp.cycle.start) ?? 18
    const sim = sims?.[i]
    return [
      String(i + 1),
      formatFixed(opp.amountIn, dec, 6),
      formatFixed(opp.grossProfit, dec, 6),
      opp.grossProfitUsdc === undefined ? '?' : formatUsdc(opp.grossProfitUsdc),
      String(opp.cycle.hops.length),
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
