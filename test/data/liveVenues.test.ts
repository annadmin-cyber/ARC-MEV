import { decodeFunctionResult, encodeFunctionData, type Address } from 'viem'
import { beforeAll, describe, expect, it } from 'vitest'
import { v3QuoterV2Abi } from '../../src/abi/index.js'
import { ADDRESSES } from '../../src/chains.js'
import { loadConfig, type Config } from '../../src/config.js'
import { simulateHop } from '../../src/math/hop.js'
import { isqrt, v2SqrtPriceX96 } from '../../src/math/v2.js'
import { makeClients, type RpcClients } from '../../src/rpc/client.js'
import { safeHead } from '../../src/rpc/logs.js'
import { StateCache } from '../../src/state/cache.js'
import { fetchPoolStates } from '../../src/state/reader.js'
import { addressToPoolId, NATIVE, type PoolInfo } from '../../src/types.js'

const rpcUrl = process.env['ARC_RPC_URL']
const A = ADDRESSES[5042]!

/** Uniswap v3 cirBTC/USDC 0.01% (the deepest pool on Arc), created at block 21,076,890. */
const V3_POOL: Address = '0x82916bee18fcef517b26c72d7cb5f13694e1db41'
const V3: PoolInfo = {
  poolId: addressToPoolId(V3_POOL),
  currency0: A.cirBtc!,
  currency1: A.usdc,
  fee: 100,
  tickSpacing: 1,
  hooks: NATIVE,
  block: 21_076_890,
  kind: 1,
  pool: V3_POOL,
  venue: 'uniswap-v3',
}
/** Uniswap v2 USDC/"USDT" pair (~$130k), created at block 21,082,910. */
const V2_PAIR: Address = '0x5dbf58814d0736fa09b6ad7f290800b805dd383d'
const V2: PoolInfo = {
  poolId: addressToPoolId(V2_PAIR),
  currency0: A.usdc,
  currency1: '0xb4337b8d148aa7a1f2124d9f6362234fff0fbbbb',
  fee: 3000,
  tickSpacing: 0,
  hooks: NATIVE,
  block: 21_082_910,
  kind: 2,
  pool: V2_PAIR,
  venue: 'uniswap-v2',
}

describe.skipIf(!rpcUrl)('live Arc mainnet: v3-style and v2-style venues', () => {
  let cfg: Config
  let clients: RpcClients
  let block: bigint
  beforeAll(async () => {
    cfg = loadConfig({ RPC_URL: rpcUrl, DATA_DIR: '/nonexistent', LOG_LEVEL: 'warn' })
    clients = makeClients(cfg)
    block = await safeHead(clients.http)
  })

  it('local v3 simulation of 1,000 USDC matches QuoterV2 exactly', async () => {
    const state = (await fetchPoolStates(clients, cfg, [V3], block)).get(V3.poolId)!
    expect(state.lpFee).toBe(100)
    expect(state.protocolFee).toBe(0)
    expect(state.liquidity > 0n).toBe(true)
    expect(state.tick >= state.tickWindow.lower && state.tick <= state.tickWindow.upper).toBe(true)
    for (const [zeroForOne, amountIn] of [
      [false, 1_000_000_000n],
      [true, 5_000_000n],
    ] as const) {
      const local = simulateHop(V3, state, zeroForOne, amountIn)
      const data = encodeFunctionData({
        abi: v3QuoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: zeroForOne ? V3.currency0 : V3.currency1, tokenOut: zeroForOne ? V3.currency1 : V3.currency0, amountIn, fee: V3.fee, sqrtPriceLimitX96: 0n }],
      })
      const { data: ret } = await clients.http.call({ to: A.v3QuoterV2!, data, blockNumber: block })
      const [amountOut, sqrtPriceX96After] = decodeFunctionResult({ abi: v3QuoterV2Abi, functionName: 'quoteExactInputSingle', data: ret! })
      console.log(`v3 ${zeroForOne ? 'cirBTC->USDC' : 'USDC->cirBTC'} ${amountIn}: local ${local.amountOut} quoter ${amountOut} (block ${block})`)
      expect(local.truncated).toBe(false)
      expect(local.amountOut).toBe(amountOut)
      expect(local.sqrtPriceX96After).toBe(sqrtPriceX96After)
    }
  }, 60_000)

  it('v2 pair reserves derive a sane price and liquidity', async () => {
    const state = (await fetchPoolStates(clients, cfg, [V2], block)).get(V2.poolId)!
    const { reserve0, reserve1 } = state.reserves!
    expect(reserve0 > 0n && reserve1 > 0n).toBe(true)
    expect(state.sqrtPriceX96).toBe(v2SqrtPriceX96({ reserve0, reserve1 }))
    expect(state.liquidity).toBe(isqrt(reserve0 * reserve1))
    // USDC has 6 decimals, the "USDT" 18: the price of one USDC-unit in USDT-units is ~1e12 if they trade near par.
    const price = (Number(state.sqrtPriceX96) / 2 ** 96) ** 2
    expect(price).toBeGreaterThan(1e10)
    expect(price).toBeLessThan(1e14 * 100)
    const out = simulateHop(V2, state, true, 1_000_000_000n)
    expect(out.amountOut > 0n && out.amountOut < reserve1).toBe(true)
    console.log(`v2 reserves ${reserve0} / ${reserve1}, price ${price.toExponential(4)}, 1,000 USDC -> ${out.amountOut}`)
  }, 60_000)

  it('StateCache applies a few blocks over mixed kinds', async () => {
    const cache = new StateCache(clients, cfg, [V3, V2])
    const start = block - 3n
    await cache.init(start)
    expect(cache.all().size).toBe(2)
    for (let b = start + 1n; b <= block; b++) {
      const r = await cache.applyBlock(b)
      expect(r.block).toBe(b)
    }
    expect(cache.block).toBe(block)
  }, 120_000)
})
