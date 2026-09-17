/**
 * The going rate for block position on Arc.
 *
 * Blocks are ordered by descending effective priority fee, so the tip of a block's first
 * transaction is what it cost to be first in that block, and the recent distribution of those
 * top tips is the only live signal of what the competing bots are paying. Measured on day two:
 * the bots that took 1-2 USDC arbitrages paid 3,000-13,000 gwei in the very block after the
 * opportunity appeared, while a fixed 30% share of the profit bid a few hundred to 1,000 gwei
 * and landed one block later, reverting on the stale-state guard at a cost of a few cents each.
 *
 * `TipMarket` keeps the top tip of the last N blocks and answers "what tip does it take right
 * now" as a quantile of them times a margin. Callers raise their bid to it while the profit
 * affords it and skip the send otherwise (see `feePolicy`).
 */
import type { Config } from '../config.js'

/** Effective priority fee a transaction pays at `baseFee` (what the block ordering sorts by). */
export function effectiveTip(
  tx: { maxPriorityFeePerGas?: bigint | null | undefined; maxFeePerGas?: bigint | null | undefined; gasPrice?: bigint | null | undefined },
  baseFee: bigint,
): bigint {
  const maxFee = tx.maxFeePerGas ?? tx.gasPrice
  if (maxFee === undefined || maxFee === null) return 0n
  const headroom = maxFee - baseFee
  if (headroom <= 0n) return 0n
  const priority = tx.maxPriorityFeePerGas
  if (priority === undefined || priority === null) return headroom // legacy: gasPrice - baseFee
  return priority < headroom ? priority : headroom
}

/** The `count` largest effective tips in a block, descending. */
export function topTips(
  transactions: readonly { maxPriorityFeePerGas?: bigint | null | undefined; maxFeePerGas?: bigint | null | undefined; gasPrice?: bigint | null | undefined }[],
  baseFee: bigint,
  count = 3,
): bigint[] {
  const tips = transactions.map((tx) => effectiveTip(tx, baseFee)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
  return tips.slice(0, count)
}

/** Value at `quantile` (0..1) of `values` (nearest-rank, lower on ties); `undefined` when empty. */
export function quantile(values: readonly bigint[], q: number): bigint | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const clamped = Math.min(1, Math.max(0, q))
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(clamped * sorted.length) - 1))
  return sorted[index]
}

/** What the market looks like right now, for logs and the monitor. */
export interface MarketSnapshot {
  /** Blocks currently in the window. */
  blocks: number
  /** Top tip quantiles over the window (wei); null while the window is empty. */
  p50: bigint | null
  p75: bigint | null
  p90: bigint | null
  /** Tip a send must at least bid (wei); null when the gate is off or the window is empty. */
  required: bigint | null
}

const RATIO_SCALE = 1_000_000n

/** Rolling window of the top tip of each of the last `MARKET_TIP_BLOCKS` blocks. */
export class TipMarket {
  private readonly window: bigint[] = []
  private lastBlock: bigint | undefined
  constructor(private readonly cfg: Pick<Config, 'MARKET_TIP_GATE' | 'MARKET_TIP_BLOCKS' | 'MARKET_TIP_QUANTILE' | 'MARKET_TIP_MARGIN'>) {}

  /** Record block `block`'s top tip (0 for an empty block). Out-of-order or repeated blocks are ignored. */
  record(block: bigint, top: bigint | undefined): void {
    if (this.lastBlock !== undefined && block <= this.lastBlock) return
    this.lastBlock = block
    this.window.push(top ?? 0n)
    while (this.window.length > this.cfg.MARKET_TIP_BLOCKS) this.window.shift()
  }

  /** The tip (wei) a send must bid to match the market, or `undefined` when the gate is off or nothing was recorded yet. */
  requiredTip(): bigint | undefined {
    if (!this.cfg.MARKET_TIP_GATE) return undefined
    const q = quantile(this.window, this.cfg.MARKET_TIP_QUANTILE)
    if (q === undefined) return undefined
    return (q * BigInt(Math.round(this.cfg.MARKET_TIP_MARGIN * Number(RATIO_SCALE)))) / RATIO_SCALE
  }

  snapshot(): MarketSnapshot {
    return {
      blocks: this.window.length,
      p50: quantile(this.window, 0.5) ?? null,
      p75: quantile(this.window, 0.75) ?? null,
      p90: quantile(this.window, 0.9) ?? null,
      required: this.requiredTip() ?? null,
    }
  }
}
