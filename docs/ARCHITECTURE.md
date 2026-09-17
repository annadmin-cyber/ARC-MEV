# Architecture

This repo is a **state-based arbitrage MEV bot for Arc** (Circle's stablecoin L1,
chain id 5042). It watches Uniswap v4 pools, Uniswap-v3-style pools and
Uniswap-v2-style pairs on Arc, finds price discrepancies between them after every
block, and captures them atomically in one transaction: v4 flash accounting covers
the v4 hops and a `PoolManager.take` flash loan funds the v3/v2 hops, so the bot
needs **no trading capital**, only USDC for gas. Hooked v4 pools (market-maker
hooks that charge through return deltas) cannot be simulated locally; they are
quoted fresh every block through the on-chain `V4Quoter` and traded through the
same executor.

## Why this strategy and not a sandwich bot

Arc has no public mempool. Blocks are produced every ~500 ms by a permissioned
validator set and transactions are not visible before they are included.
Sandwiching (jaredfromsubway-style) depends on seeing a victim's pending swap
and wrapping it; that is impossible here. What *is* possible:

| Strategy | Feasible on Arc | Status in this repo |
|---|---|---|
| Cyclic arbitrage across hookless v4 pools after each block ("backrun on state") | yes | implemented (stage 1) |
| The same across venues: v4 + Uniswap v3 + Uniswap v2 / DYORSwap pairs in one transaction | yes | implemented (stage 2) |
| Hooked v4 pools (market-maker hooks) priced through `V4Quoter` and arbitraged against tracked pools | yes | implemented (stage 2, "probe") |
| UniswapX Dutch-order filling (reactor is deployed on Arc) | yes | planned (strategy interface is ready for it) |
| Liquidations | once a lending protocol deploys | planned |
| Sandwiching / frontrunning | no public mempool | not possible |

## Components

```
contracts/                 Foundry project
  src/ArcArbExecutor.sol   on-chain executor: runs a closed cycle of swaps inside PoolManager.unlock.
                           Step.kind 0 = v4 (flash accounting), 1 = v3-style pool (swap + callback,
                           input flash-borrowed via PoolManager.take), 2 = v2-style pair. Price guards
                           per kind (v4/v3 sqrtPriceX96, v2 sqrt(reserve1/reserve0)*2^96) abort before
                           any swap; reverts unless profit >= minProfit
  test/                    unit tests against a locally deployed PoolManager plus mock v3/v2 venues,
                           and calldata / math vectors shared with the TypeScript tests

src/                       TypeScript bot (viem)
  config.ts                env + zod config, dry-run by default
  chains.ts                Arc chain definitions; per-chain addresses incl. the v3/v2 factories to index
  abi/                     ABIs: PoolManager, executor, Multicall3, V4Quoter, v3 factory/pool, v2 factory/pair
  discovery/               PoolManager Initialize logs + PoolCreated / PairCreated logs of every configured
                           factory (resume point per venue), liquidity and swap-activity refresh for every
                           kind, persisted in data/pools.<chain>.json; selectTrackedPools picks what to watch
  state/                   per-block state: v4 via extsload, v3 via Multicall3 (slot0/liquidity/tickBitmap/
                           ticks, leading words only), v2 via getReserves; StateCache replays one unfiltered
                           eth_getLogs per block (six topics) and routes each log by emitter
  math/                    exact port of v4 swap math (tick walk) in BigInt, v2 constant product,
                           simulateHop / makeSimulator dispatching on the pool kind
  strategy/                cycle enumeration + optimal input search + ranking; probe.ts quotes hooked
                           pools through V4Quoter on a log-spaced input grid (one JSON-RPC batch)
  exec/                    executor calldata by kind, next-block base fee from the header's extraData,
                           on-chain simulation, priority-fee policy, WebSocket head source with stall
                           watchdog, circuit breaker + rolling gas budget, nonce management, sending
  main.ts                  wiring + block loop
  cli/                     one-shot tools (discover, scan)
```

## Data flow per block

1. A new head arrives: every configured WebSocket endpoint's `newHeads` race and are
   de-duplicated by number; a watchdog switches to `eth_blockNumber` polling when no
   head arrives for `WS_STALL_MS` (and back when heads resume). A subscription that
   fails or goes silent is re-created with a capped backoff (2 s doubling to 30 s) and
   counts as live again on its first head. Without a WebSocket the bot polls every
   `POLL_INTERVAL_MS`.
2. `StateCache.applyBlock` fetches the block's logs in **one** `eth_getLogs` with no
   emitter filter and six topic0s (v4 Swap / ModifyLiquidity, v3 Swap / Mint / Burn,
   v2 Sync) and routes each log by emitter: swaps and syncs are applied in place
   (v3 protocol fee is ignored, v2 price/tick/liquidity are re-derived from the
   reserves), liquidity changes or a tick leaving the cached window trigger a refetch
   of that pool (`extsload` for v4, Multicall3 for v3/v2). The block header is read
   concurrently; its `extraData` announces the next block's base fee. The same logs
   are handed to the hooked-pool probe, which tracks the `sqrtPriceX96` of the most
   active hooked pools from their `Swap`s.
3. `strategy` evaluates every 2- and 3-hop cycle that touches a changed pool (all
   cycles every 20 blocks). Each hop is simulated with `simulateHop` (v4 / v3 tick
   walk, v2 constant product) and the input that maximises `out - in` is found by a
   grid + golden-section search on a log scale, bounded by `MAX_INPUT_USDC_WEI`
   scaled to the start currency's decimals.
