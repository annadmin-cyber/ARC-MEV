# Implementation spec (TypeScript bot)

Read this before touching `src/`. It fixes interfaces so modules built in parallel fit together.

## Conventions

- Node 22, ESM, TypeScript strict (`tsconfig.json`: `NodeNext`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). **Relative imports must end in `.js`** (`import { x } from './foo.js'`).
- All token amounts, prices and liquidity are `bigint`. Never use `number` for on-chain quantities.
- Addresses are lower-cased everywhere internally (`address.toLowerCase() as Address`).
- viem 2.x only (`viem`, `viem/accounts`). No ethers.
- Logging via `src/logger.ts` (`log.info({obj}, 'msg')`). `jsonReplacer` renders bigint.
- Config via `loadConfig()` in `src/config.ts`. Do not read `process.env` elsewhere.
- Tests: vitest, files in `test/**/*.test.ts`. Pure logic must be unit-tested without network.
  Network tests must be skipped unless `ARC_RPC_URL` is set (`describe.skipIf(!process.env.ARC_RPC_URL)`).
- Typecheck: `npx tsc --noEmit`. Tests: `npx vitest run`. Both must pass before you finish.
- Shared types live in `src/types.ts`; ABIs in `src/abi/index.ts`; chain data in `src/chains.ts`.
  Extend them if you must, but do not change existing fields.

## Chain facts that matter (verified 2026-09-16)

- Arc mainnet chain id 5042, RPC `https://rpc.mainnet.arc.io`, ~500 ms blocks, single-confirmation finality.
- The public RPC limits `eth_getLogs` to a **10,000 block range** and returns HTTP **429** under
  load (~10 req/s sustained triggers it). All RPC helpers must retry with exponential backoff on 429
  and on `-32005`/"limit" style errors, and must cap concurrency (default 4).
- `eth_getLogs` with `toBlock: "latest"` can fail with "block range extends beyond current head";
  always pass an explicit block number.
- No public mempool: `txpool_*`, pending filters and `newPendingTransactions` are refused. `newHeads`
  works over WebSocket on provider endpoints. `eth_getBlockByNumber("pending")` is refused, so nonce
  management must use the `latest` tag plus a local counter.
- Blocks are ordered by **descending effective priority fee** (`min(maxPriorityFeePerGas, maxFeePerGas - baseFee)`).
  Base fee floats (EIP-1559 EWMA, floor 20 gwei, cap 20,000 gwei; ~75 gwei on launch day).
  `eth_maxPriorityFeePerGas` returns 0 and is useless; use `eth_feeHistory` reward percentiles.
- Gas is native USDC with 18 decimals. The ERC-20 USDC predeploy `0x3600…0000` has 6 decimals and is a
  **different v4 currency** from native (`address(0)`).
- Uniswap v4 PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`, deployed at block 1,948,056.
  48k pools initialised; ~24.5k have liquidity; ~4.3k of those are hookless. Discovery must persist and resume.
- Single-transaction gas cap 16,777,216; block gas limit 30M.

## PoolManager storage layout (for `extsload`)

From `v4-core/src/libraries/StateLibrary.sol` (all keccak over `abi.encodePacked`):

```
POOLS_SLOT      = 6
stateSlot       = keccak256(poolId ‖ uint256(6))                      // 32 + 32 bytes
slot0           = stateSlot + 0   -> packed: [24 bits lpFee][24 bits protocolFee][24 bits tick][160 bits sqrtPriceX96]
                                    lpFee = (v >> 208) & 0xffffff, protocolFee = (v >> 184) & 0xffffff,
                                    tick = int24((v >> 160) & 0xffffff), sqrtPriceX96 = v & (2^160-1)
feeGrowth0      = stateSlot + 1,  feeGrowth1 = stateSlot + 2
liquidity       = stateSlot + 3   -> uint128 in the low bits
ticksMapping    = stateSlot + 4
tickInfoSlot    = keccak256(int256(tick) ‖ ticksMapping)               // tick sign-extended to 32 bytes
                  word 0: [128 bits liquidityNet (int128, high)][128 bits liquidityGross (uint128, low)]
                  word 1: feeGrowthOutside0, word 2: feeGrowthOutside1
