import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { ADDRESSES } from '../../src/chains.js'
import { loadConfig, type Config } from '../../src/config.js'
import { refreshActivity, refreshLiquidity, scanPools, selectTrackedPools } from '../../src/discovery/scan.js'
import { loadPoolStore } from '../../src/discovery/store.js'
import { extsload, makeClients, type RpcClients } from '../../src/rpc/client.js'
import { safeHead } from '../../src/rpc/logs.js'
import { StateCache } from '../../src/state/cache.js'
import { fetchPoolStates } from '../../src/state/reader.js'
import { liquiditySlot, slot0Slot } from '../../src/state/slots.js'
import type { PoolInfo } from '../../src/types.js'
import { LIVE_POOLS, LIVE_TEST_BLOCK } from './fixtures.js'

const MIN_SQRT_PRICE = 4295128739n
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n

const rpcUrl = process.env['ARC_RPC_URL']

describe.skipIf(!rpcUrl)('live Arc mainnet', () => {
  let cfg: Config
  let clients: RpcClients
  let dataDir: string
  const pools: PoolInfo[] = LIVE_POOLS.slice(0, 3).map((p) => ({
    poolId: p.poolId,
    currency0: p.currency0,
    currency1: p.currency1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    hooks: p.hooks,
    block: p.block,
  }))

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'arc-mev-live-'))
    cfg = loadConfig({ RPC_URL: rpcUrl, DATA_DIR: dataDir, LOG_LEVEL: 'warn' })
    clients = makeClients(cfg)
  })
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('extsload reads slot0 and liquidity of the reference pools in one batched call', async () => {
    const pm = ADDRESSES[5042]!.poolManager
    const slots = pools.flatMap((p) => [slot0Slot(p.poolId), liquiditySlot(p.poolId)])
    const values = await extsload(clients, pm, slots, LIVE_TEST_BLOCK)
    expect(values).toHaveLength(slots.length)
    for (const v of values) expect(v).toMatch(/^0x[0-9a-f]{64}$/)
    // Batching: 801 slots -> two calls, order preserved (the extra slot is a zero word).
    const many = await extsload(clients, pm, [...Array(800).fill(slots[0]), slots[1]], LIVE_TEST_BLOCK)
    expect(many).toHaveLength(801)
    expect(many[0]).toBe(values[0])
    expect(many[799]).toBe(values[0])
    expect(many[800]).toBe(values[1])
  }, 60_000)

  it('fetchPoolStates returns sane state for 3 real pools at a fixed block', async () => {
    const t0 = Date.now()
    const states = await fetchPoolStates(clients, cfg, pools, LIVE_TEST_BLOCK)
    const ms = Date.now() - t0
    expect(states.size).toBe(3)
    let withTicks = 0
    for (const p of pools) {
      const s = states.get(p.poolId)!
      expect(s.block).toBe(Number(LIVE_TEST_BLOCK))
      expect(s.sqrtPriceX96 >= MIN_SQRT_PRICE && s.sqrtPriceX96 <= MAX_SQRT_PRICE).toBe(true)
      expect(s.liquidity > 0n).toBe(true)
      expect(s.tick >= s.tickWindow.lower && s.tick <= s.tickWindow.upper).toBe(true)
      expect(s.tickWindow.upper - s.tickWindow.lower + 1).toBe(256 * p.tickSpacing * (2 * cfg.TICK_WORDS_EACH_SIDE + 1))
      expect(Math.abs((s.tickWindow.lower / p.tickSpacing) % 256)).toBe(0)
      const ticks = [...s.ticks.keys()]
      expect(ticks).toEqual([...ticks].sort((a, b) => a - b))
      for (const [tick, data] of s.ticks) {
        expect(Math.abs(tick % p.tickSpacing)).toBe(0)
        expect(tick >= s.tickWindow.lower && tick <= s.tickWindow.upper).toBe(true)
        expect(data.liquidityGross > 0n).toBe(true)
      }
      if (s.ticks.size > 0) withTicks++
      console.log(
        `pool ${p.poolId.slice(0, 12)} fee=${p.fee} ts=${p.tickSpacing} tick=${s.tick} sqrtP=${s.sqrtPriceX96} L=${s.liquidity} ticks=${s.ticks.size} window=[${s.tickWindow.lower},${s.tickWindow.upper}] lpFee=${s.lpFee}`,
      )
    }
    console.log(`fetchPoolStates(3 pools) took ${ms} ms`)
    expect(withTicks).toBeGreaterThanOrEqual(1)

    // With tick hints the same result must come back (2 round trips instead of 3).
    const hints = new Map<Hex, number>([...states].map(([id, s]) => [id, s.tick]))
    const again = await fetchPoolStates(clients, cfg, pools, LIVE_TEST_BLOCK, { tickHints: hints })
    for (const p of pools) {
      const a = states.get(p.poolId)!
      const b = again.get(p.poolId)!
      expect(b.sqrtPriceX96).toBe(a.sqrtPriceX96)
      expect(b.tickWindow).toEqual(a.tickWindow)
      expect([...b.ticks]).toEqual([...a.ticks])
    }
  }, 60_000)

  it('StateCache init + applyBlock over a few recent blocks', async () => {
    const head = await safeHead(clients.http)
    const start = head - 5n
    const cache = new StateCache(clients, cfg, pools)
    await cache.init(start)
    expect(cache.all().size).toBe(3)
    for (let b = start + 1n; b <= head; b++) {
      const r = await cache.applyBlock(b)
      expect(r.block).toBe(b)
      console.log(`block ${b}: touched ${r.touched.size}`)
    }
    expect(cache.block).toBe(head)
  }, 120_000)

  it('bounded discovery: scan the last 20,000 blocks into a temp DATA_DIR, refresh, select', async () => {
    const head = await safeHead(clients.http)
    const from = head - 19_999n
    const store = await loadPoolStore(cfg)
    expect(store.lastScannedBlock).toBe(0)
    const progress: number[] = []
    const t0 = Date.now()
    await scanPools(clients, cfg, store, { fromBlock: from, toBlock: head, onProgress: (b) => progress.push(b) })
    const scanMs = Date.now() - t0
    expect(store.lastScannedBlock).toBe(Number(head))
    expect(progress).toEqual([Number(head)])
    const found = Object.values(store.pools)
    console.log(`scanPools ${from}-${head}: ${found.length} pools in ${scanMs} ms`)
    for (const p of found) {
      expect(p.poolId).toBe(p.poolId.toLowerCase())
      expect(p.block).toBeGreaterThanOrEqual(Number(from))
      expect(p.block).toBeLessThanOrEqual(Number(head))
      expect(p.currency0 < p.currency1).toBe(true)
    }
    // Resume: nothing left to scan.
    const reloaded = await loadPoolStore(cfg)
    expect(reloaded.lastScannedBlock).toBe(Number(head))
    expect(Object.keys(reloaded.pools).length).toBe(found.length)
    await scanPools(clients, cfg, reloaded, { toBlock: head })

    const t1 = Date.now()
    await refreshLiquidity(clients, cfg, reloaded, { block: head })
    const liqMs = Date.now() - t1
    const withLiq = Object.values(reloaded.pools).filter((p) => BigInt(p.liquidity ?? '0') > 0n).length
    console.log(`refreshLiquidity: ${withLiq}/${found.length} pools with liquidity in ${liqMs} ms`)
    for (const p of Object.values(reloaded.pools)) expect(p.liquidity).toMatch(/^\d+$/)

    const t2 = Date.now()
    await refreshActivity(clients, cfg, reloaded, 3000, { toBlock: head })
    const actMs = Date.now() - t2
    const active = Object.values(reloaded.pools).filter((p) => p.lastSwapBlock !== undefined)
    console.log(`refreshActivity(3000): ${active.length} pools swapped in ${actMs} ms`)
    for (const p of active) {
      expect(p.lastSwapBlock!).toBeGreaterThan(Number(head) - 3000)
      expect(p.swapCount!).toBeGreaterThan(0)
    }
    const tracked = selectTrackedPools(cfg, reloaded)
    console.log(`selectTrackedPools: ${tracked.length}`)
    expect(tracked.length).toBeLessThanOrEqual(Object.keys(reloaded.pools).length)
  }, 180_000)
})
