import { encodeFunctionData, hexToBigInt, type Address, type Hex } from 'viem'
import { v2PairAbi, v3PoolAbi } from '../abi/index.js'
import type { Config } from '../config.js'
import { ADDRESSES } from '../chains.js'
import { log } from '../logger.js'
import { extsload, limiter, type Limiter, type RetryOptions, type RpcClients } from '../rpc/client.js'
import { aggregate3, type Call3 } from '../rpc/multicall.js'
import { poolKind, type PoolInfo, type PoolState, type TickData } from '../types.js'
import {
  bitmapWordSlot,
  decodeSlot0,
  decodeTickWord,
  decodeUint128,
  liquiditySlot,
  slot0Slot,
  tickInfoSlot,
  ticksInWord,
  wordPosBounds,
  wordPosOfTick,
  wordTickSpan,
} from './slots.js'
import { decodeV2Reserves, deriveV2State } from './v2.js'
import { decodeV3BitmapWord, decodeV3Liquidity, decodeV3Slot0, decodeV3Tick } from './v3.js'

/** Options for {@link fetchPoolStates}. */
export interface FetchPoolStatesOptions {
  /**
   * Last known tick per pool. With a hint, the bitmap words around it are fetched together with
   * slot0 (2 round trips). Without one, the words can only be chosen after slot0 is known
   * (3 round trips).
   */
  tickHints?: ReadonlyMap<Hex, number>
  /** Concurrency limiter for the underlying `extsload` / Multicall3 batches. Default: a limiter of 4. */
  limit?: Limiter
  /** Retry policy of the underlying `extsload` / Multicall3 batches. Default: the slow `withRetry` defaults. */
  retry?: RetryOptions
}

/**
 * Fetch the full swap-relevant state of `pools` at `block`. Pools of every kind may be mixed; each
 * kind is fetched by its own backend concurrently and the result keeps the order of `pools`:
 *
 * - v4: `extsload` of `slot0`, `liquidity`, bitmap words and tick infos (see {@link fetchTickWindowStates}).
 * - v3-style: the same window algorithm over Multicall3 batches of `slot0()`, `liquidity()`,
 *   `tickBitmap(int16)` and `ticks(int24)`, decoded from the leading return words only, with
 *   `lpFee = info.fee`, `protocolFee = 0`, `tickSpacing = info.tickSpacing`.
 * - v2-style: one `getReserves()` per pair through Multicall3; price, tick and liquidity are derived.
 *
 * A v3/v2 pool whose read reverts (wrong interface, no code) is left out of the result with a
 * warning instead of failing the whole batch.
 */
export async function fetchPoolStates(
  clients: RpcClients,
  cfg: Config,
  pools: readonly PoolInfo[],
  block: bigint,
  opts: FetchPoolStatesOptions = {},
): Promise<Map<Hex, PoolState>> {
  const result = new Map<Hex, PoolState>()
  if (pools.length === 0) return result
  const limit = opts.limit ?? limiter(4)
  const v4: PoolInfo[] = []
  const v3: PoolInfo[] = []
  const v2: PoolInfo[] = []
  for (const p of pools) {
    const kind = poolKind(p)
    if (kind === 0) v4.push(p)
    else if (kind === 1) v3.push(p)
    else v2.push(p)
  }
  const [s4, s3, s2] = await Promise.all([
    v4.length > 0 ? fetchV4States(clients, cfg, v4, block, opts.tickHints, limit, opts.retry) : emptyStates(),
    v3.length > 0 ? fetchV3States(clients, cfg, v3, block, opts.tickHints, limit, opts.retry) : emptyStates(),
    v2.length > 0 ? fetchV2States(clients, v2, block, limit, opts.retry) : emptyStates(),
  ])
  for (const p of pools) {
    const s = s4.get(p.poolId) ?? s3.get(p.poolId) ?? s2.get(p.poolId)
    if (s) result.set(p.poolId, s)
  }
  return result
}

function emptyStates(): Promise<Map<Hex, PoolState>> {
  return Promise.resolve(new Map())
}

// ---------------------------------------------------------------------------------------------
// Concentrated-liquidity window algorithm shared by v4 and v3-style pools
// ---------------------------------------------------------------------------------------------

/** What round trip 1 produces per pool, before the bitmap words are complete. */
export interface HeadState {
  sqrtPriceX96: bigint
  tick: number
  protocolFee: number
  lpFee: number
  liquidity: bigint
  /** wordPos -> bitmap word (the hinted words, if any). */
  words: Map<number, bigint>
}

/** A request for one bitmap word or one tick of a pool. */
export interface WordRequest {
  info: PoolInfo
  wordPos: number
}
export interface TickRequest {
  info: PoolInfo
  tick: number
}

