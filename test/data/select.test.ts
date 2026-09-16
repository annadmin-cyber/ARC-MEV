import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { compareStoredPools, cycleCapablePools, isEligible, selectTrackedPools } from '../../src/discovery/scan.js'
import { emptyPoolStore, type StoredPool } from '../../src/discovery/store.js'

const A = '0x0000000000000000000000000000000000000000' as Address
const B = '0x1000000000000000000000000000000000000001' as Address
const C = '0x2000000000000000000000000000000000000002' as Address
const HOOK = '0x3000000000000000000000000000000000000003' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

function pool(n: number, over: Partial<StoredPool> & { currency0: Address; currency1: Address }): StoredPool {
  return {
    poolId: `0x${n.toString(16).padStart(64, '0')}` as Hex,
    fee: 3000,
    tickSpacing: 60,
    hooks: ZERO,
    block: 1,
    liquidity: '1000',
    ...over,
  }
}

function ids(pools: { poolId: Hex }[]): number[] {
  return pools.map((p) => Number(BigInt(p.poolId)))
}

describe('selectTrackedPools', () => {
  const cfg = { allowedHooks: new Set<Address>([HOOK]), MIN_POOL_LIQUIDITY: 100n, MAX_TRACKED_POOLS: 3 }

  it('filters by hooks and liquidity', () => {
    const store = emptyPoolStore(5042)
    const ok = pool(1, { currency0: A, currency1: B })
    const allowedHook = pool(2, { currency0: A, currency1: B, hooks: HOOK })
    const badHook = pool(3, { currency0: A, currency1: B, hooks: C })
    const thin = pool(4, { currency0: A, currency1: B, liquidity: '99' })
    const unknown = pool(5, { currency0: A, currency1: B })
    delete unknown.liquidity
    for (const p of [ok, allowedHook, badHook, thin, unknown]) store.pools[p.poolId] = p
    expect(isEligible(cfg, ok)).toBe(true)
    expect(isEligible(cfg, allowedHook)).toBe(true)
    expect(isEligible(cfg, badHook)).toBe(false)
    expect(isEligible(cfg, thin)).toBe(false)
    expect(isEligible(cfg, unknown)).toBe(false)
    expect(ids(selectTrackedPools(cfg, store)).sort()).toEqual([1, 2])
  })

  it('orders by lastSwapBlock desc, then liquidity desc, then poolId asc', () => {
    const pools = [
      pool(1, { currency0: A, currency1: B, liquidity: '10', lastSwapBlock: 50 }),
      pool(2, { currency0: A, currency1: B, liquidity: '99999', lastSwapBlock: 10 }),
      pool(3, { currency0: A, currency1: B, liquidity: '500' }),
      pool(4, { currency0: A, currency1: B, liquidity: '500', lastSwapBlock: 50 }),
      pool(5, { currency0: A, currency1: B, liquidity: '10', lastSwapBlock: 50 }),
      pool(6, { currency0: A, currency1: B, liquidity: '5000' }),
    ]
    const sorted = [...pools].sort(compareStoredPools)
    expect(ids(sorted)).toEqual([4, 1, 5, 2, 6, 3])
  })

  it('caps at MAX_TRACKED_POOLS and then completes pairs of selected pools', () => {
    const store = emptyPoolStore(5042)
    const pools = [
      pool(1, { currency0: A, currency1: B, lastSwapBlock: 100 }), // primary
      pool(2, { currency0: A, currency1: C, lastSwapBlock: 90 }), // primary
      pool(3, { currency0: B, currency1: C, lastSwapBlock: 80 }), // primary (cap reached)
      pool(4, { currency0: A, currency1: B, lastSwapBlock: 70 }), // sibling of 1 -> included
      pool(5, { currency0: A, currency1: B, liquidity: '50' }), // sibling but ineligible -> excluded
      pool(6, { currency0: A, currency1: C }), // sibling of 2 (never swapped) -> included
      pool(7, { currency0: B, currency1: HOOK }), // no selected pair -> excluded
      pool(8, { currency0: A, currency1: B, hooks: C, lastSwapBlock: 200 }), // bad hook -> excluded even though most active
    ]
    for (const p of pools) store.pools[p.poolId] = p
    const selected = selectTrackedPools(cfg, store)
    expect(ids(selected)).toEqual([1, 2, 3, 4, 6])
    // Output is plain PoolInfo (no store statistics leak).
    expect(Object.keys(selected[0]!).sort()).toEqual(['block', 'currency0', 'currency1', 'fee', 'hooks', 'poolId', 'tickSpacing'])
  })

  it('siblings are not pulled in transitively', () => {
    const store = emptyPoolStore(5042)
    const pools = [
      pool(1, { currency0: A, currency1: B, lastSwapBlock: 100 }),
      pool(2, { currency0: A, currency1: B, lastSwapBlock: 1 }),
      pool(3, { currency0: B, currency1: C, lastSwapBlock: 2 }),
    ]
    for (const p of pools) store.pools[p.poolId] = p
    expect(ids(selectTrackedPools({ ...cfg, MAX_TRACKED_POOLS: 1 }, store))).toEqual([1, 2])
    expect(ids(selectTrackedPools({ ...cfg, MAX_TRACKED_POOLS: 0 }, store))).toEqual([])
  })

  it('with startCurrencies, spends the cap only on pools that can lie on a cycle', () => {
    const D = '0x4000000000000000000000000000000000000004' as Address
    const E = '0x5000000000000000000000000000000000000005' as Address
    const F = '0x6000000000000000000000000000000000000006' as Address
    const store = emptyPoolStore(5042)
    const pools = [
      pool(1, { currency0: A, currency1: D, liquidity: '9000' }), // A/D unique pair, D is a leaf -> no cycle
      pool(2, { currency0: A, currency1: E, liquidity: '8000' }), // A/E unique pair, E is a leaf -> no cycle
      pool(3, { currency0: A, currency1: B, liquidity: '700' }), // 2-hop with 4
      pool(4, { currency0: A, currency1: B, liquidity: '600' }),
      pool(5, { currency0: A, currency1: C, liquidity: '500' }), // triangle A-C-B-A with 6 and 3/4
      pool(6, { currency0: B, currency1: C, liquidity: '400' }), // does not touch A but closes the triangle
      pool(7, { currency0: C, currency1: F, liquidity: '300' }), // C/F: F is a leaf -> no cycle through A or C
    ]
    for (const p of pools) store.pools[p.poolId] = p
    const capable = cycleCapablePools(pools, new Set([A]))
    expect([...capable].map((id) => Number(BigInt(id))).sort()).toEqual([3, 4, 5, 6])
    // Without the option the two most liquid (useless) pools eat the cap of 3.
    expect(ids(selectTrackedPools(cfg, store))).toEqual([1, 2, 3, 4])
    // With it the cap goes to cycle-capable pools only, in liquidity order, plus pair completion.
    expect(ids(selectTrackedPools(cfg, store, { startCurrencies: new Set([A]) }))).toEqual([3, 4, 5])
    expect(ids(selectTrackedPools({ ...cfg, MAX_TRACKED_POOLS: 4 }, store, { startCurrencies: new Set([A]) }))).toEqual([3, 4, 5, 6])
    // A start currency that is only a common neighbour still makes a triangle usable.
    expect([...cycleCapablePools(pools, new Set([C]))].map((id) => Number(BigInt(id))).sort()).toEqual([3, 4, 5, 6])
    // No start currency in the graph -> nothing is capable.
    expect(cycleCapablePools(pools, new Set([HOOK])).size).toBe(0)
  })
})
