import type { Address, Hex } from 'viem'

/** Native currency sentinel used by Uniswap v4 (on Arc this is native USDC, 18 decimals). */
export const NATIVE: Address = '0x0000000000000000000000000000000000000000'

/** A Uniswap v4 pool as discovered from the PoolManager `Initialize` event. */
export interface PoolInfo {
  /** keccak256(abi.encode(PoolKey)) */
  poolId: Hex
  currency0: Address
  currency1: Address
  /** LP fee in hundredths of a bip (3000 = 0.30%). 0x800000 flag means dynamic fee. */
  fee: number
  tickSpacing: number
  hooks: Address
  /** Block in which the pool was initialised. */
  block: number
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
  /** Initialised ticks known around the current tick, sorted ascending. */
  ticks: Map<number, TickData>
  /** Lowest / highest tick for which `ticks` is complete. Beyond this window the simulator stops. */
  tickWindow: { lower: number; upper: number }
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
  key: {
    currency0: Address
    currency1: Address
    fee: number
    tickSpacing: number
    hooks: Address
  }
  zeroForOne: boolean
}

/** Local exact-input swap simulator signature (implemented in math/simulate.ts). */
export type Simulator = (state: PoolState, zeroForOne: boolean, amountIn: bigint) => SwapResult

/** Per-pool guard sent with a transaction: revert cheaply if the pool moved since simulation. */
export interface StateGuard {
  poolId: Hex
  expectedSqrtPriceX96: bigint
  /** Allowed deviation in basis points of sqrtPrice (0 = exact). */
  toleranceBps: number
}
