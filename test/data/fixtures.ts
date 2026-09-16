import type { Hex } from 'viem'

/**
 * Reference vectors printed by `contracts/test/vectors/SlotVectors.t.sol`
 * (`forge test --match-contract SlotVectors -vv`), which uses the exact keccak expressions of
 * v4-core `StateLibrary`. Regenerate and paste if the storage layout ever changes.
 */
export const SLOT_VECTORS = {
  poolId: '0xba2b9bdf04fd659448a44ac6cabc27f8565bcdf00f58028ec9a07ccf31286514' as Hex,
  stateSlot: '0x984386273dc964369e8759a3c981eaf7cf6e3819f1e92f0b074f5382b50c7289' as Hex,
  slot0Slot: '0x984386273dc964369e8759a3c981eaf7cf6e3819f1e92f0b074f5382b50c7289' as Hex,
  liquiditySlot: '0x984386273dc964369e8759a3c981eaf7cf6e3819f1e92f0b074f5382b50c728c' as Hex,
  ticksMappingSlot: '0x984386273dc964369e8759a3c981eaf7cf6e3819f1e92f0b074f5382b50c728d' as Hex,
  tickBitmapSlot: '0x984386273dc964369e8759a3c981eaf7cf6e3819f1e92f0b074f5382b50c728e' as Hex,
  tickInfoSlots: [
    { tick: -887272, slot: '0x7114bcd4cbfd5651d2301e045c887a85a03a7b3109986f563825f5d5b3757e41' as Hex },
    { tick: -60, slot: '0x12ade398fa7f2fa3c1bae08009357c788073b3d416d27904767775f17cba2a70' as Hex },
    { tick: -1, slot: '0x476fa0727eda59a87076798881a7cebd111b27fc196ffaa968f85484d2d682d2' as Hex },
    { tick: 0, slot: '0x904c3d7d8d088a369449f7464bfc15522412dc6f617c06410350726bfef6c67a' as Hex },
    { tick: 1, slot: '0x5309942517c2db8e465c57fdeddccefa9614c9beebee25bbbbbec8907ba6eddf' as Hex },
    { tick: 60, slot: '0x52176194065fc08574da63f52497450083be73df1c347ab464fa3970814cf433' as Hex },
    { tick: 887272, slot: '0xd688af3069baa91b5c331af12ef819bf2d87649fb8d899c526427b092eb400a5' as Hex },
  ],
  bitmapWordSlots: [
    { wordPos: -3466, slot: '0xfa62bb15f843cd069b6378a6ea1474d158e449d0057e158451cd9068edb5d590' as Hex },
    { wordPos: -1, slot: '0x6b4d5895d44a19a9482e3d2ecfa1cd69e19a557888e30505e923d4c59441d847' as Hex },
    { wordPos: 0, slot: '0x86cae6e65707666bab87844eca5dfc6f913b18062985e14242a9b4c97a31cda3' as Hex },
    { wordPos: 1, slot: '0xf135456d4c862050a26cc2790de3dde361c0e436804a83e316445977783d947b' as Hex },
    { wordPos: 3465, slot: '0x315907177876637f5f3ca20add0f6f5e84fd76a80408ef8ac7d94f0df8b7b3e7' as Hex },
  ],
} as const

/** Live pool rows (block = initialise block) copied from the Arc mainnet reference snapshot of 2026-09-16. */
export interface LivePoolRef {
  block: number
  poolId: Hex
  currency0: `0x${string}`
  currency1: `0x${string}`
  fee: number
  tickSpacing: number
  hooks: `0x${string}`
  sqrtPriceX96: string
  tick: number
  protocolFee: number
  lpFee: number
  liquidity: string
}

export const LIVE_POOLS: LivePoolRef[] = [
  {
    block: 21112099,
    poolId: '0xba2b9bdf04fd659448a44ac6cabc27f8565bcdf00f58028ec9a07ccf31286514',
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0xc8c256e41c6cc5fcbf6a8e3b1b53f5778f033e22',
    fee: 30000,
    tickSpacing: 25,
    hooks: '0x0000000000000000000000000000000000000000',
    sqrtPriceX96: '533968626430913993175880612',
    tick: -100001,
    protocolFee: 0,
    lpFee: 30000,
    liquidity: '156110757352674480799197329519',
  },
  {
    block: 21117003,
    poolId: '0x27effa630d7bfb73a05b935b7388ad81ab09cd7d16f6ea2a907fd7ea5c7f1c73',
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x14b8a0714f7f3371fef3b2f371e0f2023715b36b',
    fee: 10000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000',
    sqrtPriceX96: '71976280159915846857433054512',
    tick: -1921,
    protocolFee: 0,
    lpFee: 10000,
    liquidity: '1100788910709095788945967942',
  },
  {
    block: 1954869,
    poolId: '0x611ec10e5fbe93056d4c24c4c35447408bafdae1ec98769052c1cf9382787d77',
    currency0: '0x8093c294fa1e683c61e3f98ff5a20cf6d1aa7934',
    currency1: '0xa9da76039759cd7002f9340ba83fa31cfe5aeb64',
    fee: 3000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000',
    sqrtPriceX96: '3973128855837938857806917',
    tick: -198021,
    protocolFee: 0,
    lpFee: 3000,
    liquidity: '50000000000000',
  },
  {
    block: 2571955,
    poolId: '0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae',
    currency0: '0x3600000000000000000000000000000000000000',
    currency1: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
    fee: 500,
    tickSpacing: 10,
    hooks: '0x0000000000000000000000000000000000000000',
    sqrtPriceX96: '73739375688556419417774397036',
    tick: -1436,
    protocolFee: 0,
    lpFee: 500,
    liquidity: '31822925403206',
  },
  {
    block: 12914230,
    poolId: '0x787a056274939a64a650e70272b9f84c8a6af5e9cd73ae6fbee70df891cf162b',
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x5ea05e20b5051308d25ac67e5c41f85f932e0680',
    fee: 8388608,
    tickSpacing: 10,
    hooks: '0x5eb5e33252a0056ead978072975afa1ece12e8cc',
    sqrtPriceX96: '46996333177882236921561671268829',
    tick: 127716,
    protocolFee: 0,
    lpFee: 0,
    liquidity: '1730198690532432501050967',
  },
  {
    block: 10322420,
    poolId: '0x33ff0d317fe3412c66cb4ccd69b1869120a09bb206ba5707e01e186b7dfa5782',
    currency0: '0x2f246d606149e933b2cfc3403b47c634a57e8a16',
    currency1: '0x3600000000000000000000000000000000000000',
    fee: 3000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000000',
    sqrtPriceX96: '113221469650632773937',
    tick: -407346,
    protocolFee: 0,
    lpFee: 3000,
    liquidity: '2999999999999',
  },
]

/** A recent block at which the live tests read state (a few thousand blocks behind the 2026-09-16 head). */
export const LIVE_TEST_BLOCK = 21_168_017n
