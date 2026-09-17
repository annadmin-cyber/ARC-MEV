import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyPoolStore, loadPoolStore, poolSnapshotPath, poolStorePath, savePoolStore, type PoolStore } from '../../src/discovery/store.js'
import { LIVE_POOLS } from './fixtures.js'

describe('PoolStore persistence', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arc-mev-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty store when the file is missing', async () => {
    const cfg = { DATA_DIR: join(dir, 'nested', 'deeper'), CHAIN_ID: 5042 }
    expect(await loadPoolStore(cfg)).toEqual(emptyPoolStore(5042))
  })

  it('falls back to the gzipped snapshot when the store file is missing, and the next save writes the plain file', async () => {
    const cfg = { DATA_DIR: join(dir, 'data'), CHAIN_ID: 5042 }
    const store: PoolStore = emptyPoolStore(5042)
    store.lastScannedBlock = 21_182_903
    const p = LIVE_POOLS[0]!
    store.pools[p.poolId] = { poolId: p.poolId, currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, block: p.block }
    await mkdir(cfg.DATA_DIR, { recursive: true })
    expect(poolSnapshotPath(cfg)).toBe(join(cfg.DATA_DIR, 'pools.5042.json.gz'))
    await writeFile(poolSnapshotPath(cfg), gzipSync(JSON.stringify(store)))
    const loaded = await loadPoolStore(cfg)
    expect(loaded).toEqual(store)
    // The plain file takes precedence once it exists.
    loaded.lastScannedBlock = 21_200_000
    await savePoolStore(cfg, loaded)
    expect((await loadPoolStore(cfg)).lastScannedBlock).toBe(21_200_000)
    expect((await readdir(cfg.DATA_DIR)).sort()).toEqual(['pools.5042.json', 'pools.5042.json.gz'])
  })

  it('rejects a corrupt snapshot instead of silently starting empty', async () => {
    const cfg = { DATA_DIR: join(dir, 'data'), CHAIN_ID: 5042 }
    await mkdir(cfg.DATA_DIR, { recursive: true })
    await writeFile(poolSnapshotPath(cfg), 'not gzip')
    await expect(loadPoolStore(cfg)).rejects.toThrow()
  })

  it('round-trips through an atomic save (temp file + rename, directory created)', async () => {
    const cfg = { DATA_DIR: join(dir, 'data'), CHAIN_ID: 5042 }
    const store: PoolStore = emptyPoolStore(5042)
    store.lastScannedBlock = 21_000_000
    for (const p of LIVE_POOLS.slice(0, 3)) {
      store.pools[p.poolId] = {
        poolId: p.poolId,
        currency0: p.currency0,
        currency1: p.currency1,
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        hooks: p.hooks,
        block: p.block,
        liquidity: p.liquidity,
        lastSwapBlock: 21_000_000,
        swapCount: 3,
      }
    }
    await savePoolStore(cfg, store)
    expect(poolStorePath(cfg)).toBe(join(cfg.DATA_DIR, 'pools.5042.json'))
    // No leftover temp file after the rename.
    expect(await readdir(cfg.DATA_DIR)).toEqual(['pools.5042.json'])
    const loaded = await loadPoolStore(cfg)
    expect(loaded).toEqual(store)
    // A second save overwrites in place.
    store.lastScannedBlock = 21_000_001
    await savePoolStore(cfg, store)
    expect((await loadPoolStore(cfg)).lastScannedBlock).toBe(21_000_001)
    expect(await readdir(cfg.DATA_DIR)).toEqual(['pools.5042.json'])
  })

  it('lower-cases addresses on load and rejects a foreign chain id', async () => {
    const cfg = { DATA_DIR: dir, CHAIN_ID: 5042 }
    const p = LIVE_POOLS[0]!
    const mixed = {
      chainId: 5042,
      lastScannedBlock: 1,
      pools: {
        [p.poolId.toUpperCase().replace('0X', '0x')]: {
          poolId: p.poolId.toUpperCase().replace('0X', '0x'),
          currency0: p.currency0,
          currency1: p.currency1.toUpperCase().replace('0X', '0x'),
          fee: p.fee,
          tickSpacing: p.tickSpacing,
          hooks: p.hooks,
          block: p.block,
        },
      },
    }
    await writeFile(poolStorePath(cfg), JSON.stringify(mixed))
    const loaded = await loadPoolStore(cfg)
    expect(Object.keys(loaded.pools)).toEqual([p.poolId])
    expect(loaded.pools[p.poolId]?.currency1).toBe(p.currency1)

    await writeFile(poolStorePath(cfg), JSON.stringify({ ...mixed, chainId: 1 }))
    await expect(loadPoolStore(cfg)).rejects.toThrow(/chain 1/)
  })

  it('rejects a malformed file instead of silently rescanning', async () => {
    const cfg = { DATA_DIR: dir, CHAIN_ID: 5042 }
    await writeFile(poolStorePath(cfg), '{"chainId":5042,"lastScannedBlock":-1,"pools":{}}')
    await expect(loadPoolStore(cfg)).rejects.toThrow()
    await writeFile(poolStorePath(cfg), 'not json')
    await expect(loadPoolStore(cfg)).rejects.toThrow()
    expect(await readFile(poolStorePath(cfg), 'utf8')).toBe('not json')
  })
})
