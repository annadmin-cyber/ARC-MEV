/**
 * Bot entry point: load config and pools, build the cycle set and the hooked-pool probe set,
 * warm the state cache at the latest block, then follow the chain head (`newHeads` over every
 * configured WebSocket endpoint with a stall watchdog, HTTP polling otherwise) and hand every
 * new block to {@link ArbBot}. `DRY_RUN=true` (the default) runs the whole pipeline but only
 * logs what it would send. SIGINT / SIGTERM stop the loop after the block in progress.
 */
import { stat } from 'node:fs/promises'
import { createPublicClient, webSocket, type PublicClient } from 'viem'
import { getWebSocketRpcClient } from 'viem/utils'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { loadConfig, type Config } from './config.js'
import { loadPoolStore, poolStorePath, selectTrackedPools, type PoolStore } from './discovery/index.js'
import { ArbBot } from './exec/bot.js'
import { BlockLoop } from './exec/blockLoop.js'
import { startHeadSource, type HeadSubscription } from './exec/headSource.js'
import { groupCycles } from './exec/pipeline.js'
import { probeIoFor, probeSettingsFor } from './exec/probeIo.js'
import { Sender } from './exec/sender.js'
import { log } from './logger.js'
import { makeClients, withRetry, type RpcClients } from './rpc/client.js'
import { isBlockNotReady, StateCache } from './state/cache.js'
import { buildCycles, HookedProbe, selectProbePools } from './strategy/index.js'
import type { PoolInfo } from './types.js'

/** A pool store older than this is reported as stale at startup. */
const STORE_STALE_MS = 2 * 60 * 60 * 1000

/** Longest a shutdown waits for the receipt of an in-flight transaction. */
const SHUTDOWN_RECEIPT_WAIT_MS = 10_000

async function main(): Promise<void> {
  const cfg = loadConfig()
  const clients = makeClients(cfg)
  log.info(
    { chainId: cfg.CHAIN_ID, rpc: cfg.RPC_URL, ws: cfg.wsUrls, dryRun: cfg.DRY_RUN, executor: cfg.EXECUTOR_ADDRESS ?? null, probe: cfg.PROBE_HOOKED_POOLS },
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

  const probe = cfg.PROBE_HOOKED_POOLS ? await makeProbe(clients, cfg, store, tracked, infos, initBlock) : undefined
  const sender = cfg.DRY_RUN ? undefined : makeSender(clients, cfg)
  const bot = new ArbBot({ clients, cfg, cache, infos, groups, ...(sender ? { sender } : {}), ...(probe ? { probe } : {}) })
  const loop = new BlockLoop((block, skipped) => bot.processBlock(block, skipped))
  const source = startHeadSource({
    subscriptions: wsSubscriptions(clients, cfg),
    poll: () => withRetry(() => clients.http.getBlockNumber({ cacheTime: 0 }), { label: 'eth_blockNumber', tries: 2 }),
    pollIntervalMs: cfg.POLL_INTERVAL_MS,
    stallMs: cfg.WS_STALL_MS,
    onBlock: (b) => loop.notify(b),
  })

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal, head: source.status() }, 'shutting down after the current block')
    source.stop()
    await loop.stop()
    const inFlight = sender?.inFlight
    if (sender && inFlight) {
      // A transaction is still awaiting inclusion: give its receipt a bounded wait so the outcome is logged.
      log.info({ ...inFlight, waitMs: SHUTDOWN_RECEIPT_WAIT_MS }, 'waiting for the in-flight transaction before exiting')
      const summary = await sender.waitForReceipt(inFlight.hash, SHUTDOWN_RECEIPT_WAIT_MS).catch((error: unknown) => {
        log.warn({ err: error, hash: inFlight.hash }, 'receipt wait failed during shutdown')
        return undefined
      })
      if (summary) log.info({ hash: summary.hash, status: summary.status, block: summary.blockNumber, feePaid: summary.feePaid }, 'in-flight transaction settled')
      else log.warn(inFlight, 'in-flight transaction still unconfirmed at exit')
    }
    log.info({ lastBlock: loop.lastProcessed, inFlight: sender?.inFlight ?? null }, 'stopped')
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
 * One `newHeads` subscription per configured WebSocket endpoint (`WS_URL` reuses the client
 * `makeClients` built; the extra `WS_URLS` get their own). Empty when none is configured.
 *
 * The head source re-creates a subscription that failed or went silent. viem caches one socket
 * per URL and gives up on it after a few failed reconnects (or keeps a half-dead one after a
 * silent TCP drop), so every re-create first closes that cached socket: the next request then
 * opens a fresh connection instead of re-subscribing on a dead one.
 */
function wsSubscriptions(clients: RpcClients, cfg: Config): HeadSubscription[] {
  return cfg.wsUrls.map((url) => {
    const client: PublicClient =
      url === cfg.WS_URL && clients.ws
        ? clients.ws
        : (createPublicClient({ chain: clients.chain, transport: webSocket(url, { retryCount: 0, timeout: 20_000 }) }) as PublicClient)
    let attempts = 0
    return {
      url,
      watch: (onBlock, onError) => {
        let cancelled = false
        let unsubscribe: (() => void) | undefined
        const start = (): void => {
          if (cancelled) return
          unsubscribe = client.watchBlockNumber({ emitMissed: false, emitOnBegin: true, onBlockNumber: onBlock, onError })
        }
        if (attempts++ === 0) start()
        else void resetSocket(url).then(start, onError)
        return () => {
          cancelled = true
          unsubscribe?.()
        }
      },
    }
  })
}

/** Close viem's cached socket client for `url` (a no-op connection is opened and closed when none is cached). */
async function resetSocket(url: string): Promise<void> {
  try {
    const rpc = await getWebSocketRpcClient(url)
    rpc.close()
  } catch (error) {
    log.debug({ url, err: error }, 'could not reset the WebSocket before re-subscribing')
  }
}

/**
 * Build the hooked-pool probe over the store's most active hooked pools that share a pair with a
 * tracked pool, seeded with their `slot0` at `block`; `undefined` when there is nothing to probe.
 */
async function makeProbe(
  clients: RpcClients,
  cfg: Config,
  store: PoolStore,
  tracked: readonly PoolInfo[],
  infos: Map<Hex, PoolInfo>,
  block: bigint,
): Promise<HookedProbe | undefined> {
  const pools = selectProbePools(Object.values(store.pools), tracked, new Set(cfg.startCurrencies.keys()))
  if (pools.length === 0) {
    log.info('probe: no hooked pools share a pair with a tracked pool; probing disabled')
    return undefined
  }
  const probe = new HookedProbe(probeSettingsFor(cfg), probeIoFor(clients, cfg), infos, pools, cfg.startCurrencies)
  await probe.init(block)
  return probe
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'fatal')
  void exitAfterFlush(1)
})
