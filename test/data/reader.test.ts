import { describe, expect, it } from 'vitest'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { multicall3Abi, v2PairAbi, v3PoolAbi } from '../../src/abi/index.js'
import { arc } from '../../src/chains.js'
import { loadConfig } from '../../src/config.js'
import { simulateHop } from '../../src/math/hop.js'
import { simulateExactInput } from '../../src/math/simulate.js'
import { v2Liquidity, v2SqrtPriceX96 } from '../../src/math/v2.js'
import type { RpcClients } from '../../src/rpc/client.js'
import { aggregate3, MULTICALL3_ADDRESS, type Call3 } from '../../src/rpc/multicall.js'
import { fetchPoolStates } from '../../src/state/reader.js'
import { bitmapWordSlot, encodeSlot0, encodeTickWord, liquiditySlot, slot0Slot, tickInfoSlot, wordTickSpan } from '../../src/state/slots.js'
import { addressToPoolId, type PoolInfo, type PoolState } from '../../src/types.js'
import { fixtureState } from '../math/helpers.js'

const cfg = loadConfig({ DATA_DIR: '/nonexistent' })
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const ZERO_WORD = `0x${'00'.repeat(32)}` as Hex
const V3_ADDR = '0x82916bee18fcef517b26c72d7cb5f13694e1db41' as Address
const BROKEN_ADDR = '0x0000000000000000000000000000000000000bad' as Address
const V2_ADDR = '0x5dbf58814d0736fa09b6ad7f290800b805dd383d' as Address
const E18 = 10n ** 18n

/** The `main` SimVectors pool: spacing 60, tick 0, ticks at -600/-120/60/180/600/1200. */
const main = fixtureState('main')
const V4: PoolInfo = { poolId: main.poolId, currency0: ZERO, currency1: '0x2000000000000000000000000000000000000002', fee: 3000, tickSpacing: 60, hooks: ZERO, block: 1 }
const V3: PoolInfo = { ...V4, poolId: addressToPoolId(V3_ADDR), fee: 500, kind: 1, pool: V3_ADDR, venue: 'uniswap-v3' }
const BROKEN: PoolInfo = { ...V3, poolId: addressToPoolId(BROKEN_ADDR), pool: BROKEN_ADDR }
const V2: PoolInfo = { ...V4, poolId: addressToPoolId(V2_ADDR), fee: 3000, tickSpacing: 0, kind: 2, pool: V2_ADDR, venue: 'uniswap-v2' }
const RESERVES = { reserve0: 130_000_000_000n, reserve1: 130_000n * E18 }

/** Bitmap words of the fixture's ticks: wordPos -> word. */
function bitmapWords(state: PoolState): Map<number, bigint> {
  const words = new Map<number, bigint>()
  for (const tick of state.ticks.keys()) {
    const compressed = Math.floor(tick / state.tickSpacing)
    const wordPos = compressed >> 8
    words.set(wordPos, (words.get(wordPos) ?? 0n) | (1n << BigInt(compressed & 0xff)))
  }
  return words
}

