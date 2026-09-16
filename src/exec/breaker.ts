/**
 * Send-side safety valves, both pure and block-indexed so they are trivial to unit-test:
 *
 * - {@link CircuitBreaker}: after `MAX_CONSECUTIVE_REVERTS` consecutive failed sends (a mined
 *   transaction that reverted, or one that was lost / never mined) sending pauses for
 *   `BREAKER_PAUSE_BLOCKS` blocks. A successful send resets the count. Arc has no revert
 *   protection, so every failed send costs the base fee plus the full tip; a run of failures
 *   almost always means the model is off (a hook changed behaviour, a pool was migrated, the RPC
 *   is lagging) and continuing to bid only burns USDC.
 * - {@link GasBudget}: the gas actually paid (from receipts) is summed over a rolling window of
 *   `GAS_BUDGET_WINDOW_BLOCKS`; once the window's total reaches `GAS_BUDGET_USDC_WEI` the bot
 *   only dry-runs until enough old spending rolls out of the window.
 *
 * {@link SendGate} combines both and reports why sending is blocked, for the block loop's logs.
 */
import type { Config } from '../config.js'

/** Why {@link SendGate.check} refuses to send. */
export type SendBlockReason = { kind: 'breaker'; until: bigint } | { kind: 'gas-budget'; spent: bigint; budget: bigint; freesAt: bigint }

export class CircuitBreaker {
  private consecutive = 0
  private pausedUntil: bigint | undefined
  private trips = 0

  /**
   * @param maxConsecutive failures in a row that trip the breaker (>= 1)
   * @param pauseBlocks blocks sending stays paused after a trip (>= 1)
   */
  constructor(
    readonly maxConsecutive: number,
    readonly pauseBlocks: number,
  ) {
    if (!Number.isInteger(maxConsecutive) || maxConsecutive < 1) throw new RangeError(`CircuitBreaker: maxConsecutive must be >= 1, got ${maxConsecutive}`)
    if (!Number.isInteger(pauseBlocks) || pauseBlocks < 1) throw new RangeError(`CircuitBreaker: pauseBlocks must be >= 1, got ${pauseBlocks}`)
  }

  /** Failed sends since the last success. */
  get consecutiveFailures(): number {
    return this.consecutive
  }

  /** How often the breaker has tripped since start. */
  get tripCount(): number {
    return this.trips
  }

  /** First block at which sending resumes, while paused. */
  pausedUntilBlock(): bigint | undefined {
    return this.pausedUntil
  }

  /** True when sending is allowed at `block`. A pause that has elapsed is cleared here. */
  allows(block: bigint): boolean {
    if (this.pausedUntil === undefined) return true
    if (block < this.pausedUntil) return false
    this.pausedUntil = undefined
    return true
  }

  /** A transaction was mined successfully: the failure streak ends. */
  recordSuccess(): void {
    this.consecutive = 0
  }

  /**
   * A send failed (reverted on chain or never mined) at `block`. Trips the breaker when the
   * streak reaches `maxConsecutive`; returns true when this call tripped it.
   */
  recordFailure(block: bigint): boolean {
    this.consecutive++
    if (this.consecutive < this.maxConsecutive) return false
    this.consecutive = 0
    this.trips++
    this.pausedUntil = block + BigInt(this.pauseBlocks)
    return true
  }
}

/** Rolling sum of gas paid over the last `windowBlocks` blocks. */
export class GasBudget {
  private readonly entries: Array<{ block: bigint; cost: bigint }> = []

  /**
   * @param budget maximum total gas cost (USDC wei, 18 decimals) per window
   * @param windowBlocks window length in blocks (>= 1)
   */
  constructor(
    readonly budget: bigint,
    readonly windowBlocks: number,
  ) {
    if (budget < 0n) throw new RangeError(`GasBudget: budget must be >= 0, got ${budget}`)
    if (!Number.isInteger(windowBlocks) || windowBlocks < 1) throw new RangeError(`GasBudget: windowBlocks must be >= 1, got ${windowBlocks}`)
  }

  /** Record `cost` wei of gas paid by a transaction mined in `block`. */
  record(block: bigint, cost: bigint): void {
    if (cost <= 0n) return
    this.entries.push({ block, cost })
  }

  /** Total paid in the window `(block - windowBlocks, block]`; entries older than that are dropped. */
  spent(block: bigint): bigint {
    const oldest = block - BigInt(this.windowBlocks)
    while (this.entries.length > 0 && (this.entries[0] as { block: bigint }).block <= oldest) this.entries.shift()
    let total = 0n
    for (const e of this.entries) if (e.block <= block) total += e.cost
    return total
  }

  /** True while the window's total is below the budget at `block`. */
  allows(block: bigint): boolean {
    return this.spent(block) < this.budget
  }

  /**
   * The first block at which the total drops below the budget again, assuming no further
   * spending: the window must roll past enough of the oldest entries. `block` itself when
   * spending is already allowed.
   */
  freesAt(block: bigint): bigint {
    let total = this.spent(block)
    if (total < this.budget) return block
    for (const e of this.entries) {
      total -= e.cost
      if (total < this.budget) return e.block + BigInt(this.windowBlocks)
    }
    return block
  }
}

/** Breaker and budget together, configured from `Config`. */
export class SendGate {
  readonly breaker: CircuitBreaker
  readonly budget: GasBudget

  constructor(cfg: Pick<Config, 'MAX_CONSECUTIVE_REVERTS' | 'BREAKER_PAUSE_BLOCKS' | 'GAS_BUDGET_USDC_WEI' | 'GAS_BUDGET_WINDOW_BLOCKS'>) {
    this.breaker = new CircuitBreaker(cfg.MAX_CONSECUTIVE_REVERTS, cfg.BREAKER_PAUSE_BLOCKS)
    this.budget = new GasBudget(cfg.GAS_BUDGET_USDC_WEI, cfg.GAS_BUDGET_WINDOW_BLOCKS)
  }

  /** `undefined` when a transaction may be sent at `block`, otherwise the reason it may not. */
  check(block: bigint): SendBlockReason | undefined {
    if (!this.breaker.allows(block)) return { kind: 'breaker', until: this.breaker.pausedUntilBlock() as bigint }
    if (!this.budget.allows(block)) {
      return { kind: 'gas-budget', spent: this.budget.spent(block), budget: this.budget.budget, freesAt: this.budget.freesAt(block) }
    }
    return undefined
  }

  /** A receipt arrived: account the gas and update the failure streak. Returns true if the breaker tripped. */
  onReceipt(block: bigint, status: 'success' | 'reverted', feePaid: bigint): boolean {
    this.budget.record(block, feePaid)
    if (status === 'success') {
      this.breaker.recordSuccess()
      return false
    }
    return this.breaker.recordFailure(block)
  }

  /** A send was never mined (dropped or timed out) as of `block`. Returns true if the breaker tripped. */
  onLost(block: bigint): boolean {
    return this.breaker.recordFailure(block)
  }
}