4. Probe: for every touched hooked pool (or touched tracked pool on its pair) whose
   spot price differs from a tracked pool's by more than `PROBE_MIN_SPREAD_BPS`, the
   profitable-looking 2-hop cycle through both is quoted at `PROBE_GRID` log-spaced
   inputs, all `V4Quoter.quoteExactInput` calls of a round packed into one `Multicall3.aggregate3`
   `eth_call` (`PROBE_QUOTE_MODE`; the hooked hop on chain, the tracked hop locally), refined once,
   and merged into the ranking.
   At most `PROBE_MAX_PER_BLOCK` pairs per block, most-spread first.
5. Opportunities are ranked in 18-decimal USDC (one per pool), priced against the
   next base fee and `QUOTE_GAS`, and the top three are simulated on chain with
   `eth_call` of `execute` at the same block (then `eth_estimateGas`). Anything that
   reverts or does not clear `MIN_PROFIT_USDC_WEI` after `GAS_SAFETY` x gas is dropped.
6. The best survivor is sent as an EIP-1559 transaction (tip = `TIP_SHARE` of the
   expected profit, clamped) with `minProfit` and price guards set on chain, so a
   stale opportunity reverts before swapping. One in-flight transaction per block;
   the circuit breaker (`MAX_CONSECUTIVE_REVERTS`) and the rolling gas budget
   (`GAS_BUDGET_USDC_WEI` per `GAS_BUDGET_WINDOW_BLOCKS`) can turn sending off.
   In `DRY_RUN` the plan is logged instead.
7. Receipts are logged with realised profit and gas paid, and fed to the breaker
   and the budget.

## Executor contract

`ArcArbExecutor.execute(steps, amountIn, minProfit, guards)`:

- `steps[i] = {uint8 kind, bool zeroForOne, address pool, PoolKey key}`; the output
  currency of step i must be the input currency of step i+1 and the last output must
  equal the first input (native USDC and the ERC-20 predeploy count as the same money).
  Kind 0 swaps the v4 pool `key`; kind 1 calls `pool.swap` on a v3-style pool and pays
  the callback (only the hop's input currency, never more than the hop's input); kind 2
  computes the v2 output from `getReserves` and `key.fee` pips and calls `pair.swap`.
- Runs inside `PoolManager.unlock`. All swaps are exact-input. v4 hops net inside the
  PoolManager; the input of a v3/v2 hop is `take`n from the PoolManager (a flash loan
  when it is the first hop) and its output is settled back at the end. If the net gain
  in the start currency is `>= minProfit` the contract keeps it, otherwise it reverts.
  PoolManager itself reverts if any other currency has a non-zero delta.
- `guards[i] = {kind, poolId, expected, toleranceBps}` are checked before any swap:
  kind 0 compares the v4 pool's `sqrtPriceX96`, kind 1 a v3 pool's `slot0` price, kind 2
  a v2 pair's `sqrt(reserve1 / reserve0) * 2^96`; a move beyond `toleranceBps` reverts
  `StaleState` cheaply (someone else took the opportunity).
- Roles: `owner` (withdraws profit, rotates keys, emergency call) and `operator`
  (the bot's hot key, may only call `execute`). Keep the owner key cold.
- Native USDC (currency `address(0)`, 18 decimals) and the ERC-20 USDC predeploy
  (`0x3600…0000`, 6 decimals) are different currencies to v4. The contract handles
  both: it has a `receive()` for native `take`s and `withdraw` uses v4's
  `CurrencyLibrary` which transfers either kind.

## Safety defaults

- `DRY_RUN=true` by default: everything runs, nothing is sent.
- Pools with hooks are never simulated locally (hooks can change fees or deltas in
  ways the tick-walk does not model). They are only traded when priced fresh, in the
  same block, by the on-chain `V4Quoter` (the probe) and then re-simulated through the
  executor; `ALLOWED_HOOKS` can additionally allow-list hooks for local simulation.
- After `MAX_CONSECUTIVE_REVERTS` reverted or lost transactions sending pauses for
  `BREAKER_PAUSE_BLOCKS`; once `GAS_BUDGET_USDC_WEI` of gas was paid within
  `GAS_BUDGET_WINDOW_BLOCKS` the bot only dry-runs until the window rolls.
- `minProfit` is enforced both off-chain and on-chain.
- Gas price capped by config; total in-flight exposure limited to one tx per block.
- Private key is read from the environment only; never logged.

## Latency notes

Arc blocks are ~500 ms and final on inclusion. The critical path is
`newHeads -> logs + header -> probe quotes -> search -> eth_call -> send`. Run the
bot close to an RPC provider with WebSocket support, keep the tracked pool set
small (only pools with liquidity), and prefer a provider endpoint over the public
RPC, which is rate limited at roughly 10 requests/s ("Request exceeds defined
limit." / HTTP 429 / -32005). Measured in dry-run on the public gateway with 571
tracked pools (547 v4, 21 v3, 3 v2) and 62 probed hooked pools: the log fetch takes
~80-250 ms per block and a probe round ~150-250 ms. With `PROBE_QUOTE_MODE=batch`
every quoter `eth_call` counts against the limit (gateways rate-limit each entry of a
JSON-RPC batch, and cap batches at 3-100 per provider), so with the default probe
budget (up to 4 pairs x 5 grid points x 2 rounds per block) the loop falls to every
second or third block; with `PROBE_MAX_PER_BLOCK=1 PROBE_GRID=3` it keeps up with
consecutive blocks most of the time. The default `PROBE_QUOTE_MODE=multicall` packs
a round's quotes into one `Multicall3.aggregate3` `eth_call` (split above 150 quotes),
so a round is one request whatever the grid: the quoter's own reverts
(`NotEnoughLiquidity`, `UnexpectedRevertBytes`) come back per sub-call with
`success=false` and are decoded as in batch mode. Rate-limited quoter calls are
re-issued once or twice with short waits, and the per-block log fetch retries briefly
and otherwise lets the next head replay the gap.
