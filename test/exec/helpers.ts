/**
 * Fixtures for the exec tests: a native/token pair with two pools (fee 0.3 % and 1 %), realistic
 * states around a 1:1 price, and the 2-hop cycle between them.
 */
import type { Address, Hex } from 'viem'
import { loadConfig, type Config } from '../../src/config.js'
import { NATIVE, type Cycle, type PoolInfo, type PoolState } from '../../src/types.js'

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

/** Well-known test key (Foundry / Hardhat account #0). */
export const TEST_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const TEST_ADDRESS: Address = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
export const EXECUTOR: Address = '0x1234567890abcdef1234567890abcdef12345678'

/** Config with defaults plus any overrides (no `.env` influence for the fields that matter). */
export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ DATA_DIR: '/nonexistent', LOG_LEVEL: 'warn', ...env })
}
