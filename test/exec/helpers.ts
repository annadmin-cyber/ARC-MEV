/**
 * Fixtures for the exec tests: a native/token pair with two pools (fee 0.3 % and 1 %), realistic
 * states around a 1:1 price, and the 2-hop cycle between them.
 */
import type { Address, Hex } from 'viem'
import { loadConfig, type Config } from '../../src/config.js'
import { addressToPoolId, NATIVE, type Cycle, type PoolInfo, type PoolState } from '../../src/types.js'

export const TOKEN_B: Address = '0xc8c256e41c6cc5fcbf6a8e3b1b53f5778f033e22'
export const HOOK: Address = '0x00000000000000000000000000000000000000c0'

export const P1: PoolInfo = {
  poolId: '0x00000000000000000000000000000000000000000000000000000000000000a1',
  currency0: NATIVE,
  currency1: TOKEN_B,
  fee: 3000,
  tickSpacing: 60,
  hooks: NATIVE,
  block: 100,
}

export const P2: PoolInfo = {
  poolId: '0x00000000000000000000000000000000000000000000000000000000000000a2',
  currency0: NATIVE,
  currency1: TOKEN_B,
  fee: 10000,
  tickSpacing: 200,
  hooks: HOOK,
  block: 101,
}

export const Q96 = 1n << 96n

export function state(info: PoolInfo, sqrtPriceX96: bigint, liquidity = 10n ** 24n): PoolState {
  return {
    poolId: info.poolId,
    block: 200,
    sqrtPriceX96,
    tick: 0,
    lpFee: info.fee,
    protocolFee: 0,
    liquidity,
    tickSpacing: info.tickSpacing,
    ticks: new Map(),
    tickWindow: { lower: -887272, upper: 887272 },
  }
}

export const INFOS = new Map<Hex, PoolInfo>([
  [P1.poolId, P1],
  [P2.poolId, P2],
])

/** P1 prices token B slightly cheaper than P2, so native -> B (P1) -> native (P2) gains. */
export const STATES = new Map<Hex, PoolState>([
  [P1.poolId, state(P1, Q96 + Q96 / 50n)],
  [P2.poolId, state(P2, Q96 - Q96 / 50n)],
])

/** native -[P1 zeroForOne]-> B -[P2 oneForZero]-> native */
export const CYCLE: Cycle = {
  id: `2:${P1.poolId}:1|${P2.poolId}:0`,
  start: NATIVE,
  hops: [
    { poolId: P1.poolId, zeroForOne: true },
    { poolId: P2.poolId, zeroForOne: false },
  ],
}

// ---- mixed-kind fixture: a v4 pool, a v3-style pool and a v2-style pair closing a 3-hop cycle ----

export const TOKEN_C: Address = '0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1'
/** Real Arc addresses (cirBTC/USDC 0.01% v3 pool, USDC/'USDT' v2 pair) reused as fixture contract addresses. */
export const V3_POOL: Address = '0x82916bee18fcef517b26c72d7cb5f13694e1db41'
export const V2_PAIR: Address = '0x5dbf58814d0736fa09b6ad7f290800b805dd383d'

/** v3-style pool on (B, C), fee 0.05 %, spacing 10. */
export const P3: PoolInfo = {
  poolId: addressToPoolId(V3_POOL),
  currency0: TOKEN_B,
  currency1: TOKEN_C,
  fee: 500,
  tickSpacing: 10,
  hooks: NATIVE,
  block: 102,
  kind: 1,
  pool: V3_POOL,
  venue: 'uniswap-v3',
}

/** v2-style pair on (native, C), fee 0.30 %. */
export const P4: PoolInfo = {
  poolId: addressToPoolId(V2_PAIR),
  currency0: NATIVE,
  currency1: TOKEN_C,
  fee: 3000,
  tickSpacing: 0,
  hooks: NATIVE,
  block: 103,
  kind: 2,
  pool: V2_PAIR,
  venue: 'uniswap-v2',
}

export const V2_RESERVES = { reserve0: 1_000_000n * 10n ** 18n, reserve1: 2_000_000n * 10n ** 18n }
/** `isqrt(reserve1 * 2^192 / reserve0)` for {@link V2_RESERVES}: the v2 guard's `expected`. */
export const V2_SQRT_PRICE = 112045541949572279837463876454n

export const MIXED_INFOS = new Map<Hex, PoolInfo>([
  [P1.poolId, P1],
  [P2.poolId, P2],
  [P3.poolId, P3],
  [P4.poolId, P4],
])

/** P3 (v3) prices C at 4 B per C; P4 (v2) holds 1M native / 2M C. */
export const MIXED_STATES = new Map<Hex, PoolState>([
  [P1.poolId, state(P1, Q96 + Q96 / 50n)],
  [P2.poolId, state(P2, Q96 - Q96 / 50n)],
  [P3.poolId, { ...state(P3, 2n * Q96), tickSpacing: 10 }],
  [
    P4.poolId,
    {
      ...state(P4, 0n, 0n),
      tickSpacing: 0,
      sqrtPriceX96: V2_SQRT_PRICE, // isqrt(2 * 2^192)
      tick: 6931,
      liquidity: 1_414_213_562_373_095_048_801_688n,
      reserves: { ...V2_RESERVES },
    },
  ],
])

/** native -[P1 v4 zeroForOne]-> B -[P3 v3 zeroForOne]-> C -[P4 v2 oneForZero]-> native */
export const MIXED_CYCLE: Cycle = {
  id: `3:${P1.poolId}:1|${P3.poolId}:1|${P4.poolId}:0`,
  start: NATIVE,
  hops: [
    { poolId: P1.poolId, zeroForOne: true },
    { poolId: P3.poolId, zeroForOne: true },
    { poolId: P4.poolId, zeroForOne: false },
  ],
}

/** Well-known test key (Foundry / Hardhat account #0). */
export const TEST_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const TEST_ADDRESS: Address = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
export const EXECUTOR: Address = '0x1234567890abcdef1234567890abcdef12345678'

/** Config with defaults plus any overrides (no `.env` influence for the fields that matter). */
export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: '/nonexistent', LOG_LEVEL: 'warn', ...env })
}

/** A JSON-RPC block header (as `eth_getBlockByNumber` returns it) with the given number and extraData. */
export function rpcHeader(number: bigint, extraData: Hex, baseFeePerGas = 121_598_711_914n): Record<string, unknown> {
  return {
    number: `0x${number.toString(16)}`,
    hash: `0x${'11'.repeat(32)}`,
    parentHash: `0x${'22'.repeat(32)}`,
    baseFeePerGas: `0x${baseFeePerGas.toString(16)}`,
    extraData,
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    timestamp: '0x1',
    miner: '0x0000000000000000000000000000000000000000',
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    logsBloom: `0x${'00'.repeat(256)}`,
    sha3Uncles: `0x${'33'.repeat(32)}`,
    stateRoot: `0x${'44'.repeat(32)}`,
    transactionsRoot: `0x${'55'.repeat(32)}`,
    receiptsRoot: `0x${'66'.repeat(32)}`,
    size: '0x100',
    transactions: [],
    uncles: [],
  }
}
