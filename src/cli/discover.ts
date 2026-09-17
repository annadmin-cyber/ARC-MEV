/**
 * One-shot pool discovery: scan PoolManager `Initialize` logs (resuming from the persisted
 * store), read every pool's liquidity, record recent swap activity, save, and print statistics.
 *
 *   npm run discover
 *
 * `DISCOVER_RPC_URL=<url>` (optional, read here only) uses that endpoint for the two log backfills
 * (Initialize / PoolCreated scan and the swap-activity window) instead of RPC_URL; the liquidity
 * reads (`extsload`, Multicall3) stay on RPC_URL, which any node serves.
 * `DISCOVER_FROM_BLOCK=<n>` (optional, read here only) starts the Initialize scan at block `n`
 * instead of resuming from the store, for bounded test runs. Pools initialised between the
 * store's resume point and `n` are not discovered by such a run, so use it only for smoke tests
 * or to re-scan a range that is already covered.
 */
import { loadConfig } from '../config.js'
import {
  DEFAULT_LOOKBACK_BLOCKS,
  hooksAllowed,
  loadPoolStore,
  poolStorePath,
  refreshActivity,
  refreshLiquidity,
  savePoolStore,
  scanPools,
  selectTrackedPools,
  type PoolStore,
} from '../discovery/index.js'
import { log } from '../logger.js'
import { makeClients } from '../rpc/client.js'

async function main(): Promise<void> {
  const cfg = loadConfig()
  // Backfills need an archive endpoint that serves 10k-block eth_getLogs ranges (the public gateway
  // throttles, dRPC's free plan caps ranges at ~100 blocks, Blockdaemon has pruned history).
  const discoverRpc = process.env['DISCOVER_RPC_URL']?.trim()
  if (discoverRpc) log.info({ rpc: discoverRpc }, 'discover: using DISCOVER_RPC_URL for the log backfills')
  const clients = makeClients(cfg)
  const logClients = discoverRpc ? makeClients({ ...cfg, RPC_URL: discoverRpc }) : clients
  const store = await loadPoolStore(cfg)
  log.info({ path: poolStorePath(cfg), pools: Object.keys(store.pools).length, lastScannedBlock: store.lastScannedBlock }, 'discover: start')

  const started = Date.now()
  const fromBlock = discoverFromBlock(process.env['DISCOVER_FROM_BLOCK'])
  if (fromBlock !== undefined) log.warn({ fromBlock }, 'discover: DISCOVER_FROM_BLOCK set, scanning from there instead of resuming')
  await scanPools(logClients, cfg, store, {
    ...(fromBlock === undefined ? {} : { fromBlock }),
    onProgress: (block) =>
      log.info({ block, pools: Object.keys(store.pools).length, elapsedS: Math.round((Date.now() - started) / 1000) }, 'discover: scan progress'),
  })
  await refreshLiquidity(clients, cfg, store)
  await refreshActivity(logClients, cfg, store, DEFAULT_LOOKBACK_BLOCKS)
  await savePoolStore(cfg, store)

  const stats = computeStats(store, cfg)
  log.info(stats, 'discover: done')
  console.log(
    [
      `pools discovered:           ${stats.pools}`,
      `with liquidity:             ${stats.withLiquidity}`,
      `hookless with liquidity:    ${stats.hooklessWithLiquidity}`,
      `active in last ${DEFAULT_LOOKBACK_BLOCKS} blocks: ${stats.activeRecently}`,
      `tracked (selectTrackedPools): ${stats.tracked}`,
      `last scanned block:         ${stats.lastScannedBlock}`,
      `store:                      ${poolStorePath(cfg)}`,
    ].join('\n'),
  )
}

/** Parse the optional `DISCOVER_FROM_BLOCK` override; unset or empty means "resume from the store". */
function discoverFromBlock(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  if (!/^\d+$/.test(raw.trim())) throw new Error(`DISCOVER_FROM_BLOCK must be a non-negative integer, got "${raw}"`)
  return BigInt(raw.trim())
}

function computeStats(store: PoolStore, cfg: ReturnType<typeof loadConfig>) {
  const pools = Object.values(store.pools)
  const withLiquidity = pools.filter((p) => p.liquidity !== undefined && BigInt(p.liquidity) > 0n)
  return {
    pools: pools.length,
    withLiquidity: withLiquidity.length,
    hooklessWithLiquidity: withLiquidity.filter((p) => hooksAllowed({ allowedHooks: new Set() }, p)).length,
    activeRecently: pools.filter((p) => (p.swapCount ?? 0) > 0).length,
    tracked: selectTrackedPools(cfg, store, { startCurrencies: new Set(cfg.startCurrencies.keys()) }).length,
    lastScannedBlock: store.lastScannedBlock,
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'discover failed')
  // pino writes stdout asynchronously; flush so the error line survives process.exit.
  log.flush(() => process.exit(1))
})
