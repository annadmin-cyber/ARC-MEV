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
    default: { http: ['https://rpc.mainnet.arc.io'] },
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

/** Well-known addresses per chain. Fill testnet values once verified. */
export const ADDRESSES: Record<number, {
  poolManager: `0x${string}`
  /** Block the PoolManager was deployed in (discovery starts here). */
  poolManagerDeployBlock: number
  usdc: `0x${string}`
}> = {
  [arc.id]: {
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    poolManagerDeployBlock: 1_948_056,
    usdc: '0x3600000000000000000000000000000000000000',
  },
  [arcTestnet.id]: {
    poolManager: '0x0000000000000000000000000000000000000000',
    poolManagerDeployBlock: 0,
    usdc: '0x3600000000000000000000000000000000000000',
  },
}