tickBitmap      = stateSlot + 5
bitmapWordSlot  = keccak256(int256(int16 wordPos) ‖ tickBitmap)
positions       = stateSlot + 6
```

`extsload(bytes32[] slots)` selector `0xdbd035ff` returns the values in order. Batch up to ~1,000 slots per call.

Tick bitmap: `compressed = floor(tick / tickSpacing)` (floor toward -inf), `wordPos = compressed >> 8`,
`bitPos = compressed & 0xff`; bit set means tick `compressed * tickSpacing` is initialised.

## Swap math (v4 `Pool.swap`)

- `swapFee = protocolFeeForDirection == 0 ? lpFee : calculateSwapFee(protocolFeeForDirection, lpFee)`
  where `protocolFeeForDirection = zeroForOne ? protocolFee & 0xfff : protocolFee >> 12` and
  `calculateSwapFee(p, lp) = p + lp - (p * lp) / 1_000_000`.
- Exact input: `amountSpecified` negative; loop while `amountRemaining != 0 && sqrtPrice != limit`:
  - `nextTick = nextInitializedTickWithinOneWord(tick, tickSpacing, zeroForOne)` clamped to MIN/MAX tick.
  - `sqrtPriceTarget = getSqrtPriceTarget(zeroForOne, sqrtPriceAtTick(nextTick), limit)`
  - `computeSwapStep(sqrtPriceCurrent, sqrtPriceTarget, liquidity, amountRemaining, swapFee)` (v4 signature:
    `amountRemaining` negative for exact input; returns `(sqrtPriceNext, amountIn, amountOut, feeAmount)`).
  - `amountRemaining += amountIn + feeAmount` (toward zero), `amountCalculated += amountOut`.
  - Crossing: if `sqrtPriceNext == sqrtPriceAtTick(nextTick)` and the tick is initialised, apply
    `liquidityNet` (negated when zeroForOne); `tick = zeroForOne ? nextTick - 1 : nextTick`.
    Else `tick = getTickAtSqrtPrice(sqrtPriceNext)` when the price moved.
- Reference implementation: `contracts/lib/v4-core/src/libraries/{SwapMath,SqrtPriceMath,TickMath,TickBitmap,FullMath,LiquidityMath}.sol`
  and `Pool.sol`. Port them literally; do not "simplify" rounding.
- The local simulator only knows ticks inside `state.tickWindow`. If the walk would leave the window,
  stop and return `truncated: true` with what was computed so far.

## Executor contract ABI

`contracts/src/ArcArbExecutor.sol`:

```
struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct Step   { PoolKey key; bool zeroForOne; }
struct Guard  { bytes32 poolId; uint160 expectedSqrtPriceX96; uint24 toleranceBps; }
function execute(Step[] steps, uint256 amountIn, uint256 minProfit, Guard[] guards) returns (uint256 profit)
```

`execute` reverts with `StaleState(i, actual)` before any swap if a guarded pool's sqrtPrice moved more
than `toleranceBps` basis points, and with `Unprofitable(net, minProfit)` after the swaps if the net
gain is too small. Simulation is a plain `eth_call` of `execute` from the operator address.

## Module contracts

### `src/math/` (owner: math agent)

```
export function simulateExactInput(state: PoolState, zeroForOne: boolean, amountIn: bigint): SwapResult
export const TickMath = { getSqrtPriceAtTick(tick: number): bigint; getTickAtSqrtPrice(sqrtPriceX96: bigint): number; MIN_TICK; MAX_TICK; MIN_SQRT_PRICE; MAX_SQRT_PRICE }
export function computeSwapStep(...)  // v4 semantics
export function nextInitializedTickWithinOneWord(ticks: Map<number, TickData>, tick: number, tickSpacing: number, lte: boolean, window): { next: number; initialized: boolean }
export function priceOf(state: PoolState, zeroForOne: boolean): number   // marginal price for ranking only (float ok)
```

`simulateExactInput` must never throw for well-formed state; return `truncated: true` instead.

### `src/rpc/` (owner: data agent)

```
export interface RpcClients { http: PublicClient; ws?: PublicClient; chain: Chain; sendUrls: string[] }
export function makeClients(cfg: Config): RpcClients
export function withRetry<T>(fn: () => Promise<T>, opts?): Promise<T>   // 429 / rate-limit aware
export function limiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T>
export function extsload(clients: RpcClients, poolManager: Address, slots: Hex[], block?: bigint): Promise<Hex[]>  // batches internally
```

### `src/discovery/` (owner: data agent)

```
export interface PoolStore { chainId: number; lastScannedBlock: number; pools: Record<Hex, PoolInfo & { liquidity?: string; lastSwapBlock?: number }> }
export async function loadPoolStore(cfg): Promise<PoolStore>            // data/pools.<chainId>.json or empty
export async function scanPools(clients, cfg, store, opts?: { toBlock?: bigint; onProgress?: (b: number) => void }): Promise<PoolStore>
export async function refreshLiquidity(clients, cfg, store): Promise<void>   // extsload liquidity for all pools
export async function refreshActivity(clients, cfg, store, lookbackBlocks: number): Promise<void>  // Swap logs -> lastSwapBlock
export async function savePoolStore(cfg, store): Promise<void>
export function selectTrackedPools(cfg, store): PoolInfo[]   // hooks allowed, liquidity >= min, sort by (recent activity, liquidity), cap MAX_TRACKED_POOLS
```

### `src/state/` (owner: data agent)

```
export async function fetchPoolStates(clients, cfg, pools: PoolInfo[], block: bigint): Promise<Map<Hex, PoolState>>
   // 2 round trips: (slot0, liquidity, bitmap words) then (tick infos for set bits in the window)
