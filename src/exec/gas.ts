/**
 * EIP-1559 bidding policy for Arc.
 *
 * Arc orders a block's transactions by descending effective priority fee, so the tip is the only
 * lever for inclusion position. The policy bids a fixed share of the expected profit as tip
 * (clamped to the configured floor / cap), keeps `maxFeePerGas` high enough to survive a base
 * fee spike over the next block, and reports the resulting gas cost and the net profit after a
 * safety margin so the caller can decide whether the opportunity is still worth taking.
 */
import { hexToBigInt, isHex, type Hex, type PublicClient } from 'viem'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { sleep, withRetry, type RpcClients } from '../rpc/client.js'
import { isBlockNotReady } from '../state/cache.js'

/** The fee parameters chosen for one transaction and what they imply for its economics. */
export interface FeeQuote {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  /** `gasLimit * (baseFee + tip)`: the cost if the tx is included at the current base fee. */
  gasCost: bigint
  /** `gasCost * cfg.GAS_SAFETY` (rounded down to wei). */
  safeGasCost: bigint
  /** `expectedProfit18 - safeGasCost`; may be negative. All in USDC wei (18 decimals). */
  net: bigint
}

/** Fixed-point scale used to apply the float config ratios (`TIP_SHARE`, `GAS_SAFETY`) to bigints. */
const RATIO_SCALE = 1_000_000n

/** Multiply a bigint by a non-negative float ratio, rounding down. */
export function mulRatio(value: bigint, ratio: number): bigint {
  if (!Number.isFinite(ratio) || ratio < 0) throw new RangeError(`mulRatio: invalid ratio ${ratio}`)
  return (value * BigInt(Math.round(ratio * Number(RATIO_SCALE)))) / RATIO_SCALE
}

/** Clamp `x` into `[lo, hi]` (if `lo > hi`, `hi` wins so a hard cap is never exceeded). */
function clamp(x: bigint, lo: bigint, hi: bigint): bigint {
  if (x > hi) return hi
  if (x < lo) return lo > hi ? hi : lo
  return x
}

/**
 * Choose fees for a transaction expected to gain `expectedProfit18` (USDC wei, 18 decimals) with
 * gas limit `gasLimit` while the current base fee is `baseFee`:
 *
 * - tip = clamp(floor(expectedProfit18 * TIP_SHARE / gasLimit), MIN_PRIORITY_FEE_WEI, MAX_PRIORITY_FEE_WEI)
 * - maxFeePerGas = min(2 * baseFee + tip, MAX_FEE_PER_GAS_WEI); if even `baseFee + tip` does not
 *   fit under the cap the transaction cannot be included at the current base fee and `null` is
 *   returned ("cannot bid").
 * - gasCost = gasLimit * (baseFee + tip); net = expectedProfit18 - gasCost * GAS_SAFETY.
 *
 * The tip is per gas unit and the profit is the whole transaction's, hence the division by the
 * gas limit: at `TIP_SHARE = 0.5` half of the expected profit goes to the block producer.
 */
export function feePolicy(
  cfg: Pick<Config, 'TIP_SHARE' | 'MIN_PRIORITY_FEE_WEI' | 'MAX_PRIORITY_FEE_WEI' | 'MAX_FEE_PER_GAS_WEI' | 'GAS_SAFETY'>,
  baseFee: bigint,
  expectedProfit18: bigint,
  gasLimit: bigint,
): FeeQuote | null {
  if (gasLimit <= 0n) throw new RangeError(`feePolicy: gasLimit must be positive, got ${gasLimit}`)
  if (baseFee < 0n) throw new RangeError(`feePolicy: baseFee must be non-negative, got ${baseFee}`)
  const profit = expectedProfit18 > 0n ? expectedProfit18 : 0n
  const rawTip = mulRatio(profit, cfg.TIP_SHARE) / gasLimit
  const tip = clamp(rawTip, cfg.MIN_PRIORITY_FEE_WEI, cfg.MAX_PRIORITY_FEE_WEI)
  const needed = baseFee + tip
  if (needed > cfg.MAX_FEE_PER_GAS_WEI) return null
  const generous = 2n * baseFee + tip
  const maxFeePerGas = generous > cfg.MAX_FEE_PER_GAS_WEI ? cfg.MAX_FEE_PER_GAS_WEI : generous
  const gasCost = gasLimit * needed
  const safeGasCost = mulRatio(gasCost, cfg.GAS_SAFETY)
  return { maxFeePerGas, maxPriorityFeePerGas: tip, gasCost, safeGasCost, net: expectedProfit18 - safeGasCost }
}

/** Current base fee plus, when available, the recent median priority fee (an information metric only). */
export interface GasInfo {
  /** Base fee of the latest block header. */
  baseFee: bigint
  /** Number of the block the base fee was read from. */
  block: bigint
  /** Median (p50) priority fee over the last {@link FEE_HISTORY_BLOCKS} blocks, if `eth_feeHistory` answered. */
  p50Tip?: bigint
}

