/**
 * Transaction sending for Arc: local nonce management (the node refuses the `pending` tag, so
 * the nonce is `eth_getTransactionCount(latest)` plus a local counter), EIP-1559 signing with the
 * bot's hot key, fan-out of the signed transaction to every configured RPC endpoint, one
 * in-flight transaction at a time, and receipt logging with the realised profit decoded from
 * the executor's `Executed` event.
 *
 * All RPC traffic goes through a {@link SendTransport} so tests can drive the sender with a fake.
 */
import { HTTP_FETCH_OPTIONS } from '../rpc/client.js'
import {
  createPublicClient,
  formatTransactionReceipt,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type RpcTransactionReceipt,
  type TransactionReceipt,
} from 'viem'
import { executorAbi } from '../abi/index.js'
import type { Config } from '../config.js'
import { log } from '../logger.js'
import { sleep, withRetry, type RpcClients } from '../rpc/client.js'
import { errorMessage } from './simulate.js'

/** Minimal JSON-RPC surface the sender needs, addressed by endpoint URL. */
export interface SendTransport {
  request(url: string, method: string, params: unknown[]): Promise<unknown>
}

/** Timeout for one `eth_sendRawTransaction` (a slow endpoint must not delay the others). */
const SEND_TIMEOUT_MS = 5_000

/**
 * Default transport: one dedicated viem HTTP client per URL, the primary one included (created
 * lazily, no JSON-RPC batching and a short timeout so a send is never glued to other requests
 * nor held up by the shared client's 20 s timeout).
 */
export function httpSendTransport(): SendTransport {
  const perUrl = new Map<string, PublicClient>()
  const clientFor = (url: string): PublicClient => {
    let client = perUrl.get(url)
    if (!client) {
      client = createPublicClient({ transport: http(url, { batch: false, retryCount: 0, timeout: SEND_TIMEOUT_MS, fetchOptions: HTTP_FETCH_OPTIONS }) })
      perUrl.set(url, client)
    }
    return client
  }
  return {
    request: (url, method, params) =>
      clientFor(url).request({ method, params } as Parameters<PublicClient['request']>[0]) as Promise<unknown>,
  }
}

/** A transaction ready to be signed: everything except chain id, nonce and signature. */
export interface PreparedTx {
  to: Address
  data: Hex
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  value?: bigint
}

/** Result of every endpoint's `eth_sendRawTransaction` once all have answered. */
export interface FanoutOutcome {
  accepted: string[]
  rejected: Array<{ url: string; reason: string }>
}

/** What {@link Sender.send} resolves with as soon as the first endpoint accepts. */
export interface SendResult {
  hash: Hex
  nonce: number
  /** Endpoints that had accepted the transaction when the promise resolved (at least one). */
  sentTo: string[]
  /** Settles when every endpoint has answered (for logging / tests). Never rejects. */
  fanout: Promise<FanoutOutcome>
}

/** The transaction currently awaiting inclusion. */
export interface InFlight {
  hash: Hex
  nonce: number
  sentAtBlock: bigint
}

/** Digest of a mined transaction. */
export interface ReceiptSummary {
  hash: Hex
  status: 'success' | 'reverted'
  blockNumber: bigint
  gasUsed: bigint
  effectiveGasPrice: bigint
  /** `gasUsed * effectiveGasPrice` in native wei. */
  feePaid: bigint
  /** Decoded `Executed` event of the executor, when present (successful arbitrage). */
  executed?: { currency: Address; amountIn: bigint; profit: bigint; steps: bigint }
}

/** Thrown by {@link Sender.send} while a previous transaction is still in flight. */
export class SenderBusyError extends Error {
  constructor(readonly inFlight: InFlight) {
    super(`transaction ${inFlight.hash} (nonce ${inFlight.nonce}) sent at block ${inFlight.sentAtBlock} is still in flight`)
    this.name = 'SenderBusyError'
  }
}

/** Thrown by {@link Sender.send} when every endpoint rejected the transaction. */
export class SendRejectedError extends Error {
  constructor(readonly outcome: FanoutOutcome) {
    super(`all ${outcome.rejected.length} endpoints rejected the transaction: ${outcome.rejected.map((r) => `${r.url}: ${r.reason}`).join('; ')}`)
    this.name = 'SendRejectedError'
  }
}

