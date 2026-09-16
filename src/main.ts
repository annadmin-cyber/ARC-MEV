/**
 * Bot entry point: load config and pools, build the cycle set, warm the state cache at the
 * latest block, then follow the chain head (WebSocket `newHeads` when `WS_URL` is set, HTTP
 * polling otherwise) and hand every new block to {@link ArbBot}. `DRY_RUN=true` (the default)
 * runs the whole pipeline but only logs what it would send. SIGINT / SIGTERM stop the loop after
 * the block in progress.
 */
import { stat } from 'node:fs/promises'
import { privateKeyToAccount } from 'viem/accounts'
import { loadConfig, type Config } from './config.js'
import { loadPoolStore, poolStorePath, selectTrackedPools, type PoolStore } from './discovery/index.js'
import { ArbBot } from './exec/bot.js'
import { BlockLoop } from './exec/blockLoop.js'
import { groupCycles } from './exec/pipeline.js'
import { Sender } from './exec/sender.js'
import { log } from './logger.js'
import { makeClients, withRetry, type RpcClients } from './rpc/client.js'
import { isBlockNotReady, StateCache } from './state/cache.js'
import { buildCycles } from './strategy/index.js'

/** A pool store older than this is reported as stale at startup. */
const STORE_STALE_MS = 2 * 60 * 60 * 1000

async function main(): Promise<void> {
  const cfg = loadConfig()
  const clients = makeClients(cfg)
  log.info(
    { chainId: cfg.CHAIN_ID, rpc: cfg.RPC_URL, ws: cfg.WS_URL ?? null, dryRun: cfg.DRY_RUN, executor: cfg.EXECUTOR_ADDRESS ?? null },
    'starting',
  )

  const store = await loadPoolStore(cfg)
  await warnIfStale(cfg, store)
  const tracked = selectTrackedPools(cfg, store, { startCurrencies: new Set(cfg.startCurrencies.keys()) })
  if (tracked.length === 0) {
    log.error('no tracked pools; run `npm run discover` first')
    process.exitCode = 1
    return
  }
  const infos = new Map(tracked.map((p) => [p.poolId, p] as const))
  const cycles = buildCycles(tracked, new Set(cfg.startCurrencies.keys()), 3)
  const groups = groupCycles(cfg, cycles)
  log.info({ pools: tracked.length, cycles: cycles.length, groups: groups.map((g) => ({ start: g.start, cycles: g.cycles.length })) }, 'pools and cycles ready')

  const cache = new StateCache(clients, cfg, tracked, { fullRefreshBlocks: cfg.FULL_REFRESH_BLOCKS })
  const initBlock = await initCache(clients, cache)
  log.info({ block: initBlock }, 'state cache initialised')

  const sender = cfg.DRY_RUN ? undefined : makeSender(clients, cfg)
  const bot = new ArbBot({ clients, cfg, cache, infos, groups, ...(sender ? { sender } : {}) })
  const loop = new BlockLoop((block, skipped) => bot.processBlock(block, skipped))
  const stopSource = startBlockSource(clients, cfg, (b) => loop.notify(b))

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down after the current block')
    stopSource()
    await loop.stop()
    log.info({ lastBlock: loop.lastProcessed }, 'stopped')
    await exitAfterFlush(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

/** pino writes stdout asynchronously; flush it so the last lines survive `process.exit`. */
function exitAfterFlush(code: number): Promise<never> {
  return new Promise(() => log.flush(() => process.exit(code)))
}

/** Log how to refresh the store when it is empty or its file is older than two hours. */
async function warnIfStale(cfg: Config, store: PoolStore): Promise<void> {
  const count = Object.keys(store.pools).length
  if (count === 0) {
    log.warn('pool store is empty: run `npm run discover` (scans PoolManager Initialize logs, ~48k pools); continuing with nothing')
    return
  }
  try {
    const { mtimeMs } = await stat(poolStorePath(cfg))
    const ageMs = Date.now() - mtimeMs
    if (ageMs > STORE_STALE_MS) {
      log.warn(
        { pools: count, ageMinutes: Math.round(ageMs / 60_000), lastScannedBlock: store.lastScannedBlock },
        'pool store is stale (> 2h): run `npm run discover` to refresh liquidity and activity; continuing with what is there',
      )
    }
  } catch (error) {
    log.warn({ err: error }, 'could not stat the pool store')
  }
}

/** Initialise the cache at the latest block, stepping back one block if the node has not indexed it yet. */
async function initCache(clients: RpcClients, cache: StateCache): Promise<bigint> {
  const latest = await withRetry(() => clients.http.getBlockNumber({ cacheTime: 0 }), { label: 'eth_blockNumber' })
  try {
    await cache.init(latest)
    return latest
  } catch (error) {
    if (!isBlockNotReady(error) || latest === 0n) throw error
    log.warn({ latest }, 'latest block not served yet, initialising one block back')
    await cache.init(latest - 1n)
    return latest - 1n
  }
}

function makeSender(clients: RpcClients, cfg: Config): Sender {
  if (!cfg.PRIVATE_KEY) throw new Error('PRIVATE_KEY is required when DRY_RUN=false')
  const account = privateKeyToAccount(cfg.PRIVATE_KEY)
  log.info({ operator: account.address, sendUrls: clients.sendUrls }, 'live mode: transactions will be sent')
  return new Sender(clients, cfg, account)
}

/**
 * Feed new block numbers to `onBlock`: `newHeads` over WebSocket when a `ws` client exists
 * (falling back to polling if the subscription errors), otherwise `eth_blockNumber` polling every
 * `POLL_INTERVAL_MS`. Returns a function that stops the source.
 */
function startBlockSource(clients: RpcClients, cfg: Config, onBlock: (block: bigint) => void): () => void {
  let stopped = false
  let stopPolling: (() => void) | undefined
  const poll = (): void => {
    if (stopped || stopPolling) return
    log.info({ intervalMs: cfg.POLL_INTERVAL_MS }, 'following the head by polling eth_blockNumber')
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      clients.http
        .getBlockNumber({ cacheTime: 0 })
        .then(onBlock)
        .catch((error: unknown) => log.warn({ err: error }, 'eth_blockNumber failed'))
        .finally(() => (busy = false))
    }, cfg.POLL_INTERVAL_MS)
    stopPolling = () => clearInterval(timer)
  }
  if (!clients.ws) {
    poll()
    return () => {
      stopped = true
      stopPolling?.()
    }
  }
  log.info({ ws: cfg.WS_URL }, 'following the head via newHeads')
  const unwatch = clients.ws.watchBlockNumber({
    emitMissed: false,
    emitOnBegin: true,
    onBlockNumber: onBlock,
    onError: (error) => {
      log.warn({ err: error }, 'newHeads subscription failed, falling back to polling')
      unwatch()
      poll()
    },
  })
  return () => {
    stopped = true
    unwatch()
    stopPolling?.()
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'fatal')
  void exitAfterFlush(1)
})
