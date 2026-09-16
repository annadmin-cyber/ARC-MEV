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
  /** Uniswap-v3-style factory with active pools (operator unknown). */
  v3Factory?: `0x${string}`
  /** WarpDex v2-style factory. */
  v2Factory?: `0x${string}`
  eurc?: `0x${string}`
}> = {
  [arc.id]: {
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    poolManagerDeployBlock: 1_948_056,
    usdc: '0x3600000000000000000000000000000000000000',
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
    universalRouter: '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1',
    v3Factory: '0xf0db7b58379503491d857db50ac9ece64c653918',
    v2Factory: '0x32330c2400a6e0830d56661169ebb6c147e3577a',
    eurc: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
  },
  [arcTestnet.id]: {
    poolManager: '0x0000000000000000000000000000000000000000',
    poolManagerDeployBlock: 0,
    usdc: '0x3600000000000000000000000000000000000000',
  },
}

/** The two on-chain views of USDC on Arc are one balance: native wei = erc20 units * 1e12. */
export const USDC_NATIVE_PER_ERC20 = 1_000_000_000_000n
