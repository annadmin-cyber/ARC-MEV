import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isAddress, isHex, type Hex } from 'viem'
import { z } from 'zod'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import type { PoolInfo } from '../types.js'

/** A discovered pool plus the slowly-changing statistics discovery maintains for it. */
export type StoredPool = PoolInfo & {
  /** Pool liquidity as a decimal string (from `refreshLiquidity`). Absent until refreshed. */
  liquidity?: string
  /** Block of the most recent Swap seen by `refreshActivity`. Absent if none was ever seen. */
  lastSwapBlock?: number
  /** Number of Swaps in the lookback window of the most recent `refreshActivity` run. */
  swapCount?: number
}

/** Resume point of one v3/v2 factory scan (keyed by `VenueFactory.name` in `store.venues`). */
export interface VenueScanState {
  /** Last block whose PoolCreated / PairCreated logs were scanned (inclusive). 0 = never scanned. */
  lastScannedBlock: number
}

/** Persisted discovery state for one chain. */
export interface PoolStore {
  chainId: number
  /** Last block whose PoolManager Initialize logs were scanned (inclusive). 0 = never scanned. */
  lastScannedBlock: number
  pools: Record<Hex, StoredPool>
  /** Per-venue (v3/v2 factory) resume points; a venue absent here has never been scanned. */
  venues: Record<string, VenueScanState>
}

const hex = z.string().refine((s): s is Hex => isHex(s), 'invalid hex')
const address = z.string().refine((s) => isAddress(s, { strict: false }), 'invalid address')

const storedPoolSchema = z.object({
  poolId: hex,
  currency0: address,
  currency1: address,
  fee: z.number().int().nonnegative(),
  /** v2-style pairs have tick spacing 0. */
  tickSpacing: z.number().int().nonnegative(),
  hooks: address,
  block: z.number().int().nonnegative(),
  kind: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  pool: address.optional(),
  venue: z.string().optional(),
  liquidity: z.string().regex(/^\d+$/).optional(),
  lastSwapBlock: z.number().int().nonnegative().optional(),
  swapCount: z.number().int().nonnegative().optional(),
})

const poolStoreSchema = z.object({
  chainId: z.number().int(),
  lastScannedBlock: z.number().int().nonnegative(),
  pools: z.record(z.string(), storedPoolSchema),
  /** Absent in stage-1 files: every venue then resumes from its factory's deploy block. */
  venues: z.record(z.string(), z.object({ lastScannedBlock: z.number().int().nonnegative() })).default({}),
})

/** Path of the store file: `<DATA_DIR>/pools.<chainId>.json`. */
export function poolStorePath(cfg: Pick<Config, 'DATA_DIR' | 'CHAIN_ID'>): string {
  return join(cfg.DATA_DIR, `pools.${cfg.CHAIN_ID}.json`)
}

/** A store with nothing scanned yet. */
export function emptyPoolStore(chainId: number): PoolStore {
  return { chainId, lastScannedBlock: 0, pools: {}, venues: {} }
}

/**
 * Load the store from disk, or return an empty one when the file does not exist. A file that
 * exists but is malformed or belongs to another chain throws rather than silently rescanning.
 */
export async function loadPoolStore(cfg: Pick<Config, 'DATA_DIR' | 'CHAIN_ID'>): Promise<PoolStore> {
  const path = poolStorePath(cfg)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.info({ path }, 'no pool store on disk, starting empty')
      return emptyPoolStore(cfg.CHAIN_ID)
    }
    throw error
  }
  const parsed = poolStoreSchema.parse(JSON.parse(text))
  if (parsed.chainId !== cfg.CHAIN_ID) {
    throw new Error(`pool store ${path} is for chain ${parsed.chainId}, config is chain ${cfg.CHAIN_ID}`)
  }
  return normalise(parsed as PoolStore)
}

/** Lower-case every address / id (older files or hand edits may be mixed-case). */
function normalise(store: PoolStore): PoolStore {
  const pools: Record<Hex, StoredPool> = {}
  for (const p of Object.values(store.pools)) {
    const id = p.poolId.toLowerCase() as Hex
    pools[id] = {
      ...p,
      poolId: id,
      currency0: p.currency0.toLowerCase() as StoredPool['currency0'],
      currency1: p.currency1.toLowerCase() as StoredPool['currency1'],
      hooks: p.hooks.toLowerCase() as StoredPool['hooks'],
      ...(p.pool === undefined ? {} : { pool: p.pool.toLowerCase() as NonNullable<StoredPool['pool']> }),
    }
  }
  return { chainId: store.chainId, lastScannedBlock: store.lastScannedBlock, pools, venues: { ...store.venues } }
}

/**
 * Persist the store atomically: write `<path>.tmp-<pid>-<time>` then `rename` over the target,
 * so a crash mid-write never leaves a truncated file. Creates `DATA_DIR` if needed.
 */
export async function savePoolStore(cfg: Pick<Config, 'DATA_DIR' | 'CHAIN_ID'>, store: PoolStore): Promise<void> {
  const path = poolStorePath(cfg)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(store), 'utf8')
  await rename(tmp, path)
}
