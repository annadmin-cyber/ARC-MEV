import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, custom, encodeFunctionResult, keccak256, type Hex, type PublicClient } from 'viem'
import { executorAbi } from '../../src/abi/index.js'
import { privateKeyToAccount } from 'viem/accounts'
import { ArbBot } from '../../src/exec/bot.js'
import { Sender, type SendTransport } from '../../src/exec/sender.js'
import { clearOperatorCache } from '../../src/exec/simulate.js'
import { groupCycles } from '../../src/exec/pipeline.js'
import { log } from '../../src/logger.js'
import type { RpcClients } from '../../src/rpc/client.js'
import type { RawLog } from '../../src/rpc/logs.js'
import type { StateCache } from '../../src/state/cache.js'
import type { HookedProbe, ProbedOpportunity, ProbeResult } from '../../src/strategy/probe.js'
import type { PoolState } from '../../src/types.js'
import { CYCLE, EXECUTOR, INFOS, P2, rpcHeader, STATES, TEST_ADDRESS, TEST_KEY, testConfig } from './helpers.js'

/** Header of every block: extraData announces 130.86 gwei; the profit `execute` reports and the gas estimate. */
const NEXT_BASE_FEE = 130_864_684_151n
const SIM_PROFIT = 3n * 10n ** 18n

type Handler = (method: string, params: unknown[]) => Promise<unknown>

