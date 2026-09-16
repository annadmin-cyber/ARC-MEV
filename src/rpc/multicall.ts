/**
 * Batched `eth_call`s through Multicall3 `aggregate3` (allowFailure per call), split into chunks
 * of at most `batchSize` calls that run under a concurrency limiter with retry. v3-style pools and
 * v2-style pairs have no `extsload`; their `slot0()` / `liquidity()` / `tickBitmap()` / `ticks()` /
 * `getReserves()` reads are aggregated here instead.
 */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem'
import { multicall3Abi } from '../abi/index.js'
import { limiter, withRetry, type Limiter, type RpcClients } from './client.js'

/** Canonical Multicall3 deployment (same address on Arc; see chains.ts). */
export const MULTICALL3_ADDRESS: Address = '0xca11bde05977b3631167028862be2a173976ca11'

/** Calls per `aggregate3` request. 300 x ~3k gas stays far below any provider's eth_call gas cap. */
export const MULTICALL_BATCH = 300

/** One sub-call of an `aggregate3` batch. */
export interface Call3 {
  target: Address
  callData: Hex
  /** Let this call revert without failing the whole batch. Default true. */
  allowFailure?: boolean
}

/** Result of one sub-call: `success` false means the target reverted (or has no code). */
export interface Call3Result {
  success: boolean
  returnData: Hex
}

/** Options for {@link aggregate3}. */
export interface Aggregate3Options {
  /** Calls per request. Default {@link MULTICALL_BATCH}. */
  batchSize?: number
  /** Concurrency limiter shared with other readers. Default: a limiter of 4 per call site. */
  limit?: Limiter
  /** Multicall3 address. Default: the chain definition's `contracts.multicall3`, else the canonical one. */
  multicall?: Address
}

const defaultLimiter = limiter(4)

/**
 * Run `calls` through Multicall3 `aggregate3` at `block` (latest when omitted) and return one
 * result per call, in order. Sub-calls default to `allowFailure: true`, so a reverting target
 * yields `{ success: false }` instead of failing the batch; only transport / rate-limit errors
 * propagate (after retry).
 */
export async function aggregate3(
  clients: RpcClients,
  calls: readonly Call3[],
  block?: bigint,
  opts: Aggregate3Options = {},
): Promise<Call3Result[]> {
  if (calls.length === 0) return []
  const batchSize = Math.max(1, opts.batchSize ?? MULTICALL_BATCH)
  const limit = opts.limit ?? defaultLimiter
  const to = (opts.multicall ?? multicallAddress(clients)).toLowerCase() as Address
  const client = clients.httpSingle ?? clients.http
  const chunks: Call3[][] = []
  for (let i = 0; i < calls.length; i += batchSize) chunks.push(calls.slice(i, i + batchSize))
  const results = await Promise.all(
    chunks.map((chunk, idx) =>
      limit(() =>
        withRetry(
          async () => {
            const data = encodeFunctionData({
              abi: multicall3Abi,
              functionName: 'aggregate3',
              args: [chunk.map((c) => ({ target: c.target, allowFailure: c.allowFailure ?? true, callData: c.callData }))],
            })
            const { data: returned } = await client.call({
              to,
              data,
              ...(block === undefined ? {} : { blockNumber: block }),
            })
            if (returned === undefined) throw new Error(`aggregate3: empty response for chunk ${idx} (no code at ${to}?)`)
            const decoded = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: returned })
            if (decoded.length !== chunk.length) {
              throw new Error(`aggregate3: expected ${chunk.length} results, got ${decoded.length} (chunk ${idx})`)
            }
            return decoded.map((r) => ({ success: r.success, returnData: r.returnData }))
          },
          { label: `aggregate3#${idx}` },
        ),
      ),
    ),
  )
  return results.flat()
}

/** The Multicall3 address for the clients' chain. */
export function multicallAddress(clients: Pick<RpcClients, 'chain'>): Address {
  const fromChain = clients.chain.contracts?.['multicall3']?.address
  return (fromChain ?? MULTICALL3_ADDRESS).toLowerCase() as Address
}
