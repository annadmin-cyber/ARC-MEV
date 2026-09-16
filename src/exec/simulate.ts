/**
 * On-chain pre-flight of an opportunity: a plain `eth_call` of `ArcArbExecutor.execute` from the
 * operator address at the block the local state was read at, with `minProfit = 0` so the call
 * returns the realised profit instead of reverting on a small shortfall. Reverts are decoded
 * against the executor ABI (`Unprofitable`, `StaleState`, `PathBroken`, ...). When the call
 * succeeds the gas is estimated with `eth_estimateGas` on the same call, falling back to
 * `cfg.GAS_LIMIT` when the node refuses to estimate.
 */
import {
  BaseError,
  decodeErrorResult,
  decodeFunctionResult,
  hexToBigInt,
  isHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { executorAbi } from '../abi/index.js'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { sleep, withRetry, type RpcClients } from '../rpc/client.js'
import { isBlockNotReady } from '../state/cache.js'
import type { ExecutorStep, Opportunity, StateGuard } from '../types.js'
import { encodeExecute } from './encode.js'

/** Outcome of {@link simulateOnChain}. */
export type SimulationResult =
  | {
      ok: true
      /** Profit returned by `execute`, in the cycle's start currency units. */
      profit: bigint
      /** Gas the transaction should be sent with. */
      gas: bigint
      /** Whether `gas` came from `eth_estimateGas` or from `cfg.GAS_LIMIT`. */
      gasSource: 'estimate' | 'config'
    }
  | { ok: false; reason: string }

/** Attempts made when the node has not indexed `block` yet (-32001 "block not found"). */
const BLOCK_NOT_READY_TRIES = 6
const BLOCK_NOT_READY_WAIT_MS = 50

/** Executor address -> operator address, so `owner()` is read at most once per executor. */
const operatorCache = new Map<Address, Address>()

/** Forget cached operator addresses (tests). */
export function clearOperatorCache(): void {
  operatorCache.clear()
}

/**
 * The address simulations are sent from: the bot's hot key when `PRIVATE_KEY` is configured
 * (the executor's `operator`), otherwise the executor's `owner()` (read once and cached), which
 * the contract also accepts for `execute`.
 */
export async function resolveOperator(clients: Pick<RpcClients, 'http'>, cfg: Pick<Config, 'PRIVATE_KEY' | 'EXECUTOR_ADDRESS'>): Promise<Address> {
  if (cfg.PRIVATE_KEY) return privateKeyToAccount(cfg.PRIVATE_KEY).address.toLowerCase() as Address
  const executor = requireExecutor(cfg)
  const cached = operatorCache.get(executor)
  if (cached) return cached
  const owner = await withRetry(
    () => clients.http.readContract({ address: executor, abi: executorAbi, functionName: 'owner' }),
    { label: 'executor.owner()' },
  )
  const lower = owner.toLowerCase() as Address
  operatorCache.set(executor, lower)
  log.info({ executor, owner: lower }, 'simulating from executor owner (no PRIVATE_KEY configured)')
  return lower
}

/** `cfg.EXECUTOR_ADDRESS`, lower-cased, or an error explaining why simulation is impossible. */
export function requireExecutor(cfg: Pick<Config, 'EXECUTOR_ADDRESS'>): Address {
  if (!cfg.EXECUTOR_ADDRESS) throw new Error('EXECUTOR_ADDRESS is not configured')
  return cfg.EXECUTOR_ADDRESS.toLowerCase() as Address
}

/** JSON-RPC call object shared by `eth_call` and `eth_estimateGas`. */
interface CallObject {
  from: Address
  to: Address
  data: Hex
}

/**
 * Simulate `execute(steps, opp.amountIn, 0, guards)` at `block` and, on success, estimate its
 * gas. Never throws for chain-side outcomes: reverts, RPC refusals and missing configuration are
 * reported as `{ ok: false, reason }`.
 */
export async function simulateOnChain(
  clients: Pick<RpcClients, 'http'>,
  cfg: Pick<Config, 'PRIVATE_KEY' | 'EXECUTOR_ADDRESS' | 'GAS_LIMIT'>,
  opp: Pick<Opportunity, 'amountIn'>,
  steps: readonly ExecutorStep[],
  guards: readonly StateGuard[],
  block: bigint,
): Promise<SimulationResult> {
  let call: CallObject
  try {
    call = { from: await resolveOperator(clients, cfg), to: requireExecutor(cfg), data: encodeExecute(steps, opp.amountIn, 0n, guards) }
  } catch (error) {
    return { ok: false, reason: `setup: ${errorMessage(error)}` }
  }
  const blockTag = toHex(block)

  let returned: Hex
  try {
    returned = await callWhenReady(() =>
      withRetry(() => clients.http.request({ method: 'eth_call', params: [call, blockTag] }), { label: 'eth_call execute' }),
    )
  } catch (error) {
    return { ok: false, reason: describeRevert(error) }
  }

  let profit: bigint
  try {
    profit = decodeFunctionResult({ abi: executorAbi, functionName: 'execute', data: returned })
  } catch (error) {
    return { ok: false, reason: `undecodable return data ${returned}: ${errorMessage(error)}` }
  }

  const gas = await estimateGas(clients, cfg, call, blockTag)
  return gas === undefined
    ? { ok: true, profit, gas: BigInt(cfg.GAS_LIMIT), gasSource: 'config' }
    : { ok: true, profit, gas, gasSource: 'estimate' }
}

/** `eth_estimateGas` for `call` at `blockTag`; `undefined` (logged at debug) when the node refuses. */
async function estimateGas(
  clients: Pick<RpcClients, 'http'>,
  cfg: Pick<Config, 'GAS_LIMIT'>,
  call: CallObject,
  blockTag: Hex,
): Promise<bigint | undefined> {
  try {
    const raw = await withRetry(() => clients.http.request({ method: 'eth_estimateGas', params: [call, blockTag] }), {
      label: 'eth_estimateGas execute',
    })
    if (!isHex(raw)) throw new Error(`unexpected eth_estimateGas result ${String(raw)}`)
    return hexToBigInt(raw)
  } catch (error) {
    log.debug({ err: errorMessage(error), fallbackGas: cfg.GAS_LIMIT }, 'eth_estimateGas failed, using GAS_LIMIT')
    return undefined
  }
}

/** Run `fn`, retrying briefly while the node answers "block not found" for a block it will have shortly. */
async function callWhenReady(fn: () => Promise<unknown>): Promise<Hex> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await fn()
      if (!isHex(result)) throw new Error(`unexpected eth_call result ${String(result)}`)
      return result
    } catch (error) {
      if (attempt >= BLOCK_NOT_READY_TRIES || !isBlockNotReady(error)) throw error
      await sleep(BLOCK_NOT_READY_WAIT_MS)
    }
  }
}

