/**
 * Sequential block driver: block numbers arrive from `newHeads` or polling (possibly out of
 * order, possibly several while a block is being processed) and the handler runs for one block
 * at a time. When a backlog builds up, intermediate blocks are skipped and only the newest is
 * processed next; the state cache replays the logs of the skipped range itself.
 */
import { log } from '../logger.js'

export type BlockHandler = (block: bigint, skipped: bigint) => Promise<void>

export class BlockLoop {
  private newest: bigint | undefined
  private processed: bigint | undefined
  /** Set synchronously around `drain` so a notify arriving between two drains is never lost. */
  private running = false
  private current: Promise<void> | undefined
  private stopped = false

  constructor(private readonly handler: BlockHandler) {}

  /** Last block the handler finished with (successfully or not). */
  get lastProcessed(): bigint | undefined {
    return this.processed
  }

  /** Whether the loop still accepts new blocks. */
  get active(): boolean {
    return !this.stopped
  }

  /** Report a new head. Older-than-known numbers are ignored; processing starts if idle. */
  notify(block: bigint): void {
    if (this.stopped) return
    if (this.newest === undefined || block > this.newest) this.newest = block
    if (!this.running) {
      this.running = true
      this.current = this.drain()
    }
  }

  /** Stop accepting blocks and resolve once the block in progress (if any) has finished. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.current) await this.current
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped && this.newest !== undefined && (this.processed === undefined || this.newest > this.processed)) {
        const block = this.newest
        const skipped = this.processed === undefined ? 0n : block - this.processed - 1n
        try {
          await this.handler(block, skipped)
        } catch (error) {
          log.error({ err: error, block }, 'block processing failed; continuing with the next block')
        }
        this.processed = block
      }
    } finally {
      this.running = false
    }
  }
}
