import type { Address, Hex } from 'viem'

/** Native currency sentinel used by Uniswap v4 (on Arc this is native USDC, 18 decimals). */
export const NATIVE: Address = '0x0000000000000000000000000000000000000000'

/** Pool kinds understood by the executor. 0 = Uniswap v4, 1 = v3-style pool, 2 = v2-style pair. */
export type PoolKind = 0 | 1 | 2

/**
 * A pool the bot can trade through.
 *
 * - v4 (`kind` 0 or undefined): discovered from the PoolManager `Initialize` event; `poolId` is
 *   keccak256(abi.encode(PoolKey)) and `pool` is absent.
 * - v3-style (`kind` 1): discovered from a factory `PoolCreated` event; `poolId` is the pool address
 *   left-padded to 32 bytes, `pool` is the pool address, `fee` its fee in pips, `tickSpacing` its spacing.
 * - v2-style (`kind` 2): discovered from a factory `PairCreated` event; `poolId` is the pair address
 *   left-padded to 32 bytes, `pool` is the pair address, `fee` the pair fee in pips, `tickSpacing` 0.
 * For every kind `currency0 < currency1` are the pool's token0/token1 and `hooks` is the zero address
 * unless the pool is a hooked v4 pool.
 */
export interface PoolInfo {
  poolId: Hex
  currency0: Address
  currency1: Address
  /** LP fee in hundredths of a bip (3000 = 0.30%). 0x800000 flag means dynamic fee (v4 only). */
  fee: number
  tickSpacing: number
  hooks: Address
  /** Block in which the pool was created. */
  block: number
  /** Pool kind; undefined means Uniswap v4. */
  kind?: PoolKind
  /** Pool/pair contract address for v3/v2-style pools. */
  pool?: Address
  /** Which factory (by name, see chains.ts VenueFactory) a v3/v2 pool came from. */
  venue?: string
}

/** Kind of a pool, treating a missing `kind` as Uniswap v4. */
export function poolKind(info: Pick<PoolInfo, 'kind'>): PoolKind {
  return info.kind ?? 0
}

/** Left-pads a pool/pair address to the 32-byte `poolId` form used for non-v4 pools. */
export function addressToPoolId(address: Address): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as Hex
}

/** Per-tick data needed to walk across initialised ticks. */
export interface TickData {
  /** Net liquidity change when crossing this tick left-to-right. */
  liquidityNet: bigint
  liquidityGross: bigint
}

/** Snapshot of the mutable state of a pool at one block. */
export interface PoolState {
  poolId: Hex
  block: number
  sqrtPriceX96: bigint
  tick: number
  /** Effective LP fee in hundredths of a bip (for dynamic-fee pools this is the current value). */
  lpFee: number
  /** Packed protocol fee (uint24) as stored in slot0. */
  protocolFee: number
  liquidity: bigint
  /** Pool tick spacing (copied from PoolInfo); bitmap word boundaries depend on it. */
  tickSpacing: number
  /** Initialised ticks known around the current tick, sorted ascending. */
  ticks: Map<number, TickData>
  /** Lowest / highest tick for which `ticks` is complete. Beyond this window the simulator stops. */
  tickWindow: { lower: number; upper: number }
  /** v2-style pairs only: current reserves. sqrtPriceX96/tick/liquidity are derived for ranking. */
  reserves?: { reserve0: bigint; reserve1: bigint }
}

/** A pool and its current state together. */
export interface TrackedPool {
  info: PoolInfo
  state: PoolState
}

/** Result of simulating an exact-input swap locally. */
export interface SwapResult {
  amountIn: bigint
  amountOut: bigint
  sqrtPriceX96After: bigint
  tickAfter: number
  liquidityAfter: bigint
  /** True if the simulator ran out of known ticks / liquidity before consuming the whole input. */
  truncated: boolean
  /** Fee paid to LPs in the input token. */
  feeAmount: bigint
}

/** One hop of a cycle: which pool and which direction. */
export interface Hop {
  poolId: Hex
  zeroForOne: boolean
}

/** A closed path of hops. `start` is the currency that goes in and comes out. */
export interface Cycle {
  id: string
  start: Address
  hops: Hop[]
}

/** A sized, evaluated arbitrage candidate. */
export interface Opportunity {
  cycle: Cycle
  amountIn: bigint
  amountOut: bigint
  /** amountOut - amountIn in units of `cycle.start`. */
  grossProfit: bigint
  /** Gross profit converted to USDC wei (18 decimals) using the price graph; undefined if not priceable. */
  grossProfitUsdc?: bigint
  block: number
}

/** The ABI-encoded shape of `ArcArbExecutor.Step`. */
export interface ExecutorStep {
  kind: PoolKind
  zeroForOne: boolean
  /** v3/v2 pool address; zero address for v4. */
  pool: Address
  /** For every kind currency0/currency1 are the pool's token0/token1. fee/tickSpacing/hooks are v4 fields;
   *  for v2 `fee` carries the pair fee in pips. */
  key: {
    currency0: Address
    currency1: Address
    fee: number
    tickSpacing: number
    hooks: Address
  }
}

/** Local exact-input swap simulator signature (implemented in math/simulate.ts). */
export type Simulator = (state: PoolState, zeroForOne: boolean, amountIn: bigint) => SwapResult

/** Per-pool guard sent with a transaction: revert cheaply if the pool moved since simulation.
 *  kind 0: poolId = v4 pool id, expected = sqrtPriceX96. kind 1: poolId = v3 pool address (left-padded),
 *  expected = slot0 sqrtPriceX96. kind 2: poolId = v2 pair address (left-padded), expected = reserve0. */
export interface StateGuard {
  kind: PoolKind
  poolId: Hex
  expected: bigint
  /** Allowed deviation in basis points (0 = exact). */
  toleranceBps: number
}