/**
 * Human-readable reason for a failed `eth_call`: the decoded executor custom error when revert
 * data is present (`Unprofitable(-123, 0)`), the raw selector when the data is not in the
 * executor ABI, or the RPC error message otherwise.
 */
export function describeRevert(error: unknown): string {
  const data = revertDataOf(error)
  if (data === undefined) return errorMessage(error)
  try {
    const decoded = decodeErrorResult({ abi: executorAbi, data })
    const args = (decoded.args ?? []).map((a) => (typeof a === 'bigint' ? a.toString() : String(a)))
    return `${decoded.errorName}(${args.join(', ')})`
  } catch {
    return data.length >= 10 ? `revert ${data.slice(0, 10)} (${data.length / 2 - 1} bytes)` : `revert ${data}`
  }
}

/**
 * Extract the revert data carried by a JSON-RPC error, wherever the transport put it: viem's
 * `RpcRequestError.data` (a hex string, or an object with a `data` field on some providers) at
 * any depth of the `cause` chain, or a hex blob embedded in the message as a last resort.
 */
export function revertDataOf(error: unknown): Hex | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    const hex = hexIn(data)
    if (hex !== undefined) return hex
    current = (current as { cause?: unknown }).cause
  }
  const match = /0x[0-9a-fA-F]{8,}/.exec(errorMessage(error))
  return match ? (match[0] as Hex) : undefined
}

/** A hex string directly, or the `data` field of an object (`{ data: "0x..." }`). */
function hexIn(value: unknown): Hex | undefined {
  if (typeof value === 'string') return isHex(value) && value.length > 2 ? value : undefined
  if (value !== null && typeof value === 'object') return hexIn((value as { data?: unknown }).data)
  return undefined
}

/** Short one-line message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage
  if (error instanceof Error) return error.message
  return String(error)
}