/** Tunables for {@link Sender}. */
export interface SenderOptions {
  transport?: SendTransport
  /** Blocks after which an unconfirmed transaction is no longer considered in flight. Default 3. */
  maxInFlightBlocks?: number
  /** Interval between `eth_getTransactionReceipt` polls in ms. Default 250. */
  receiptPollMs?: number
  /** How long {@link Sender.waitForReceipt} polls before reporting "unknown" (ms). Default 5000. */
  receiptTimeoutMs?: number
  /** Upper bound on {@link Sender.trackReceipt}'s background polling after that (ms). Default 60000. */
  receiptTrackMs?: number
}

/** What became of a sent transaction once {@link Sender.trackReceipt} is done with it. */
export type TrackedOutcome =
  | { kind: 'mined'; summary: ReceiptSummary }
  /** The account nonce moved past the transaction without a receipt: it can never be mined. */
  | { kind: 'lost'; reason: 'nonce-advanced' }
  /** Still no receipt and the nonce still not consumed when the tracking bound was hit. */
  | { kind: 'lost'; reason: 'timeout' }

export class Sender {
  readonly address: Address
  private readonly transport: SendTransport
  private readonly urls: string[]
  private readonly maxInFlightBlocks: number
  private readonly receiptPollMs: number
  private readonly receiptTimeoutMs: number
  private readonly receiptTrackMs: number
  private nonceValue: number | undefined
  private inFlightTx: InFlight | undefined

  constructor(
    clients: Pick<RpcClients, 'http' | 'sendUrls'>,
    private readonly cfg: Pick<Config, 'CHAIN_ID' | 'RPC_URL' | 'EXECUTOR_ADDRESS'>,
    private readonly account: LocalAccount,
    opts: SenderOptions = {},
  ) {
    this.address = account.address.toLowerCase() as Address
    this.transport = opts.transport ?? httpSendTransport()
    this.urls = clients.sendUrls.length > 0 ? [...clients.sendUrls] : [cfg.RPC_URL]
    this.maxInFlightBlocks = opts.maxInFlightBlocks ?? 3
    this.receiptPollMs = opts.receiptPollMs ?? 250
    this.receiptTimeoutMs = opts.receiptTimeoutMs ?? 5_000
    this.receiptTrackMs = opts.receiptTrackMs ?? 60_000
  }

  /** The next nonce to use, or `undefined` when it must be fetched from the node first. */
  get nonce(): number | undefined {
    return this.nonceValue
  }

  get inFlight(): InFlight | undefined {
    return this.inFlightTx
  }

  /** Primary endpoint (first send URL), used for reads. */
  get primaryUrl(): string {
    return this.urls[0] ?? this.cfg.RPC_URL
  }

  /** Re-read the account's nonce from the node (`latest`) and use it from now on. */
  async resyncNonce(): Promise<number> {
    const raw = await withRetry(
      () => this.transport.request(this.primaryUrl, 'eth_getTransactionCount', [this.address, 'latest']),
      { label: 'eth_getTransactionCount' },
    )
    const nonce = Number(BigInt(raw as string))
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error(`invalid nonce from node: ${String(raw)}`)
    this.nonceValue = nonce
    log.debug({ address: this.address, nonce }, 'nonce resynced')
    return nonce
  }

  /** True when no transaction is in flight, or the in-flight one has gone unconfirmed for `maxInFlightBlocks`. */
  canSend(currentBlock: bigint): boolean {
    return this.inFlightTx === undefined || this.expired(this.inFlightTx, currentBlock)
  }

  private expired(tx: InFlight, currentBlock: bigint): boolean {
    return currentBlock - tx.sentAtBlock >= BigInt(this.maxInFlightBlocks)
  }