/** A fake RPC: PoolManager storage for the v4 pool, contract handlers for the v3/v2 pools. */
function fakeClients() {
  const storage = new Map<Hex, Hex>()
  storage.set(slot0Slot(V4.poolId), encodeSlot0({ sqrtPriceX96: main.sqrtPriceX96, tick: main.tick, protocolFee: 0, lpFee: 3000 }))
  storage.set(liquiditySlot(V4.poolId), toHex(main.liquidity, { size: 32 }))
  for (const [w, word] of bitmapWords(main)) storage.set(bitmapWordSlot(V4.poolId, w), toHex(word, { size: 32 }))
  for (const [tick, data] of main.ticks) storage.set(tickInfoSlot(V4.poolId, tick), encodeTickWord(data))

  const v3Words = bitmapWords(main)
  const handlers = new Map<Address, (data: Hex) => { success: boolean; returnData: Hex }>()
  handlers.set(V3_ADDR, (data) => {
    const call = decodeFunctionData({ abi: v3PoolAbi, data })
    switch (call.functionName) {
      case 'slot0':
        // canonical 7-tuple, sqrtPrice/tick from the fixture
        return { success: true, returnData: encodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }], [main.sqrtPriceX96, main.tick, 1, 1, 1, 0, true]) }
      case 'liquidity':
        return { success: true, returnData: encodeAbiParameters([{ type: 'uint128' }], [main.liquidity]) }
      case 'tickBitmap':
        return { success: true, returnData: encodeAbiParameters([{ type: 'uint256' }], [v3Words.get(call.args[0]) ?? 0n]) }
      case 'ticks': {
        const t = main.ticks.get(call.args[0])
        if (!t) throw new Error(`unexpected ticks(${call.args[0]})`)
        return { success: true, returnData: encodeAbiParameters([{ type: 'uint128' }, { type: 'int128' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'int56' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'bool' }], [t.liquidityGross, t.liquidityNet, 0n, 0n, 0n, 0n, 0, true]) }
      }
      default:
        throw new Error(`unexpected v3 call ${call.functionName}`)
    }
  })
  handlers.set(BROKEN_ADDR, () => ({ success: false, returnData: '0x' }))
  handlers.set(V2_ADDR, (data) => {
    const call = decodeFunctionData({ abi: v2PairAbi, data })
    if (call.functionName !== 'getReserves') throw new Error(`unexpected v2 call ${call.functionName}`)
    return { success: true, returnData: encodeAbiParameters([{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }], [RESERVES.reserve0, RESERVES.reserve1, 0]) }
  })

  const counts = { extsload: 0, multicall: 0, subcalls: 0, maxBatch: 0 }
  const client = {
    readContract: async ({ args, blockNumber }: { args: [Hex[]]; blockNumber?: bigint }) => {
      counts.extsload++
      expect(blockNumber).toBe(123n)
      return args[0].map((slot) => storage.get(slot) ?? ZERO_WORD)
    },
    call: async ({ to, data, blockNumber }: { to: Address; data: Hex; blockNumber?: bigint }) => {
      counts.multicall++
      expect(to).toBe(MULTICALL3_ADDRESS)
      expect(blockNumber).toBe(123n)
      const { args } = decodeFunctionData({ abi: multicall3Abi, data })
      const calls = args[0]
      counts.subcalls += calls.length
      counts.maxBatch = Math.max(counts.maxBatch, calls.length)
      const results = calls.map((c) => {
        const h = handlers.get(c.target.toLowerCase() as Address)
        if (!h) throw new Error(`no handler for ${c.target}`)
        expect(c.allowFailure).toBe(true)
        return h(c.callData)
      })
      return { data: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results }) }
    },
  }
  const clients = { http: client, httpSingle: client, chain: arc, sendUrls: [] } as unknown as RpcClients
  return { clients, counts }
}