/**
 * Storage backend for {@link fetchTickWindowStates}. Every method issues one round trip for all
 * requests. A pool / word / tick that cannot be read is reported as `undefined` and its pool is
 * dropped from the result.
 */
export interface TickWindowBackend {
  fetchHeads(pools: readonly PoolInfo[], hintedWords: ReadonlyMap<Hex, readonly number[]>): Promise<Map<Hex, HeadState | undefined>>
  fetchWords(requests: readonly WordRequest[]): Promise<(bigint | undefined)[]>
  fetchTicks(requests: readonly TickRequest[]): Promise<(TickData | undefined)[]>
}

interface Partial1 extends HeadState {
  info: PoolInfo
}

/**
 * Round trip 1: `slot0`, `liquidity` and (for hinted pools) the bitmap words
 * `[wordPos(hint) - k, wordPos(hint) + k]`, `k = cfg.TICK_WORDS_EACH_SIDE`. Round trip 1b (only
 * for pools whose hint was missing or whose actual window is not fully covered): the missing
 * words. Round trip 2: tick data for every set bit in the fetched words. The result's
 * `tickWindow` is exactly the span of ticks whose bitmap word was read (`wordTickSpan` of the
 * lowest and highest word), so `ticks` is complete inside it and the simulator knows where its
 * knowledge ends; the pool's current tick always lies inside it.
 */
export async function fetchTickWindowStates(
  backend: TickWindowBackend,
  pools: readonly PoolInfo[],
  block: bigint,
  k: number,
  tickHints: ReadonlyMap<Hex, number> | undefined,
  label: string,
): Promise<Map<Hex, PoolState>> {
  const result = new Map<Hex, PoolState>()
  if (pools.length === 0) return result
  const dropped: Hex[] = []

  // Round trip 1 ---------------------------------------------------------------------------
  const hintedWords = new Map<Hex, number[]>()
  for (const p of pools) {
    const hint = tickHints?.get(p.poolId)
    if (hint === undefined) continue
    hintedWords.set(p.poolId, windowWords(wordPosOfTick(hint, p.tickSpacing), k, p.tickSpacing))
  }
  const heads = await backend.fetchHeads(pools, hintedWords)
  const partials: Partial1[] = []
  for (const p of pools) {
    const head = heads.get(p.poolId)
    if (head === undefined) {
      dropped.push(p.poolId)
      continue
    }
    partials.push({ info: p, ...head })
  }

  // Round trip 1b: words the hint did not cover ---------------------------------------------
  const failed = new Set<Hex>()
  const missing: Array<{ partial: Partial1; wordPos: number }> = []
  for (const partial of partials) {
    for (const w of activeWords(partial, k)) if (!partial.words.has(w)) missing.push({ partial, wordPos: w })
  }
  if (missing.length > 0) {
    const values = await backend.fetchWords(missing.map((m) => ({ info: m.partial.info, wordPos: m.wordPos })))
    if (values.length !== missing.length) throw new Error(`${label}: expected ${missing.length} bitmap words, got ${values.length}`)
    missing.forEach((m, i) => {
      const v = values[i]
      if (v === undefined) failed.add(m.partial.info.poolId)
      else m.partial.words.set(m.wordPos, v)
    })
  }

  // Round trip 2: tick infos for every set bit in the window ---------------------------------
  const tickReads: Array<{ partial: Partial1; tick: number }> = []
  for (const partial of partials) {
    if (failed.has(partial.info.poolId)) continue
    for (const w of activeWords(partial, k)) {
      for (const tick of ticksInWord(w, partial.words.get(w) ?? 0n, partial.info.tickSpacing)) tickReads.push({ partial, tick })
    }
  }
  const tickData = tickReads.length > 0 ? await backend.fetchTicks(tickReads.map((t) => ({ info: t.partial.info, tick: t.tick }))) : []
  if (tickData.length !== tickReads.length) throw new Error(`${label}: expected ${tickReads.length} ticks, got ${tickData.length}`)
  const ticksByPool = new Map<Hex, Map<number, TickData>>()
  tickReads.forEach((t, i) => {
    const data = tickData[i]
    if (data === undefined) {
      failed.add(t.partial.info.poolId)
      return
    }
    let m = ticksByPool.get(t.partial.info.poolId)
    if (!m) ticksByPool.set(t.partial.info.poolId, (m = new Map()))
    m.set(t.tick, data)
  })

  for (const partial of partials) {
    if (failed.has(partial.info.poolId)) {
      dropped.push(partial.info.poolId)
      continue
    }
    const active = activeWords(partial, k)
    const first = active[0]
    const last = active[active.length - 1]
    if (first === undefined || last === undefined) throw new Error(`${label}: empty window for ${partial.info.poolId}`)
    const ticks = ticksByPool.get(partial.info.poolId) ?? new Map<number, TickData>()
    result.set(partial.info.poolId, {
      poolId: partial.info.poolId,
      block: Number(block),
      sqrtPriceX96: partial.sqrtPriceX96,
      tick: partial.tick,
      lpFee: partial.lpFee,
      protocolFee: partial.protocolFee,
      liquidity: partial.liquidity,
      tickSpacing: partial.info.tickSpacing,
      ticks: sortTicks(ticks),
      tickWindow: {
        lower: wordTickSpan(first, partial.info.tickSpacing).lower,
        upper: wordTickSpan(last, partial.info.tickSpacing).upper,
      },
    })
  }
  if (dropped.length > 0) log.warn({ label, block, dropped }, 'fetchPoolStates: pools whose state could not be read were skipped')
  return result
}