  /**
   * Sign `tx` with the next nonce and broadcast it to every endpoint in parallel. Resolves as
   * soon as one endpoint accepts; the others are logged as they answer. Throws
   * {@link SenderBusyError} while a previous transaction is in flight, and
   * {@link SendRejectedError} (after scheduling a nonce resync) when every endpoint rejects.
   */
  async send(tx: PreparedTx, currentBlock: bigint): Promise<SendResult> {
    if (this.inFlightTx !== undefined) {
      if (!this.expired(this.inFlightTx, currentBlock)) throw new SenderBusyError(this.inFlightTx)
      log.warn({ ...this.inFlightTx, currentBlock }, 'in-flight transaction unconfirmed for too long, dropping it')
      this.inFlightTx = undefined
      this.nonceValue = undefined
    }
    const nonce = this.nonceValue ?? (await this.resyncNonce())
    const raw = await this.sign(tx, nonce)
    const hash = keccak256(raw)
    const { first, fanout } = this.broadcast(raw, hash)
    let sentTo: string[]
    try {
      sentTo = await first
    } catch (error) {
      this.nonceValue = undefined
      throw error
    }
    this.nonceValue = nonce + 1
    this.inFlightTx = { hash, nonce, sentAtBlock: currentBlock }
    log.info({ hash, nonce, sentTo, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, tip: tx.maxPriorityFeePerGas }, 'transaction sent')
    return { hash, nonce, sentTo, fanout }
  }

  private sign(tx: PreparedTx, nonce: number): Promise<Hex> {
    return this.account.signTransaction({
      type: 'eip1559',
      chainId: this.cfg.CHAIN_ID,
      nonce,
      to: tx.to,
      data: tx.data,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      value: tx.value ?? 0n,
    })
  }

  /**
   * Fire `eth_sendRawTransaction` at every endpoint. `first` resolves with the endpoints that
   * accepted so far as soon as one does, or rejects with {@link SendRejectedError} when all have
   * refused; `fanout` settles when every endpoint has answered.
   */
  private broadcast(raw: Hex, hash: Hex): { first: Promise<string[]>; fanout: Promise<FanoutOutcome> } {
    const outcome: FanoutOutcome = { accepted: [], rejected: [] }
    let settle: { resolve: (urls: string[]) => void; reject: (e: Error) => void } | undefined
    const first = new Promise<string[]>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const attempts = this.urls.map(async (url) => {
      try {
        const returned = await this.transport.request(url, 'eth_sendRawTransaction', [raw])
        if (typeof returned === 'string' && returned.toLowerCase() !== hash) {
          log.warn({ url, returned, expected: hash }, 'endpoint returned a different tx hash')
        }
        outcome.accepted.push(url)
        log.debug({ url, hash }, 'endpoint accepted tx')
        settle?.resolve([...outcome.accepted])
        settle = undefined
      } catch (error) {
        const reason = errorMessage(error)
        outcome.rejected.push({ url, reason })
        log.debug({ url, hash, reason }, 'endpoint rejected tx')
        if (outcome.rejected.length === this.urls.length) {
          settle?.reject(new SendRejectedError(outcome))
          settle = undefined
        }
      }
    })
    const fanout = Promise.all(attempts).then(() => {
      if (outcome.rejected.length > 0 && outcome.accepted.length > 0) {
        log.warn({ hash, accepted: outcome.accepted, rejected: outcome.rejected }, 'some endpoints rejected the tx')
      }
      return outcome
    })
    return { first, fanout }
  }