describe('fetchPoolStates with mixed kinds', () => {
  it('fetches v4 via extsload, v3 via Multicall3, v2 via getReserves, in input order, dropping unreadable pools', async () => {
    const { clients, counts } = fakeClients()
    const states = await fetchPoolStates(clients, cfg, [V2, BROKEN, V3, V4], 123n)
    expect([...states.keys()]).toEqual([V2.poolId, V3.poolId, V4.poolId])

    const window = { lower: wordTickSpan(-2, 60).lower, upper: wordTickSpan(2, 60).upper }
    const v4 = states.get(V4.poolId)!
    expect(v4.sqrtPriceX96).toBe(main.sqrtPriceX96)
    expect(v4.liquidity).toBe(main.liquidity)
    expect(v4.lpFee).toBe(3000)
    expect(v4.tickWindow).toEqual(window)
    expect([...v4.ticks]).toEqual([...main.ticks].sort((a, b) => a[0] - b[0]))

    const v3 = states.get(V3.poolId)!
    expect(v3.block).toBe(123)
    expect(v3.sqrtPriceX96).toBe(main.sqrtPriceX96)
    expect(v3.tick).toBe(main.tick)
    expect(v3.liquidity).toBe(main.liquidity)
    expect(v3.lpFee).toBe(500) // from info.fee, not from chain
    expect(v3.protocolFee).toBe(0)
    expect(v3.tickSpacing).toBe(60)
    expect(v3.tickWindow).toEqual(window)
    expect([...v3.ticks]).toEqual([...main.ticks].sort((a, b) => a[0] - b[0]))
    expect(v3.reserves).toBeUndefined()
    // The fetched v3 state is simulation-ready and walks exactly like the fixture (fee aside).
    const asFixture: PoolState = { ...main, lpFee: 500 }
    expect(simulateHop(V3, v3, true, E18)).toEqual(simulateExactInput(asFixture, true, E18, { tickSpacing: 60 }))

    const v2 = states.get(V2.poolId)!
    expect(v2.reserves).toEqual(RESERVES)
    expect(v2.sqrtPriceX96).toBe(v2SqrtPriceX96(RESERVES))
    expect(v2.liquidity).toBe(v2Liquidity(RESERVES))
    expect(v2.lpFee).toBe(3000)
    expect(v2.tickSpacing).toBe(0)
    expect(v2.ticks.size).toBe(0)

    // Without hints: v4 = 3 extsload round trips (heads, words, ticks); v3 = 3 multicalls; v2 = 1 multicall.
    expect(counts.extsload).toBe(3)
    expect(counts.multicall).toBe(4)
  })

  it('tick hints save the bitmap-word round trip for v4 and v3 alike', async () => {
    const { clients, counts } = fakeClients()
    // Hints in the same bitmap word as the real tick (0): ticks 5 and 30 both compress into word 0.
    const hints = new Map<Hex, number>([
      [V4.poolId, 5],
      [V3.poolId, 30],
    ])
    const states = await fetchPoolStates(clients, cfg, [V3, V4], 123n, { tickHints: hints })
    expect(states.size).toBe(2)
    expect(counts.extsload).toBe(2)
    expect(counts.multicall).toBe(2)
    expect([...states.get(V3.poolId)!.ticks.keys()]).toEqual([-600, -120, 60, 180, 600, 1200])
    // A stale hint in another word (-5 compresses to word -1, so word 2 is missing) costs the extra
    // round trip but still yields the full window around the real tick.
    counts.multicall = 0
    const stale = await fetchPoolStates(clients, cfg, [V3], 123n, { tickHints: new Map([[V3.poolId, -5]]) })
    expect(counts.multicall).toBe(3)
    expect(stale.get(V3.poolId)!.tickWindow).toEqual(states.get(V3.poolId)!.tickWindow)
    expect([...stale.get(V3.poolId)!.ticks]).toEqual([...states.get(V3.poolId)!.ticks])
  })

  it('returns an empty map for no pools without touching the network', async () => {
    const { clients, counts } = fakeClients()
    expect((await fetchPoolStates(clients, cfg, [], 123n)).size).toBe(0)
    expect(counts.extsload + counts.multicall).toBe(0)
  })
})

describe('aggregate3', () => {
  it('splits into batches of at most 300, preserves order and reports failed sub-calls', async () => {
    const seen: number[] = []
    const client = {
      call: async ({ data }: { data: Hex }) => {
        const { args } = decodeFunctionData({ abi: multicall3Abi, data })
        seen.push(args[0].length)
        const results = args[0].map((c) => ({ success: c.callData !== '0xdead', returnData: c.callData }))
        return { data: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results }) }
      },
    }
    const clients = { http: client, chain: arc, sendUrls: [] } as unknown as RpcClients
    const calls: Call3[] = Array.from({ length: 650 }, (_, i) => ({ target: V3_ADDR, callData: i === 301 ? '0xdead' : (`0x${i.toString(16).padStart(8, '0')}` as Hex) }))
    const results = await aggregate3(clients, calls)
    expect(seen).toEqual([300, 300, 50])
    expect(results).toHaveLength(650)
    expect(results[0]).toEqual({ success: true, returnData: '0x00000000' })
    expect(results[301]).toEqual({ success: false, returnData: '0xdead' })
    expect(results[649]).toEqual({ success: true, returnData: '0x00000289' })
    expect(await aggregate3(clients, [])).toEqual([])
    // custom batch size
    seen.length = 0
    await aggregate3(clients, calls.slice(0, 7), undefined, { batchSize: 3 })
    expect(seen).toEqual([3, 3, 1])
  })

  it('fails loudly when the multicall itself returns nothing (no code)', async () => {
    const client = { call: async () => ({}) }
    const clients = { http: client, chain: arc, sendUrls: [] } as unknown as RpcClients
    await expect(aggregate3(clients, [{ target: V3_ADDR, callData: '0x' }])).rejects.toThrow(/empty response/)
  })
})