/** Words `[center - k, center + k]` clipped to those that can hold ticks for this spacing, ascending. */
export function windowWords(center: number, k: number, tickSpacing: number): number[] {
  const bounds = wordPosBounds(tickSpacing)
  const words: number[] = []
  for (let w = center - k; w <= center + k; w++) if (w >= bounds.min && w <= bounds.max) words.push(w)
  return words
}

/** The words that form the window around the pool's *actual* tick (all present after round trip 1b). */
function activeWords(partial: Partial1, k: number): number[] {
  return windowWords(wordPosOfTick(partial.tick, partial.info.tickSpacing), k, partial.info.tickSpacing)
}

/** Rebuild a tick map in ascending tick order (Map iteration order is insertion order). */
export function sortTicks(ticks: Map<number, TickData>): Map<number, TickData> {
  return new Map([...ticks.entries()].sort((a, b) => a[0] - b[0]))
}

// ---------------------------------------------------------------------------------------------
// v4 backend: PoolManager extsload
// ---------------------------------------------------------------------------------------------

/** v4 pools via `extsload` (2-3 round trips as described in {@link fetchTickWindowStates}). */
export async function fetchV4States(
  clients: RpcClients,
  cfg: Config,
  pools: readonly PoolInfo[],
  block: bigint,
  tickHints: ReadonlyMap<Hex, number> | undefined,
  limit: Limiter,
  retry?: RetryOptions,
): Promise<Map<Hex, PoolState>> {
  const addresses = ADDRESSES[cfg.CHAIN_ID]
  if (!addresses) throw new Error(`fetchPoolStates: no addresses for chain ${cfg.CHAIN_ID}`)
  const poolManager = addresses.poolManager
  const read = (slots: Hex[]): Promise<Hex[]> => extsload(clients, poolManager, slots, block, { limit, ...(retry ? { retry } : {}) })
  const backend: TickWindowBackend = {
    async fetchHeads(ps, hintedWords) {
      const slots: Hex[] = []
      for (const p of ps) {
        slots.push(slot0Slot(p.poolId), liquiditySlot(p.poolId))
        for (const w of hintedWords.get(p.poolId) ?? []) slots.push(bitmapWordSlot(p.poolId, w))
      }
      const values = await read(slots)
      const out = new Map<Hex, HeadState | undefined>()
      let cursor = 0
      for (const p of ps) {
        const slot0 = decodeSlot0(at(values, cursor++))
        const liquidity = decodeUint128(at(values, cursor++))
        const words = new Map<number, bigint>()
        for (const w of hintedWords.get(p.poolId) ?? []) words.set(w, hexToBigInt(at(values, cursor++)))
        out.set(p.poolId, { ...slot0, liquidity, words })
      }
      return out
    },
    async fetchWords(reqs) {
      const values = await read(reqs.map((r) => bitmapWordSlot(r.info.poolId, r.wordPos)))
      return values.map((v) => hexToBigInt(v))
    },
    async fetchTicks(reqs) {
      const values = await read(reqs.map((r) => tickInfoSlot(r.info.poolId, r.tick)))
      return values.map((v) => decodeTickWord(v))
    },
  }
  return fetchTickWindowStates(backend, pools, block, cfg.TICK_WORDS_EACH_SIDE, tickHints, 'v4')
}

// ---------------------------------------------------------------------------------------------
// v3-style backend: Multicall3 over the pool contracts
// ---------------------------------------------------------------------------------------------

const SLOT0_CALL = encodeFunctionData({ abi: v3PoolAbi, functionName: 'slot0' })
const LIQUIDITY_CALL = encodeFunctionData({ abi: v3PoolAbi, functionName: 'liquidity' })
const GET_RESERVES_CALL = encodeFunctionData({ abi: v2PairAbi, functionName: 'getReserves' })

/** Calldata for `tickBitmap(int16)`. */
export function tickBitmapCall(wordPos: number): Hex {
  return encodeFunctionData({ abi: v3PoolAbi, functionName: 'tickBitmap', args: [wordPos] })
}

