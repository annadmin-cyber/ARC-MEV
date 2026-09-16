import { beforeEach, describe, expect, it } from 'vitest'
import {
  BaseError,
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
  encodeFunctionResult,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { executorAbi } from '../../src/abi/index.js'
import { toExecutorSteps, toGuards } from '../../src/exec/encode.js'
import { clearOperatorCache, describeRevert, resolveOperator, revertDataOf, simulateOnChain } from '../../src/exec/simulate.js'
import { CYCLE, EXECUTOR, INFOS, STATES, TEST_ADDRESS, TEST_KEY, testConfig } from './helpers.js'

/** `Unprofitable(int256 delta, uint256 minProfit)` with (-123, 0): selector 0x263e42e6 (cast sig) + abi-encoded args. */
const UNPROFITABLE_HAND: Hex =
  '0x263e42e6ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff850000000000000000000000000000000000000000000000000000000000000000'

const OWNER: Address = '0x00000000000000000000000000000000000000ee'
const steps = toExecutorSteps(CYCLE, INFOS)
const guards = toGuards(CYCLE, STATES, 1)
const opp = { amountIn: 10n ** 18n }

type Handler = (method: string, params: unknown[]) => Promise<unknown>

/** A real viem client whose transport is a fake JSON-RPC provider (no retries, no network). */
function fakeClient(handler: Handler): { client: PublicClient; calls: Array<{ method: string; params: unknown[] }> } {
  const calls: Array<{ method: string; params: unknown[] }> = []
  const client = createPublicClient({
    transport: custom(
      {
        request: ({ method, params }: { method: string; params: unknown[] }) => {
          calls.push({ method, params })
          return handler(method, params)
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient
  return { client, calls }
}

/** What a node returns for a revert: JSON-RPC error code 3 with the revert data. */
function revert(data: Hex): never {
  throw { code: 3, message: 'execution reverted', data }
}

describe('revert decoding', () => {
  it('hand-encoded Unprofitable matches viem encoding and decodes from a plain JSON-RPC error', () => {
    expect(encodeErrorResult({ abi: executorAbi, errorName: 'Unprofitable', args: [-123n, 0n] })).toBe(UNPROFITABLE_HAND)
    expect(revertDataOf({ code: 3, message: 'execution reverted', data: UNPROFITABLE_HAND })).toBe(UNPROFITABLE_HAND)
    expect(describeRevert({ code: 3, message: 'execution reverted', data: UNPROFITABLE_HAND })).toBe('Unprofitable(-123, 0)')
  })

  it('finds the data through nested causes and provider-specific `{ data: { data } }` shapes', () => {
    const inner = { code: 3, message: 'execution reverted', data: { data: UNPROFITABLE_HAND } }
    const wrapped = new BaseError('call failed', { cause: inner as unknown as Error })
    expect(describeRevert(wrapped)).toBe('Unprofitable(-123, 0)')
    const stale = encodeErrorResult({ abi: executorAbi, errorName: 'StaleState', args: [1n, 12345n] })
    expect(describeRevert(new Error('reverted', { cause: { data: stale } }))).toBe('StaleState(1, 12345)')
  })

  it('falls back to hex found in the message, to the raw selector, or to the message itself', () => {
    expect(describeRevert(new Error(`execution reverted: ${UNPROFITABLE_HAND}`))).toBe('Unprofitable(-123, 0)')
    expect(describeRevert({ data: '0xdeadbeef00' })).toBe('revert 0xdeadbeef (5 bytes)')
    expect(describeRevert(new Error('block not found'))).toBe('block not found')
    expect(revertDataOf('0x')).toBeUndefined()
  })
})

describe('simulateOnChain', () => {
  beforeEach(() => clearOperatorCache())

  const withKey = testConfig({ EXECUTOR_ADDRESS: EXECUTOR, PRIVATE_KEY: TEST_KEY })
  const withoutKey = testConfig({ EXECUTOR_ADDRESS: EXECUTOR })
  const expectedData = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [steps, opp.amountIn, 0n, guards] })

  it('reports the decoded custom error when execute reverts', async () => {
    const { client, calls } = fakeClient(async (method) => {
      if (method === 'eth_call') revert(UNPROFITABLE_HAND)
      throw new Error(`unexpected ${method}`)
    })
    const result = await simulateOnChain({ http: client }, withKey, opp, steps, guards, 4242n)
    expect(result).toEqual({ ok: false, reason: 'Unprofitable(-123, 0)' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual([{ from: TEST_ADDRESS, to: EXECUTOR, data: expectedData }, '0x1092'])
  })

  it('returns the profit and the gas estimate from the operator key address at the given block', async () => {
    const { client, calls } = fakeClient(async (method) => {
      if (method === 'eth_call') return encodeFunctionResult({ abi: executorAbi, functionName: 'execute', result: 987_654n })
      if (method === 'eth_estimateGas') return '0x30d40'
      throw new Error(`unexpected ${method}`)
    })
    const result = await simulateOnChain({ http: client }, withKey, opp, steps, guards, 100n)
    expect(result).toEqual({ ok: true, profit: 987_654n, gas: 200_000n, gasSource: 'estimate' })
    expect(calls.map((c) => c.method)).toEqual(['eth_call', 'eth_estimateGas'])
    expect(calls[1]!.params).toEqual(calls[0]!.params)
  })

  it('falls back to GAS_LIMIT when eth_estimateGas fails', async () => {
    const cfg = testConfig({ EXECUTOR_ADDRESS: EXECUTOR, PRIVATE_KEY: TEST_KEY, GAS_LIMIT: '777000' })
    const { client } = fakeClient(async (method) => {
      if (method === 'eth_call') return encodeFunctionResult({ abi: executorAbi, functionName: 'execute', result: 1n })
      throw { code: -32000, message: 'gas required exceeds allowance' }
    })
    const result = await simulateOnChain({ http: client }, cfg, opp, steps, guards, 100n)
    expect(result).toEqual({ ok: true, profit: 1n, gas: 777_000n, gasSource: 'config' })
  })

  it('reads owner() once and simulates from it when no PRIVATE_KEY is configured', async () => {
    const { client, calls } = fakeClient(async (method, params) => {
      if (method === 'eth_call') {
        const [call] = params as [{ to: Address; data: Hex; from?: Address }]
        if (call.data === '0x8da5cb5b') return encodeAbiParameters([{ type: 'address' }], [OWNER])
        expect(call.from).toBe(OWNER)
        return encodeFunctionResult({ abi: executorAbi, functionName: 'execute', result: 5n })
      }
      if (method === 'eth_estimateGas') return '0x1'
      throw new Error(`unexpected ${method}`)
    })
    expect(await resolveOperator({ http: client }, withoutKey)).toBe(OWNER)
    const first = await simulateOnChain({ http: client }, withoutKey, opp, steps, guards, 1n)
    const second = await simulateOnChain({ http: client }, withoutKey, opp, steps, guards, 2n)
    expect(first).toEqual({ ok: true, profit: 5n, gas: 1n, gasSource: 'estimate' })
    expect(second.ok).toBe(true)
    const ownerReads = calls.filter((c) => c.method === 'eth_call' && (c.params as [{ data: Hex }])[0].data === '0x8da5cb5b')
    expect(ownerReads).toHaveLength(1)
  })

  it('returns a setup failure instead of throwing when EXECUTOR_ADDRESS is missing', async () => {
    const { client, calls } = fakeClient(async () => {
      throw new Error('should not be called')
    })
    const result = await simulateOnChain({ http: client }, testConfig({ PRIVATE_KEY: TEST_KEY }), opp, steps, guards, 1n)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toMatch(/EXECUTOR_ADDRESS/)
    expect(calls).toHaveLength(0)
  })

  it('retries briefly while the node has not indexed the block yet', async () => {
    let attempts = 0
    const { client } = fakeClient(async (method) => {
      if (method === 'eth_call') {
        attempts++
        if (attempts < 3) throw { code: -32001, message: 'block not found' }
        return encodeFunctionResult({ abi: executorAbi, functionName: 'execute', result: 42n })
      }
      return '0x10'
    })
    const result = await simulateOnChain({ http: client }, withKey, opp, steps, guards, 1n)
    expect(result).toEqual({ ok: true, profit: 42n, gas: 16n, gasSource: 'estimate' })
    expect(attempts).toBe(3)
  })
})