/** Blocks sampled by {@link readGasInfo} for the reward percentile. */
export const FEE_HISTORY_BLOCKS = 10

/** Base fee of the latest block, from its header. Throws if the node reports no base fee (pre-1559). */
export async function readBaseFee(clients: Pick<RpcClients, 'http'>): Promise<{ baseFee: bigint; block: bigint }> {
  const block = await withRetry(() => clients.http.getBlock({ blockTag: 'latest', includeTransactions: false }), {
    label: 'eth_getBlockByNumber(latest)',
  })
  if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
    throw new Error(`readBaseFee: block ${block.number} has no baseFeePerGas`)
  }
  return { baseFee: block.baseFeePerGas, block: block.number }
}

/** What {@link readNextBaseFee} learned from a block header. */
export interface NextBaseFee {
  /** Base fee the *next* block will charge (what a transaction sent now pays). */
  nextBaseFee: bigint
  /** Base fee of the header itself. */
  baseFee: bigint
  /** Number of the header read. */
  block: bigint
  /** `extraData` when the header carried the 8-byte announcement, `fallback` for the +12.5% estimate. */
  source: 'extraData' | 'fallback'
}

/** Attempts made when the node has not served `block` yet (-32001 / -32014). */
const HEADER_NOT_READY_TRIES = 8
const HEADER_NOT_READY_WAIT_MS = 50

/**
 * Parse the next block's base fee out of a header. On Arc the proposer publishes it in
 * `extraData` as an 8-byte big-endian integer (verified on every block sampled); any other
 * `extraData` length means the announcement is absent and the EIP-1559 worst case
 * `baseFeePerGas * 1125 / 1000` is used instead.
 */
export function parseNextBaseFee(header: { number: bigint; baseFeePerGas: bigint | null | undefined; extraData: Hex | undefined }): NextBaseFee {
  const baseFee = header.baseFeePerGas
  if (baseFee === null || baseFee === undefined) throw new Error(`parseNextBaseFee: block ${header.number} has no baseFeePerGas`)
  const extra = header.extraData
  if (extra !== undefined && isHex(extra) && extra.length === 2 + 16) {
    return { nextBaseFee: hexToBigInt(extra), baseFee, block: header.number, source: 'extraData' }
  }
  return { nextBaseFee: (baseFee * 1125n) / 1000n, baseFee, block: header.number, source: 'fallback' }
}

/**
 * Read the header of `block` (or the latest when omitted) and derive the next block's base fee
 * with {@link parseNextBaseFee}. Retries briefly while the node answers "block not found" for a
 * block it will serve within milliseconds (heads arrive before every node has indexed them).
 */
export async function readNextBaseFee(clients: Pick<RpcClients, 'http'>, block?: bigint): Promise<NextBaseFee> {
  const label = block === undefined ? 'eth_getBlockByNumber(latest)' : `eth_getBlockByNumber(${block})`
  for (let attempt = 1; ; attempt++) {
    try {
      const header = await withRetry(
        () => (block === undefined ? clients.http.getBlock({ blockTag: 'latest', includeTransactions: false }) : clients.http.getBlock({ blockNumber: block, includeTransactions: false })),
        { label },
      )
      const parsed = parseNextBaseFee(header)
      if (parsed.source === 'fallback') log.debug({ block: header.number, extraData: header.extraData }, 'header extraData is not an 8-byte base fee, using +12.5% estimate')
      return parsed
    } catch (error) {
      if (attempt >= HEADER_NOT_READY_TRIES || !isBlockNotReady(error)) throw error
      await sleep(HEADER_NOT_READY_WAIT_MS)
    }
  }
}

/**
 * Median priority fee actually paid over the last `blockCount` blocks (p50 reward of
 * `eth_feeHistory`), or `undefined` when the node does not support the call or returns nothing.
 * `eth_maxPriorityFeePerGas` returns 0 on Arc, so this is the only live signal of the going rate.
 */
export async function readP50Tip(client: PublicClient, blockCount: number = FEE_HISTORY_BLOCKS): Promise<bigint | undefined> {
  try {
    const history = await client.getFeeHistory({ blockCount, blockTag: 'latest', rewardPercentiles: [50] })
    const rewards = (history.reward ?? []).map((r) => r[0]).filter((r): r is bigint => r !== undefined)
    return median(rewards)
  } catch {
    return undefined
  }
}

/** Base fee (required) and p50 tip (best effort) in one round of requests. */
export async function readGasInfo(clients: Pick<RpcClients, 'http'>): Promise<GasInfo> {
  const [{ baseFee, block }, p50Tip] = await Promise.all([readBaseFee(clients), readP50Tip(clients.http)])
  return p50Tip === undefined ? { baseFee, block } : { baseFee, block, p50Tip }
}

/** Median of a list of bigints (lower middle for even counts); `undefined` for an empty list. */
export function median(values: readonly bigint[]): bigint | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[(sorted.length - 1) >> 1]
}
