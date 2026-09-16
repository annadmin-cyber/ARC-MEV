import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, keccak256, parseTransaction, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { executorAbi } from '../../src/abi/index.js'
import { Sender, SendRejectedError, SenderBusyError, type PreparedTx, type SendTransport } from '../../src/exec/sender.js'
import { NATIVE } from '../../src/types.js'
import { EXECUTOR, TEST_ADDRESS, TEST_KEY, testConfig } from './helpers.js'

const URLS = ['https://a.example', 'https://b.example', 'https://c.example']
const cfg = testConfig({ EXECUTOR_ADDRESS: EXECUTOR, PRIVATE_KEY: TEST_KEY, DRY_RUN: 'false' })
const account = privateKeyToAccount(TEST_KEY)
const clients = { http: {} as PublicClient, sendUrls: URLS }

const TX: PreparedTx = {
  to: EXECUTOR,
  data: '0x1f24a1b5',
  gas: 1_500_000n,
  maxFeePerGas: 200_000_000_000n,
  maxPriorityFeePerGas: 50_000_000_000n,
}

type Behaviour = (url: string, method: string, params: unknown[]) => Promise<unknown>

/** Records every request and answers according to `behaviour`. */
function fakeTransport(behaviour: Behaviour): SendTransport & { calls: Array<{ url: string; method: string; params: unknown[] }> } {
  const calls: Array<{ url: string; method: string; params: unknown[] }> = []
  return {
    calls,
    request: (url, method, params) => {
      calls.push({ url, method, params })
      return behaviour(url, method, params)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Default behaviour: nonce 5 from the node, every endpoint accepts a send. */
function acceptingAll(nonce = 5): Behaviour {
  return async (_url, method, params) => {
    if (method === 'eth_getTransactionCount') return `0x${nonce.toString(16)}`
    if (method === 'eth_sendRawTransaction') return keccak256(params[0] as Hex)
    throw new Error(`unexpected ${method}`)
  }
}

describe('Sender nonce management and signing', () => {
  it('fetches the nonce once, signs an EIP-1559 tx with it and increments locally', async () => {
    const transport = fakeTransport(acceptingAll(5))
    const sender = new Sender(clients, cfg, account, { transport })
    expect(sender.nonce).toBeUndefined()
    expect(sender.address).toBe(TEST_ADDRESS)

    const result = await sender.send(TX, 1000n)
    expect(result.nonce).toBe(5)
    expect(sender.nonce).toBe(6)
    expect(sender.inFlight).toEqual({ hash: result.hash, nonce: 5, sentAtBlock: 1000n })

    const countCalls = transport.calls.filter((c) => c.method === 'eth_getTransactionCount')
    expect(countCalls).toHaveLength(1)
    expect(countCalls[0]!.params).toEqual([TEST_ADDRESS, 'latest'])

    const sends = transport.calls.filter((c) => c.method === 'eth_sendRawTransaction')
    expect(sends.map((c) => c.url).sort()).toEqual([...URLS].sort())
    const raw = sends[0]!.params[0] as Hex
    expect(keccak256(raw)).toBe(result.hash)
    const parsed = parseTransaction(raw)
    expect(parsed.type).toBe('eip1559')
    expect(parsed.chainId).toBe(5042)
    expect(parsed.nonce).toBe(5)
    expect(parsed.to).toBe(EXECUTOR)
    expect(parsed.gas).toBe(TX.gas)
    expect(parsed.maxFeePerGas).toBe(TX.maxFeePerGas)
    expect(parsed.maxPriorityFeePerGas).toBe(TX.maxPriorityFeePerGas)
    expect(parsed.data).toBe(TX.data)
    expect(parsed.value ?? 0n).toBe(0n)

    const outcome = await result.fanout
    expect(outcome.accepted.sort()).toEqual([...URLS].sort())
    expect(outcome.rejected).toEqual([])
  })

  it('refuses a second send while one is in flight, and allows it after 3 blocks with a resync', async () => {
    const transport = fakeTransport(acceptingAll(5))
    const sender = new Sender(clients, cfg, account, { transport })
    await sender.send(TX, 1000n)
    expect(sender.canSend(1001n)).toBe(false)
    await expect(sender.send(TX, 1002n)).rejects.toBeInstanceOf(SenderBusyError)
    expect(sender.canSend(1003n)).toBe(true)

    // The node meanwhile reports the first tx was never mined: nonce still 5.
    const second = await sender.send(TX, 1003n)
    expect(second.nonce).toBe(5)
    expect(transport.calls.filter((c) => c.method === 'eth_getTransactionCount')).toHaveLength(2)
    expect(sender.inFlight?.sentAtBlock).toBe(1003n)
  })
})

describe('Sender fan-out', () => {
  it('resolves as soon as one endpoint accepts and reports the others as they answer', async () => {
    const transport = fakeTransport(async (url, method, params) => {
      if (method === 'eth_getTransactionCount') return '0x0'
      if (url === URLS[0]) {
        await sleep(60)
        return keccak256(params[0] as Hex)
      }
      if (url === URLS[1]) return keccak256(params[0] as Hex)
      throw new Error('nonce too low')
    })
    const sender = new Sender(clients, cfg, account, { transport })
    const started = Date.now()
    const result = await sender.send(TX, 1n)
    expect(Date.now() - started).toBeLessThan(50)
    expect(result.sentTo).toEqual([URLS[1]])
    const outcome = await result.fanout
    expect(outcome.accepted).toEqual([URLS[1], URLS[0]])
    expect(outcome.rejected).toEqual([{ url: URLS[2], reason: 'nonce too low' }])
    expect(sender.nonce).toBe(1)
  })

  it('throws SendRejectedError when every endpoint rejects and resyncs the nonce afterwards', async () => {
    let nodeNonce = 7
    const transport = fakeTransport(async (_url, method) => {
      if (method === 'eth_getTransactionCount') return `0x${nodeNonce.toString(16)}`
      throw new Error('replacement transaction underpriced')
    })
    const sender = new Sender(clients, cfg, account, { transport })
    const failure = await sender.send(TX, 1n).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(SendRejectedError)
    expect((failure as SendRejectedError).outcome.rejected).toHaveLength(3)
    expect(sender.nonce).toBeUndefined()
    expect(sender.inFlight).toBeUndefined()

    // Next send re-reads the nonce from the node instead of trusting the local counter.
    nodeNonce = 9
    transport.calls.length = 0
    const accepting = fakeTransport(acceptingAll(9))
    const sender2 = new Sender(clients, cfg, account, { transport: accepting })
    const ok = await sender2.send(TX, 2n)
    expect(ok.nonce).toBe(9)
    expect(accepting.calls.filter((c) => c.method === 'eth_getTransactionCount')).toHaveLength(1)
  })

  it('falls back to the primary RPC_URL when no send URLs are configured', async () => {
    const transport = fakeTransport(acceptingAll(0))
    const sender = new Sender({ http: {} as PublicClient, sendUrls: [] }, cfg, account, { transport })
    const result = await sender.send(TX, 1n)
    expect(result.sentTo).toEqual([cfg.RPC_URL])
  })
})

describe('Sender.waitForReceipt', () => {
  const currency = NATIVE
  const executedLog = {
    address: EXECUTOR,
    topics: encodeEventTopics({ abi: executorAbi, eventName: 'Executed', args: { currency } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [10n ** 18n, 123_456n, 2n]),
    blockNumber: '0x3e9',
    transactionHash: '0x' + '11'.repeat(32),
    transactionIndex: '0x0',
    blockHash: '0x' + '22'.repeat(32),
    logIndex: '0x0',
    removed: false,
  }

  function rawReceipt(hash: Hex, status: '0x1' | '0x0', logs: unknown[]) {
    return {
      transactionHash: hash,
      transactionIndex: '0x0',
      blockHash: '0x' + '22'.repeat(32),
      blockNumber: '0x3e9',
      from: TEST_ADDRESS,
      to: EXECUTOR,
      cumulativeGasUsed: '0x5208',
      gasUsed: '0x30d40',
      effectiveGasPrice: '0x2540be400',
      contractAddress: null,
      logs,
      logsBloom: '0x' + '00'.repeat(256),
      status,
      type: '0x2',
    }
  }

  it('polls until the receipt arrives, decodes Executed, clears the in-flight tx and schedules a resync', async () => {
    let polls = 0
    let sentHash: Hex | undefined
    const transport = fakeTransport(async (_url, method, params) => {
      if (method === 'eth_getTransactionCount') return '0x3'
      if (method === 'eth_sendRawTransaction') {
        sentHash = keccak256(params[0] as Hex)
        return sentHash
      }
      if (method === 'eth_getTransactionReceipt') {
        polls++
        return polls < 3 ? null : rawReceipt(sentHash!, '0x1', [executedLog])
      }
      throw new Error(`unexpected ${method}`)
    })
    const sender = new Sender(clients, cfg, account, { transport, receiptPollMs: 5 })
    const sent = await sender.send(TX, 1000n)
    const summary = await sender.waitForReceipt(sent.hash, 2_000)
    expect(polls).toBe(3)
    expect(summary).toEqual({
      hash: sent.hash,
      status: 'success',
      blockNumber: 1001n,
      gasUsed: 200_000n,
      effectiveGasPrice: 10_000_000_000n,
      feePaid: 200_000n * 10_000_000_000n,
      executed: { currency, amountIn: 10n ** 18n, profit: 123_456n, steps: 2n },
    })
    expect(sender.inFlight).toBeUndefined()
    expect(sender.nonce).toBeUndefined()
    expect(sender.canSend(1001n)).toBe(true)
  })

  it('reports a reverted receipt without an Executed event', async () => {
    let sentHash: Hex | undefined
    const transport = fakeTransport(async (_url, method, params) => {
      if (method === 'eth_getTransactionCount') return '0x3'
      if (method === 'eth_sendRawTransaction') return (sentHash = keccak256(params[0] as Hex))
      return rawReceipt(sentHash!, '0x0', [])
    })
    const sender = new Sender(clients, cfg, account, { transport, receiptPollMs: 5 })
    const sent = await sender.send(TX, 1n)
    const summary = await sender.waitForReceipt(sent.hash, 500)
    expect(summary?.status).toBe('reverted')
    expect(summary?.executed).toBeUndefined()
  })

  it('returns undefined after the timeout and keeps the tx in flight', async () => {
    const transport = fakeTransport(async (_url, method, params) => {
      if (method === 'eth_getTransactionCount') return '0x3'
      if (method === 'eth_sendRawTransaction') return keccak256(params[0] as Hex)
      return null
    })
    const sender = new Sender(clients, cfg, account, { transport, receiptPollMs: 5 })
    const sent = await sender.send(TX, 1n)
    const summary = await sender.waitForReceipt(sent.hash, 40)
    expect(summary).toBeUndefined()
    expect(sender.inFlight?.hash).toBe(sent.hash)
    expect(transport.calls.filter((c) => c.method === 'eth_getTransactionReceipt').length).toBeGreaterThan(1)
  })
})