export class StateCache {
  constructor(clients, cfg, pools: PoolInfo[])
  async init(block: bigint): Promise<void>
  async applyBlock(block: bigint): Promise<{ touched: Set<Hex>; block: bigint }>
   // fetch PoolManager logs for `block` (Swap, ModifyLiquidity); Swap -> update sqrtPrice/tick/liquidity/lpFee in place;
   // ModifyLiquidity or tick leaving the window -> refetch that pool. Also refetch every cfg.FULL_REFRESH_BLOCKS (default 200).
  get(poolId: Hex): PoolState | undefined
  all(): Map<Hex, PoolState>
}
```

### `src/strategy/` (owner: strategy agent)

```
export function buildCycles(pools: PoolInfo[], startCurrencies: Set<Address>, maxHops: 2 | 3): Cycle[]
export function cyclesTouching(cycles: Cycle[]): Map<Hex, Cycle[]>          // poolId -> cycles
export function evaluateCycle(cycle, states: Map<Hex, PoolState>, infos: Map<Hex, PoolInfo>, simulate: Simulator, opts: { minInput: bigint; maxInput: bigint; block: number }): Opportunity | null
   // golden-section search on ln(amountIn); profit(x) = out(x) - x; return null if best profit <= 0
export function rankOpportunities(opps: Opportunity[], decimals: Map<Address, number>): Opportunity[]  // normalise to 18-dec USDC, sort desc, drop overlapping pools (keep best per pool)
```

`maxInput` is in the start currency's own units (config `MAX_INPUT_USDC_WEI` is 18-dec; scale by decimals).

### `src/exec/` + `src/main.ts` + `src/cli/` (owner: exec agent)

```
export function toExecutorSteps(cycle: Cycle, infos: Map<Hex, PoolInfo>): ExecutorStep[]
export function toGuards(cycle, states, toleranceBps): StateGuard[]
export async function simulateOnChain(clients, cfg, opp, steps, guards, block): Promise<{ ok: true; profit: bigint; gas: bigint } | { ok: false; reason: string }>
export function feePolicy(cfg, baseFee: bigint, expectedProfit18: bigint, gasLimit: bigint): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasCost: bigint }
export class Sender { constructor(clients, cfg, account); async send(tx): Promise<{ hash: Hex; sentTo: string[] }>; nonce mgmt; one in-flight per block }
main.ts: block loop as described in docs/ARCHITECTURE.md; DRY_RUN logs "would send" with full details.
cli/discover.ts: scan + refresh liquidity + activity + save + print stats.
cli/scan.ts: load store, select pools, fetch states at latest block, evaluate all cycles, print top 20.
```