function fakeHttp(handler: Handler): { client: PublicClient; calls: Array<{ method: string; params: unknown[]; at: number }> } {
  const calls: Array<{ method: string; params: unknown[]; at: number }> = []
  const client = createPublicClient({
    transport: custom(
      {
        request: ({ method, params }: { method: string; params: unknown[] }) => {
          calls.push({ method, params, at: performance.now() })
          return handler(method, params)
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient
  return { client, calls }
}

/** A cache whose applyBlock resolves after `delayMs` with the given touched set (and replayed logs, if given). */
function fakeCache(states: Map<Hex, PoolState>, touched: Hex[], delayMs = 20, replayed?: { fromBlock: bigint; logs: RawLog[] }) {
  const applied: Array<{ block: bigint; at: number }> = []
  const cache = {
    applyBlock: async (block: bigint) => {
      await new Promise((r) => setTimeout(r, delayMs))
      applied.push({ block, at: performance.now() })
      return replayed ? { touched: new Set(touched), block, replayed } : { touched: new Set(touched), block }
    },
    all: () => states,
    get: (id: Hex) => states.get(id),
  }
  return { cache: cache as unknown as StateCache, applied }
}

function defaultHandler(): Handler {
  return async (method) => {
    if (method === 'eth_getBlockByNumber') return rpcHeader(100n, '0x0000001e78249c77')
    if (method === 'eth_call') return encodeFunctionResult({ abi: executorAbi, functionName: 'execute', result: SIM_PROFIT })
    if (method === 'eth_estimateGas') return '0x493e0'
    throw new Error(`unexpected ${method}`)
  }
}

function infoLogs(spy: { mock: { calls: unknown[][] } }): Array<[Record<string, unknown>, string]> {
  return spy.mock.calls.map((c) => [c[0] as Record<string, unknown>, c[1] as string])
}

describe('ArbBot.processBlock', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    clearOperatorCache()
  })

  const cfg = testConfig({ EXECUTOR_ADDRESS: EXECUTOR, PRIVATE_KEY: TEST_KEY })
  const groups = groupCycles(cfg, [CYCLE])

  it('fetches the header while the logs are applied, prices with the next base fee and reports the dry-run plan', async () => {
    const { client, calls } = fakeHttp(defaultHandler())
    const { cache, applied } = fakeCache(STATES, [P2.poolId], 30)
    const info = vi.spyOn(log, 'info')
    const bot = new ArbBot({ clients: { http: client } as RpcClients, cfg, cache, infos: INFOS, groups })
    await bot.processBlock(100n, 0n)

    const header = calls.find((c) => c.method === 'eth_getBlockByNumber')
    expect(header).toBeDefined()
    expect(header!.params).toEqual(['0x64', false])
    // The header request went out before applyBlock finished (concurrent, not sequential).
    expect(header!.at).toBeLessThan(applied[0]!.at)
    expect(calls.map((c) => c.method)).toEqual(['eth_getBlockByNumber', 'eth_call', 'eth_estimateGas'])

    const [details, msg] = infoLogs(info).find(([, m]) => m === 'would send (DRY_RUN)')!
    expect(msg).toBe('would send (DRY_RUN)')
    expect(details['probed']).toBe(false)
    expect(details['gas']).toBe(360_000n)
    expect(details['simulatedGrossUsdc']).toBe('3')
    // maxFeePerGas = 2 * nextBaseFee + tip: the header's announcement was used, not the header's own base fee.
    const tipWei = Number(details['tipGwei']) * 1e9
    const maxFeeWei = Number(details['maxFeeGwei']) * 1e9
    expect(maxFeeWei - tipWei).toBeCloseTo(Number(2n * NEXT_BASE_FEE), -8)
  })

  it('does nothing when nothing was touched and no full evaluation is due', async () => {
    const { client, calls } = fakeHttp(defaultHandler())
    const { cache } = fakeCache(STATES, [])
    const bot = new ArbBot({ clients: { http: client } as RpcClients, cfg, cache, infos: INFOS, groups })
    await bot.processBlock(5n, 0n)
    expect(calls.map((c) => c.method)).toEqual(['eth_getBlockByNumber'])
  })

  it('merges probed opportunities into the ranking and simulates them with the hooked pool state', async () => {
    const { client, calls } = fakeHttp(defaultHandler())
    const { cache } = fakeCache(new Map([[P2.poolId, STATES.get(P2.poolId)!]]), [])
    const hookedState = STATES.get(CYCLE.hops[0]!.poolId)!
    const probedOpp: ProbedOpportunity = {
      cycle: CYCLE,
      amountIn: 10n ** 18n,
      amountOut: 2n * 10n ** 18n,
      grossProfit: 10n ** 18n,
      block: 7,
      truncated: false,
      evaluations: 7,
      probed: true,
      quoterGas: 80_000n,
    }
    const probeCalls: Array<{ block: bigint; touchedHooked: Set<Hex>; touchedTracked: Set<Hex> }> = []
    const probe = {
      infos: () => new Map([[hookedState.poolId, INFOS.get(hookedState.poolId)!]]),
      states: () => new Map([[hookedState.poolId, hookedState]]),
      advance: async (_block: bigint) => new Set<Hex>([hookedState.poolId]),
      probe: async (block: bigint, _states: unknown, _bounds: unknown, touchedHooked: Set<Hex>, touchedTracked: Set<Hex>): Promise<ProbeResult> => {
        probeCalls.push({ block, touchedHooked, touchedTracked })
        return { opportunities: [probedOpp], candidates: 1, probes: 1, calls: 7, latencyMs: 12, touchedHooked: 1 }
      },
    } as unknown as HookedProbe
    const info = vi.spyOn(log, 'info')
    const bot = new ArbBot({ clients: { http: client } as RpcClients, cfg, cache, infos: new Map([[P2.poolId, P2]]), groups: [], probe })
    await bot.processBlock(7n, 0n)
    expect(probeCalls).toEqual([{ block: 7n, touchedHooked: new Set([hookedState.poolId]), touchedTracked: new Set() }])
    // The executor simulation ran (guards need the hooked pool's state, which only the probe knows).
    expect(calls.map((c) => c.method)).toEqual(['eth_getBlockByNumber', 'eth_call', 'eth_estimateGas'])
    const [details] = infoLogs(info).find(([, m]) => m === 'would send (DRY_RUN)')!
    expect(details['probed']).toBe(true)
    expect(details['guards']).toBe(2)
  })

  it('hands the cache\'s replayed logs to the probe and reports touched pools by kind', async () => {
    const { client } = fakeHttp(defaultHandler())
    const logs = [{ address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', topics: ['0x00'], data: '0x', blockNumber: 8n, logIndex: 0 } as unknown as RawLog]
    const { cache } = fakeCache(STATES, [], 5, { fromBlock: 8n, logs })
    const advances: unknown[] = []
    const probe = {
      infos: () => new Map(),
      states: () => new Map(),
      advance: async (block: bigint, prefetched: unknown) => {
        advances.push([block, prefetched])
        return new Set<Hex>()
      },
      probe: async (): Promise<ProbeResult> => ({ opportunities: [], candidates: 0, probes: 0, calls: 0, latencyMs: 0, touchedHooked: 0 }),
    } as unknown as HookedProbe
    const debug = vi.spyOn(log, 'debug')
    const bot = new ArbBot({ clients: { http: client } as RpcClients, cfg, cache, infos: INFOS, groups, probe })
    await bot.processBlock(8n, 0n)
    expect(advances).toEqual([[8n, { fromBlock: 8n, logs }]])
    const line = debug.mock.calls.find((c) => c[1] === 'block: no opportunity')
    expect(line?.[0]).toMatchObject({ block: 8n, touched: 0, touchedKinds: { v4: 0, v3: 0, v2: 0 } })
  })

  it('falls back to the latest base fee when the header cannot be read', async () => {
    let headers = 0
    const { client } = fakeHttp(async (method, params) => {
      if (method === 'eth_getBlockByNumber') {
        headers++
        if ((params as unknown[])[0] !== 'latest') throw new Error('boom')
        return rpcHeader(99n, '0x')
      }
      return defaultHandler()(method, params)
    })
    const { cache } = fakeCache(STATES, [P2.poolId])
    const info = vi.spyOn(log, 'info')
    const bot = new ArbBot({ clients: { http: client } as RpcClients, cfg, cache, infos: INFOS, groups })
    await bot.processBlock(99n, 0n)
    expect(headers).toBe(2)
    expect(infoLogs(info).some(([, m]) => m === 'would send (DRY_RUN)')).toBe(true)
  })

  it('sends when live, feeds receipts to the breaker and stops sending once it trips', async () => {
    const live = testConfig({ EXECUTOR_ADDRESS: EXECUTOR, PRIVATE_KEY: TEST_KEY, DRY_RUN: 'false', MAX_CONSECUTIVE_REVERTS: '2', BREAKER_PAUSE_BLOCKS: '10' })
    const { client } = fakeHttp(defaultHandler())
    const { cache } = fakeCache(STATES, [P2.poolId])
    const sends: bigint[] = []
    const sender = {
      canSend: () => true,
      inFlight: undefined,
      send: async (_tx: unknown, block: bigint) => {
        sends.push(block)
        return { hash: `0x${'ab'.repeat(32)}` as Hex, nonce: 1, sentTo: ['x'], fanout: Promise.resolve({ accepted: ['x'], rejected: [] }) }
      },
      waitForReceipt: async (hash: Hex) => ({ hash, status: 'reverted' as const, blockNumber: sends[sends.length - 1]! + 1n, gasUsed: 100_000n, effectiveGasPrice: 10n ** 9n, feePaid: 10n ** 14n }),
    } as unknown as Sender
    const warn = vi.spyOn(log, 'warn')
    const bot = new ArbBot({ clients: { http: client } as RpcClients, cfg: live, cache, infos: INFOS, groups, sender })
    await bot.processBlock(10n, 0n)
    await new Promise((r) => setTimeout(r, 5))
    await bot.processBlock(11n, 0n)
    await new Promise((r) => setTimeout(r, 5))
    expect(sends).toEqual([10n, 11n])
    expect(bot.gate.breaker.tripCount).toBe(1)
    expect(bot.gate.breaker.pausedUntilBlock()).toBe(22n)
    expect(bot.gate.budget.spent(12n)).toBe(2n * 10n ** 14n)
    await bot.processBlock(12n, 0n)
    expect(sends).toEqual([10n, 11n])
    expect(warn.mock.calls.some((c) => c[1] === 'would send (circuit breaker paused sending)')).toBe(true)
    await bot.processBlock(22n, 0n)
    expect(sends).toEqual([10n, 11n, 22n])
  })

  it('does not count a receipt that arrives after the first wait timed out as a loss: the late receipt feeds the gate and the budget', async () => {
    const live = testConfig({ EXECUTOR_ADDRESS: EXECUTOR, PRIVATE_KEY: TEST_KEY, DRY_RUN: 'false', MAX_CONSECUTIVE_REVERTS: '1', BREAKER_PAUSE_BLOCKS: '10' })
    const { client } = fakeHttp(defaultHandler())
    const { cache } = fakeCache(STATES, [P2.poolId])
    let receiptPolls = 0
    let sentHash: Hex | undefined
    const transport: SendTransport = {
      request: async (_url, method, params) => {
        if (method === 'eth_getTransactionCount') return '0x3'
        if (method === 'eth_sendRawTransaction') return (sentHash = keccak256(params[0] as Hex))
        if (method === 'eth_getTransactionReceipt') {
          // Nothing for the first ~40 ms (the RPC lags), then a successful receipt in block 41.
          receiptPolls++
          if (receiptPolls < 8) return null
          return {
            transactionHash: sentHash,
            transactionIndex: '0x0',
            blockHash: `0x${'22'.repeat(32)}`,
            blockNumber: '0x29',
            from: TEST_ADDRESS,
            to: EXECUTOR,
            cumulativeGasUsed: '0x5208',
            gasUsed: '0x30d40',
            effectiveGasPrice: '0x2540be400',
            contractAddress: null,
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            type: '0x2',
          }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const sender = new Sender({ http: client, sendUrls: [live.RPC_URL] }, live, privateKeyToAccount(TEST_KEY), { transport, receiptPollMs: 5, receiptTimeoutMs: 15 })
    const warn = vi.spyOn(log, 'warn')
    const bot = new ArbBot({ clients: { http: client } as RpcClients, cfg: live, cache, infos: INFOS, groups, sender })
    await bot.processBlock(40n, 0n)
    expect(sender.inFlight?.sentAtBlock).toBe(40n)
    // The first receipt wait has timed out (receiptTimeoutMs) but nothing was booked as lost.
    await new Promise((r) => setTimeout(r, 40))
    expect(warn.mock.calls.some((c) => c[1] === 'no receipt before timeout (tx still pending or dropped)')).toBe(true)
    expect(bot.gate.breaker.consecutiveFailures).toBe(0)
    expect(bot.gate.breaker.tripCount).toBe(0)
    // The late receipt arrives: success recorded, gas booked, no breaker strike, in-flight cleared.
    await new Promise((r) => setTimeout(r, 100))
    expect(receiptPolls).toBeGreaterThanOrEqual(8)
    expect(bot.gate.breaker.consecutiveFailures).toBe(0)
    expect(bot.gate.breaker.tripCount).toBe(0)
    expect(bot.gate.budget.spent(41n)).toBe(200_000n * 10_000_000_000n)
    expect(sender.inFlight).toBeUndefined()
    expect(warn.mock.calls.some((c) => c[1] === 'circuit breaker tripped: sending paused')).toBe(false)
  })

  it('only dry-runs while the rolling gas budget is exhausted', async () => {
    const live = testConfig({ EXECUTOR_ADDRESS: EXECUTOR, PRIVATE_KEY: TEST_KEY, DRY_RUN: 'false', GAS_BUDGET_USDC_WEI: '1', GAS_BUDGET_WINDOW_BLOCKS: '5' })
    const { client } = fakeHttp(defaultHandler())
    const { cache } = fakeCache(STATES, [P2.poolId])
    const sends: bigint[] = []
    const sender = {
      canSend: () => true,
      inFlight: undefined,
      send: async (_tx: unknown, block: bigint) => {
        sends.push(block)
        return { hash: `0x${'cd'.repeat(32)}` as Hex, nonce: 1, sentTo: ['x'], fanout: Promise.resolve({ accepted: ['x'], rejected: [] }) }
      },
      waitForReceipt: async (hash: Hex) => ({ hash, status: 'success' as const, blockNumber: 31n, gasUsed: 1n, effectiveGasPrice: 1n, feePaid: 1n }),
    } as unknown as Sender
    const warn = vi.spyOn(log, 'warn')
    const bot = new ArbBot({ clients: { http: client } as RpcClients, cfg: live, cache, infos: INFOS, groups, sender })
    await bot.processBlock(30n, 0n)
    await new Promise((r) => setTimeout(r, 5))
    await bot.processBlock(32n, 0n)
    expect(sends).toEqual([30n])
    expect(warn.mock.calls.some((c) => c[1] === 'would send (gas budget exhausted)')).toBe(true)
    await bot.processBlock(36n, 0n)
    expect(sends).toEqual([30n, 36n])
  })
})