/** Calldata for `ticks(int24)`. */
export function ticksCall(tick: number): Hex {
  return encodeFunctionData({ abi: v3PoolAbi, functionName: 'ticks', args: [tick] })
}

/** The contract address of a v3/v2 pool; throws for a malformed info (v4 pools have none). */
export function poolAddressOf(info: PoolInfo): Address {
  if (!info.pool) throw new Error(`pool ${info.poolId} (kind ${poolKind(info)}) has no contract address`)
  return info.pool
}

/** v3-style pools via Multicall3 (2-3 round trips as described in {@link fetchTickWindowStates}). */
export async function fetchV3States(
  clients: RpcClients,
  cfg: Config,
  pools: readonly PoolInfo[],
  block: bigint,
  tickHints: ReadonlyMap<Hex, number> | undefined,
  limit: Limiter,
  retry?: RetryOptions,
): Promise<Map<Hex, PoolState>> {
  const call = (calls: Call3[]) => aggregate3(clients, calls, block, { limit, ...(retry ? { retry } : {}) })
  const backend: TickWindowBackend = {
    async fetchHeads(ps, hintedWords) {
      const calls: Call3[] = []
      for (const p of ps) {
        const target = poolAddressOf(p)
        calls.push({ target, callData: SLOT0_CALL }, { target, callData: LIQUIDITY_CALL })
        for (const w of hintedWords.get(p.poolId) ?? []) calls.push({ target, callData: tickBitmapCall(w) })
      }
      const results = await call(calls)
      const out = new Map<Hex, HeadState | undefined>()
      let cursor = 0
      for (const p of ps) {
        const hinted = hintedWords.get(p.poolId) ?? []
        const slot0 = tryDecode(results[cursor++], decodeV3Slot0)
        const liquidity = tryDecode(results[cursor++], decodeV3Liquidity)
        const words = new Map<number, bigint>()
        let ok = slot0 !== undefined && liquidity !== undefined
        for (const w of hinted) {
          const v = tryDecode(results[cursor++], decodeV3BitmapWord)
          if (v === undefined) ok = false
          else words.set(w, v)
        }
        out.set(
          p.poolId,
          ok && slot0 && liquidity !== undefined
            ? { sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, protocolFee: 0, lpFee: p.fee, liquidity, words }
            : undefined,
        )
      }
      return out
    },
    async fetchWords(reqs) {
      const results = await call(reqs.map((r) => ({ target: poolAddressOf(r.info), callData: tickBitmapCall(r.wordPos) })))
      return results.map((r) => tryDecode(r, decodeV3BitmapWord))
    },
    async fetchTicks(reqs) {
      const results = await call(reqs.map((r) => ({ target: poolAddressOf(r.info), callData: ticksCall(r.tick) })))
      return results.map((r) => tryDecode(r, decodeV3Tick))
    },
  }
  return fetchTickWindowStates(backend, pools, block, cfg.TICK_WORDS_EACH_SIDE, tickHints, 'v3')
}

// ---------------------------------------------------------------------------------------------
// v2-style pairs: getReserves through Multicall3
// ---------------------------------------------------------------------------------------------

/** v2-style pairs: one `getReserves()` per pair, batched through Multicall3; state derived from reserves. */
export async function fetchV2States(
  clients: RpcClients,
  pools: readonly PoolInfo[],
  block: bigint,
  limit: Limiter,
  retry?: RetryOptions,
): Promise<Map<Hex, PoolState>> {
  const result = new Map<Hex, PoolState>()
  if (pools.length === 0) return result
  const results = await aggregate3(
    clients,
    pools.map((p) => ({ target: poolAddressOf(p), callData: GET_RESERVES_CALL })),
    block,
    { limit, ...(retry ? { retry } : {}) },
  )
  const dropped: Hex[] = []
  pools.forEach((p, i) => {
    const reserves = tryDecode(results[i], decodeV2Reserves)
    if (reserves === undefined) {
      dropped.push(p.poolId)
      return
    }
    result.set(p.poolId, deriveV2State(p, Number(block), reserves))
  })
  if (dropped.length > 0) log.warn({ label: 'v2', block, dropped }, 'fetchPoolStates: pairs whose reserves could not be read were skipped')
  return result
}

/** Decode a successful Multicall3 sub-result; `undefined` when it failed or does not decode. */
function tryDecode<T>(r: { success: boolean; returnData: Hex } | undefined, decode: (data: Hex) => T): T | undefined {
  if (!r || !r.success) return undefined
  try {
    return decode(r.returnData)
  } catch {
    return undefined
  }
}

function at(values: readonly Hex[], i: number): Hex {
  const v = values[i]
  if (v === undefined) throw new Error(`fetchPoolStates: missing extsload value at index ${i}`)
  return v
}
