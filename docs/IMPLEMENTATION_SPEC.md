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
  always pass an explicit block number. A second cap applies: at most 20,000 logs per response
  (JSON-RPC -32602 "query exceeds max results 20000, retry with the range a-b"), so dense Swap-log
  queries must bisect. Rate limiting also arrives as HTTP 200 with JSON-RPC error -32005
  "rate limit exceeded", not only as HTTP 429. Querying a block the node does not have yet returns
  -32014 (getLogs) or -32001 "block not found" (eth_call).
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
struct Step   { uint8 kind; bool zeroForOne; address pool; PoolKey key; }   // kind 0 = v4, 1 = v3-style, 2 = v2-style
struct Guard  { uint8 kind; bytes32 poolId; uint160 expected; uint24 toleranceBps; }
function execute(Step[] steps, uint256 amountIn, uint256 minProfit, Guard[] guards) returns (uint256 profit)
```

- For every kind `key.currency0/currency1` are the pool's token0/token1 and `zeroForOne` the direction.
  v4 uses the whole key; v3/v2 use `pool` (and for v2 `key.fee` = pair fee in pips). `hooks`/`tickSpacing`
  are zero for non-v4 hops.
- Guards: kind 0 -> `poolId` is the v4 id and `expected` its sqrtPriceX96; kind 1 -> `poolId` is the v3
  pool address left-padded to 32 bytes and `expected` its slot0 sqrtPriceX96; kind 2 -> v2 pair address,
  `expected` = the pair price as sqrtPriceX96 = `isqrt(reserve1 * 2^192 / reserve0)` (exactly the value the
  venues layer stores in `PoolState.sqrtPriceX96` for v2 pairs; the contract exposes `v2SqrtPriceX96()`).
  So `toGuards` uses `state.sqrtPriceX96` for every kind.
- A cycle may start in native USDC (address(0)) and end in the ERC-20 predeploy (0x3600…) or vice versa;
  the contract treats them as the same money (they are one balance on Arc) and measures profit in the
  start currency's units.
- `execute` reverts with `StaleState(i, actual)` before any swap if a guarded pool moved more than
  `toleranceBps`, and with `Unprofitable(net, minProfit)` after the swaps if the net gain is too small.
  Simulation is a plain `eth_call` of `execute` from the operator address.

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

## Stage 2: more venues, hooked pools, sharper gas

Stage 1 (above) is complete: a v4-hookless arbitrage bot, verified live in dry-run. Stage 2 extends it.
Shared types already carry what is needed: `PoolInfo.kind/pool/venue` (`poolKind()`, `addressToPoolId()`),
`PoolState.reserves`, `ExecutorStep.kind/pool`, `StateGuard.kind`, `ADDRESSES[chain].v3Factories/v2Factories`
(`VenueFactory`), `ADDRESSES[chain].v4Quoter`, config `QUOTE_GAS`.

### 2A. v3-style and v2-style venues (owner: venues agent — `src/discovery`, `src/state`, `src/math`, `test/data`, `test/math`)

- Discovery: for each `VenueFactory` in `ADDRESSES[chain].v3Factories` scan
  `PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)`;
  for each in `v2Factories` scan `PairCreated(address indexed token0, address indexed token1, address pair, uint256)`.
  Upsert into the same `PoolStore` with `kind`, `pool`, `venue`, `poolId = addressToPoolId(pool)`, `fee`
  (v2: `factory.feePips`), `tickSpacing` (v2: 0), `hooks` = zero. Resume per factory: keep
  `store.venues[name].lastScannedBlock` (add the field to `PoolStore`; v4 keeps `lastScannedBlock`).
- Liquidity refresh: v3 `liquidity()` and v2 `getReserves()` through Multicall3 `aggregate3` (allowFailure),
  ≤ 300 calls per aggregate. Store v2 "liquidity" as `isqrt(reserve0 * reserve1)` so the existing
  `MIN_POOL_LIQUIDITY` / ordering keep working. Activity: v3 `Swap(address indexed sender, address indexed
  recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)` and v2
  `Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)`
  by topic over the look-back range, matched to known pool addresses (no address filter; bisect on the 20k cap).
- State (`fetchPoolStates` must accept mixed kinds and dispatch):
  - v3: Multicall3 batch of `slot0()`, `liquidity()`, `tickBitmap(int16)` for the window words, then
    `ticks(int24)` for set bits. Decode `slot0` and `ticks` from the **leading words only**
    (sqrtPriceX96, tick; liquidityGross, liquidityNet) so v3 forks with extra fields still decode.
    Fill `PoolState` exactly like v4 with `lpFee = info.fee`, `protocolFee = 0`, `tickSpacing = info.tickSpacing`.
  - v2: one `getReserves()` per pair (batched). Fill `reserves`, and derive for ranking:
    `sqrtPriceX96 = isqrt(reserve1 * 2^192 / reserve0)`, `tick = getTickAtSqrtPrice(...)`,
    `liquidity = isqrt(reserve0 * reserve1)`, `lpFee = info.fee`, empty `ticks`, `tickWindow = {MIN_TICK, MAX_TICK}`.
- `StateCache.applyBlock`: one `eth_getLogs` for the block with **no address filter** and topics
  `[v4 Swap | v4 ModifyLiquidity | v3 Swap | v3 Mint | v3 Burn | v2 Sync]` (any-of on topic0), then
  route by emitter address / pool id to the tracked pool. v3 Swap → sqrtPrice/tick/liquidity in place;
  v3 Mint/Burn → refetch that pool; v2 Sync → reserves in place. Keep the v4 behaviour unchanged.
- Math: `simulateV2ExactInput(reserves, feePips, zeroForOne, amountIn): SwapResult` (UniswapV2 formula:
  `amountInWithFee = amountIn * (1e6 - fee)`, `out = amountInWithFee * rOut / (rIn * 1e6 + amountInWithFee)`),
  and `simulateHop(info: PoolInfo, state: PoolState, zeroForOne, amountIn): SwapResult` dispatching on
  `poolKind(info)`: v4 → `simulateExactInput`, v3 → `simulateExactInput` with `protocolFee` forced to 0
  (v3 protocol fees come out of the LP fee and do not change the output), v2 → the v2 formula.
  Export a `Simulator`-compatible closure factory `makeSimulator(infos: Map<Hex, PoolInfo>)`.
- Tests: decoding fixtures for v3 `slot0`/`ticks` with extra trailing words, v2 derivation, a v2 math
  vector set generated with Foundry from a real `UniswapV2Pair`-equivalent formula (or hand-computed
  with known reserves), StateCache routing of v3/v2 events, discovery upsert/resume per venue on a
  synthetic store; a live test (skipped without `ARC_RPC_URL`) that fetches state for the v3
  cirBTC/USDC 0.01% pool `0x82916bee18fcef517b26c72d7cb5f13694e1db41` and one Uniswap v2 pair.

### 2B. Cross-kind execution, hooked-pool probing, gas and resilience (owner: exec agent — `src/exec`, `src/strategy`, `src/main.ts`, `src/cli`, `test/exec`, `test/strategy`)

- `toExecutorSteps` / `toGuards` by kind: v3/v2 steps set `kind`, `pool`, `key.currency0/1`, `key.fee`
  (v2 fee pips; v3 fee), `tickSpacing 0`, `hooks 0`. Guards: v3 `{kind 1, poolId: addressToPoolId(pool), expected: sqrtPriceX96}`,
  v2 `{kind 2, poolId: addressToPoolId(pair), expected: state.sqrtPriceX96}` (derived from reserves, see the ABI section).
- Cycle building must accept mixed kinds (it already keys on poolId); the evaluation must use
  `simulateHop` (2A) instead of `simulateExactInput` directly.
- **Hooked-pool probe** (`src/strategy/probe.ts`, config `PROBE_HOOKED_POOLS` default true,
  `PROBE_MAX_PER_BLOCK` default 4, `PROBE_MIN_SPREAD_BPS` default 30, `PROBE_GRID` default 5):
  hooked v4 pools cannot be simulated locally, but `V4Quoter.quoteExactInput(QuoteExactParams{exactCurrency,
  PathKey[] path, uint128 exactAmount})` (`0xca253dc9`, non-view; call it with `eth_call`, it returns
  `(amountOut, gasEstimate)`) prices a whole multi-hop path in one call. Keep a "probe set" of the most
  active hooked pools (from `refreshActivity`), with only `sqrtPriceX96` tracked (from Swap logs).
  On each block, for every touched hooked pool P on pair (A,B): for each tracked pool Q (any kind) on the
  same pair whose spot price differs from P's by more than `PROBE_MIN_SPREAD_BPS`, build the two 2-hop
  cycles through P and Q that start in a start currency and quote them at `PROBE_GRID` log-spaced inputs
  between minInput and maxInput in **one JSON-RPC batch** of `eth_call`s (the V4Quoter can quote the
  hooked hop; quote the non-hooked hop locally with `simulateHop` and chain: for the cycle "start → P → Q →
  start" quote P on-chain then Q locally; for "start → Q → P → start" simulate Q locally then quote P
  on-chain). Pick the best grid point, refine once around it, and emit `Opportunity`s into the normal
  ranking → on-chain executor simulation → send path. Cap at `PROBE_MAX_PER_BLOCK` probed pairs per block,
  most-spread first. Log at debug how many probes ran and their latency.
- Gas: `readNextBaseFee(block)`: parse the current block header's `extraData` as an 8-byte big-endian
  integer = next block's base fee (verified on Arc); fall back to `baseFeePerGas * 1125 / 1000` if the
  field is not exactly 8 bytes. Use it in `quoteCandidates` and `planFor`. Fetch the header concurrently
  with `cache.applyBlock`, not after it.
- Resilience: WS stall watchdog (no head for `WS_STALL_MS`, default 3000 → switch to polling and log);
  optional `WS_URLS` (comma list) racing several `newHeads` subscriptions and de-duplicating by block
  number; `MAX_CONSECUTIVE_REVERTS` (default 3) circuit breaker that pauses sending for
  `BREAKER_PAUSE_BLOCKS` (default 120) after that many reverted or lost sends, and a rolling
  `GAS_BUDGET_USDC_WEI` per `GAS_BUDGET_WINDOW_BLOCKS` (defaults 5 USDC / 7200 blocks) after which the
  bot only dry-runs until the window rolls. Add these to `config.ts` (this agent may edit config.ts and
  `.env.example`; keep existing fields).
- `cli/scan` prints the pool kind/venue per hop and marks probed (hooked) cycles.
- Tests: encode/guards for v3/v2 steps with a Solidity calldata vector (extend
  `contracts/test/vectors/ExecCalldataVectors.t.sol`), `readNextBaseFee` parsing (fixture header from
  Arc with `extraData` 0x0000001e78249c77 = 130.86 gwei), probe grid/batching with a fake transport,
  breaker and budget logic, watchdog fallback with fake timers.

#### 2B addendum: which hooked pools to probe (from the hook research)

- Decode hook permissions from the low 14 bits of the hook address
  (`BEFORE_SWAP = 1<<7`, `AFTER_SWAP = 1<<6`, `BEFORE_SWAP_RETURNS_DELTA = 1<<3`, `AFTER_SWAP_RETURNS_DELTA = 1<<2`).
- **Exclude** from probing any hook with `BEFORE_SWAP_RETURNS_DELTA` (the launchpad families
  `…e0cc` = 0x20cc and `…6acc` = 0x2acc): they are one-sided bonding curves; the sell direction reverts
  with `NotEnoughLiquidity`, so they cannot close a cycle.
- **Include** hooks with only `BEFORE_SWAP + AFTER_SWAP + AFTER_SWAP_RETURNS_DELTA` (flags 0x5c7 family:
  the market-maker pools `0x285f3cc5…`, `0x16e40ea8…`, `0x58f2cee5…`, `0x50e4e362…`). They charge ~0 fee
  today, have no caller restrictions or cooldowns, and are actively arbitraged, but their owners can
  pause or reconfigure at any time, so quote them fresh every block and never tick-walk them locally.
- A `V4Quoter` revert wrapping `NotEnoughLiquidity(bytes32)` (`0x6190b2b0` → inner `0x7a5ed734`) means
  "reduce size", not "pool broken": halve the input and retry within the same probe budget.
- Budget ~25–45k extra gas per hooked hop when quoting profitability.
- Optionally read `paused()` (`0x5c975abb`) on a hook once per N blocks and skip paused hooks.
