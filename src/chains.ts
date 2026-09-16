import { defineChain, type Chain } from 'viem'

/**
 * Arc mainnet (Circle). Gas is native USDC with 18 decimals at the protocol level.
 * Verified 2026-09-16: eth_chainId -> 0x13b2 (5042) at https://rpc.mainnet.arc.io
 */
export const arc: Chain = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.arc.io'], webSocket: ['wss://rpc.mainnet.arc.io/ws'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
})

/** Arc testnet. Chain id 5042002. */
export const arcTestnet: Chain = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.io'], webSocket: ['wss://rpc.testnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arc Testnet Explorer', url: 'https://explorer.testnet.arc.io' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
  testnet: true,
})

export const CHAINS: Record<number, Chain> = {
  [arc.id]: arc,
  [arcTestnet.id]: arcTestnet,
}

/** A concentrated-liquidity (v3-style) or constant-product (v2-style) factory to index. */
export interface VenueFactory {
  name: string
  address: `0x${string}`
  /** Block the factory was deployed in (discovery starts here). */
  deployBlock: number
  /** Default swap fee in pips for v2-style pairs (ignored for v3-style, whose pools expose fee()). */
  feePips?: number
}

/** Well-known addresses per chain (lower-case). Mainnet entries verified by eth_getCode on 2026-09-16. */
export const ADDRESSES: Record<number, {
  poolManager: `0x${string}`
  /** Block the PoolManager was deployed in (discovery starts here). */
  poolManagerDeployBlock: number
  /** ERC-20 view of USDC (6 decimals). Same balance as the native 18-decimal currency. */
  usdc: `0x${string}`
  stateView?: `0x${string}`
  v4Quoter?: `0x${string}`
  universalRouter?: `0x${string}`
  /** Uniswap v3 QuoterV2 (for v3-style pools). */
  v3QuoterV2?: `0x${string}`
  /** Uniswap-v3-style factories (canonical `PoolCreated` event, pools with `slot0()`/`swap()`+callback). */
  v3Factories: VenueFactory[]
  /** Uniswap-v2-style factories (`PairCreated` event, pairs with `getReserves()`/`swap()`). */
  v2Factories: VenueFactory[]
  eurc?: `0x${string}`
  cirBtc?: `0x${string}`
}> = {
  [arc.id]: {
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    poolManagerDeployBlock: 1_948_056,
    usdc: '0x3600000000000000000000000000000000000000',
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
    universalRouter: '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1',
    v3QuoterV2: '0x7dfd4f31be6814d2906bde155c3e1b146eac1468',
    v3Factories: [
      // Official Uniswap v3 on Arc (16k pools; the deepest pool on Arc, cirBTC/USDC 0.01%, lives here).
      { name: 'uniswap-v3', address: '0xf0db7b58379503491d857db50ac9ece64c653918', deployBlock: 1_948_019 },
    ],
    v2Factories: [
      // Official Uniswap v2 on Arc (310 pairs, mostly dust).
      { name: 'uniswap-v2', address: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba', deployBlock: 1_948_019, feePips: 3000 },
      // DYORSwap v2 fork (48 pairs, a few memecoins with real depth).
      { name: 'dyorswap', address: '0x942bd5bfdc5317c5507e326f8eb4bb6058ab5c10', deployBlock: 4_130_418, feePips: 3000 },
    ],
    eurc: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
    cirBtc: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0',
  },
  [arcTestnet.id]: {
    // Community PoolManager on testnet; every pool there had zero liquidity on 2026-09-16.
    poolManager: '0x2756f3f7bfaf103f4c550f4d24cdca82b093240a',
    poolManagerDeployBlock: 59_094_022,
    usdc: '0x3600000000000000000000000000000000000000',
    v3Factories: [],
    v2Factories: [],
  },
}

/** The two on-chain views of USDC on Arc are one balance: native wei = erc20 units * 1e12. */
export const USDC_NATIVE_PER_ERC20 = 1_000_000_000_000n