  /**
   * Poll for the receipt of `hash` for up to `timeoutMs` (default `receiptTimeoutMs`). On a
   * receipt: log status, gas used, effective gas price, block and (if emitted) the executor's
   * `Executed` event, clear the in-flight marker for that hash and schedule a nonce resync.
   * Returns `undefined` on timeout: the outcome is *unknown* (still pending, an RPC hiccup, or
   * dropped), not a loss; {@link trackReceipt} settles that.
   */
  async waitForReceipt(hash: Hex, timeoutMs = this.receiptTimeoutMs): Promise<ReceiptSummary | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const receipt = await this.fetchReceipt(hash)
      if (receipt) return this.onReceipt(receipt)
      if (Date.now() >= deadline) {
        log.warn({ hash, timeoutMs }, 'no receipt before timeout (tx still pending or dropped)')
        return undefined
      }
      await sleep(this.receiptPollMs)
    }
  }

  /**
   * After {@link waitForReceipt} gave up: keep polling `tx` in the background until it is
   * settled. `mined` when a receipt shows up late (RPC errors and slow inclusion are not losses);
   * `lost` only when the transaction is truly gone: the account nonce on the node has advanced
   * past `tx.nonce` without a receipt for `tx.hash` (something else consumed the nonce, e.g. the
   * re-send after `maxInFlightBlocks`), or `receiptTrackMs` elapsed with the nonce still unused.
   */
  async trackReceipt(tx: Pick<InFlight, 'hash' | 'nonce'>): Promise<TrackedOutcome> {
    const deadline = Date.now() + this.receiptTrackMs
    for (;;) {
      const receipt = await this.fetchReceipt(tx.hash)
      if (receipt) return { kind: 'mined', summary: this.onReceipt(receipt) }
      const count = await this.fetchNonce()
      if (count !== undefined && count > tx.nonce) {
        // The nonce is consumed; if it was by this tx the receipt is just behind: look once more.
        const late = await this.fetchReceipt(tx.hash)
        if (late) return { kind: 'mined', summary: this.onReceipt(late) }
        log.warn({ hash: tx.hash, nonce: tx.nonce, nodeNonce: count }, 'transaction lost: its nonce was consumed by another transaction')
        this.forget(tx.hash)
        return { kind: 'lost', reason: 'nonce-advanced' }
      }
      if (Date.now() >= deadline) {
        log.warn({ hash: tx.hash, nonce: tx.nonce, nodeNonce: count, trackMs: this.receiptTrackMs }, 'transaction lost: no receipt and nonce unused after the tracking bound')
        this.forget(tx.hash)
        return { kind: 'lost', reason: 'timeout' }
      }
      await sleep(this.receiptPollMs)
    }
  }

  /** `eth_getTransactionCount(latest)` of the bot's account, `undefined` when the call fails. */
  private async fetchNonce(): Promise<number | undefined> {
    try {
      const raw = await this.transport.request(this.primaryUrl, 'eth_getTransactionCount', [this.address, 'latest'])
      const nonce = Number(BigInt(raw as string))
      return Number.isSafeInteger(nonce) && nonce >= 0 ? nonce : undefined
    } catch (error) {
      log.debug({ err: errorMessage(error) }, 'eth_getTransactionCount failed, will retry')
      return undefined
    }
  }

  /** Drop the in-flight marker for `hash` (a lost transaction) and resync the nonce before the next send. */
  private forget(hash: Hex): void {
    if (this.inFlightTx?.hash !== hash) return
    this.inFlightTx = undefined
    this.nonceValue = undefined
  }

  private async fetchReceipt(hash: Hex): Promise<TransactionReceipt | undefined> {
    try {
      const raw = (await this.transport.request(this.primaryUrl, 'eth_getTransactionReceipt', [hash])) as RpcTransactionReceipt | null
      return raw ? formatTransactionReceipt(raw) : undefined
    } catch (error) {
      log.debug({ hash, err: errorMessage(error) }, 'eth_getTransactionReceipt failed, will retry')
      return undefined
    }
  }

  private onReceipt(receipt: TransactionReceipt): ReceiptSummary {
    const summary: ReceiptSummary = {
      hash: receipt.transactionHash,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      feePaid: receipt.gasUsed * receipt.effectiveGasPrice,
    }
    const executed = this.decodeExecuted(receipt)
    if (executed) summary.executed = executed
    const sentAtBlock = this.inFlightTx?.hash === summary.hash ? this.inFlightTx.sentAtBlock : undefined
    if (sentAtBlock !== undefined) this.inFlightTx = undefined
    this.nonceValue = undefined
    const level = summary.status === 'success' ? 'info' : 'warn'
    log[level](
      { ...summary, sentAtBlock, inclusionBlocks: sentAtBlock === undefined ? undefined : summary.blockNumber - sentAtBlock },
      summary.status === 'success' ? 'transaction mined' : 'transaction reverted on chain',
    )
    return summary
  }

  /** The executor's `Executed` event from the receipt, if the executor emitted one. */
  private decodeExecuted(receipt: TransactionReceipt): ReceiptSummary['executed'] | undefined {
    const executor = this.cfg.EXECUTOR_ADDRESS?.toLowerCase()
    const logs = receipt.logs.filter((l) => executor === undefined || l.address.toLowerCase() === executor)
    const events = parseEventLogs({ abi: executorAbi, logs, eventName: 'Executed' })
    const event = events[0]
    if (!event) return undefined
    return {
      currency: event.args.currency.toLowerCase() as Address,
      amountIn: event.args.amountIn,
      profit: event.args.profit,
      steps: event.args.steps,
    }
  }
}
