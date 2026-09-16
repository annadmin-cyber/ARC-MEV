import { parseAbi } from 'viem'

/** The parts of Uniswap v4 PoolManager the bot uses. */
export const poolManagerAbi = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  'function extsload(bytes32 slot) view returns (bytes32)',
  'function extsload(bytes32 startSlot, uint256 nSlots) view returns (bytes32[])',
  'function extsload(bytes32[] slots) view returns (bytes32[])',
])

/** ArcArbExecutor (contracts/src/ArcArbExecutor.sol). */
export const executorAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Step { uint8 kind; bool zeroForOne; address pool; PoolKey key; }',
  'struct Guard { uint8 kind; bytes32 poolId; uint160 expected; uint24 toleranceBps; }',
  'function execute(Step[] steps, uint256 amountIn, uint256 minProfit, Guard[] guards) returns (uint256 profit)',
  'function withdraw(address currency, address to, uint256 amount)',
  'function sweep(address currency, address to)',
  'function owner() view returns (address)',
  'function operator() view returns (address)',
  'function POOL_MANAGER() view returns (address)',
  'event Executed(address indexed currency, uint256 amountIn, uint256 profit, uint256 steps)',
  'error NotOwner()',
  'error NotOperator()',
  'error NotPoolManager()',
  'error ZeroAddress()',
  'error EmptyPlan()',
  'error PathBroken(uint256 stepIndex)',
  'error NoOutput(uint256 stepIndex)',
  'error CycleNotClosed(address start, address end)',
  'error Unprofitable(int256 delta, uint256 minProfit)',
  'error StaleState(uint256 guardIndex, uint160 actual)',
  'error UnknownKind(uint256 stepIndex)',
  'error UnexpectedCallback(address caller)',
  'error CallbackOverpay(uint256 requested, uint256 allowed)',
  'error InvalidCallbackDeltas(int256 amount0Delta, int256 amount1Delta)',
  'error CallFailed(bytes reason)',
])

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])

export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])

/**
 * Uniswap v4 `V4Quoter` (v4-periphery `lens/V4Quoter.sol`). The quote functions are non-view
 * (they swap and revert internally) and must be invoked with `eth_call`; a failed quote bubbles
 * up as `UnexpectedRevertBytes(bytes)` or `NotEnoughLiquidity(bytes32)`.
 */
export const v4QuoterAbi = parseAbi([
  'struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }',
  'struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function quoteExactInput(QuoteExactParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'error UnexpectedRevertBytes(bytes revertData)',
  'error NotEnoughLiquidity(bytes32 poolId)',
  'error QuoteSwap(uint256 amount)',
])

/** Uniswap v3 factory: the canonical `PoolCreated` event (shared by most v3 forks). */
export const v3FactoryAbi = parseAbi([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
])

/**
 * Uniswap v3 pool surface the bot reads. `slot0()` and `ticks()` are declared with the canonical
 * layouts, but the state reader decodes only their leading words (sqrtPriceX96, tick;
 * liquidityGross, liquidityNet) so forks with extra or fewer trailing fields still decode.
 */
export const v3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickBitmap(int16 wordPosition) view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
])

/** Uniswap v2 factory: the canonical `PairCreated` event (shared by v2 forks such as DYORSwap). */
export const v2FactoryAbi = parseAbi([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairIndex)',
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
])

/** Uniswap v2 pair surface the bot reads. */
export const v2PairAbi = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
])

/** Uniswap v3 QuoterV2 (non-view: call it with `eth_call`). Used to cross-check the local v3 simulator. */
export const v3QuoterV2Abi = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])
