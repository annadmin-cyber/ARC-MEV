/**
 * Demonstrates: `revertDataOf` (src/exec/simulate.ts) claims to fall back to "a hex blob embedded
 * in the message", but through a real viem transport the node's message never reaches that regex:
 * viem wraps a code -32000 "execution reverted: 0x…" error in InvalidInputRpcError and
 * `errorMessage()` returns viem's generic shortMessage, so the reason logged is
 * "Missing or invalid parameters." instead of the decoded executor error.
 */
import { describe, expect, it } from 'vitest'
import { createPublicClient, encodeErrorResult, http, type Hex, type PublicClient } from 'viem'
import { executorAbi } from '../../src/abi/index.js'
import { toExecutorSteps, toGuards } from '../../src/exec/encode.js'
import { simulateOnChain } from '../../src/exec/simulate.js'
import { CYCLE, EXECUTOR, INFOS, STATES, TEST_KEY, testConfig } from '../exec/helpers.js'

const cfg = testConfig({ EXECUTOR_ADDRESS: EXECUTOR, PRIVATE_KEY: TEST_KEY, DRY_RUN: 'false' })

/** A fake node whose eth_call reverts with the hex only in the message (no `data` field). */
function fakeFetch(data: Hex): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const answer = (req: { id: number; method: string }) =>
      req.method === 'eth_call'
        ? { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: `execution reverted: ${data}` } }
        : { jsonrpc: '2.0', id: req.id, result: '0x0' }
    const out = Array.isArray(body) ? body.map(answer) : answer(body)
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('review: revert hex carried only in the RPC error message is not decoded through viem', () => {
  it('reports the executor error instead of viem\'s generic "Missing or invalid parameters."', async () => {
    const data = encodeErrorResult({ abi: executorAbi, errorName: 'Unprofitable', args: [-5n, 0n] })
    const client = createPublicClient({ transport: http('http://fake.local', { batch: true, retryCount: 0, fetchFn: fakeFetch(data) }) }) as PublicClient
    const res = await simulateOnChain({ http: client }, cfg, { amountIn: 1n }, toExecutorSteps(CYCLE, INFOS), toGuards(CYCLE, STATES, 1), 100n)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('Unprofitable(-5, 0)')
  })
})
