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
  'struct Step { PoolKey key; bool zeroForOne; }',
  'struct Guard { bytes32 poolId; uint160 expectedSqrtPriceX96; uint24 toleranceBps; }',
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
  'error StaleState(uint256 guardIndex, uint160 actualSqrtPriceX96)',
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
