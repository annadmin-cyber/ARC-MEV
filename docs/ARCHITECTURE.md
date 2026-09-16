# Architecture

This repo is a **state-based arbitrage MEV bot for Arc** (Circle's stablecoin L1,
chain id 5042). It watches Uniswap v4 pools on Arc, finds price discrepancies
between pools after every block, and captures them atomically in one
transaction using v4 flash accounting, so the bot needs **no trading capital**,
only USDC for gas.

## Why this strategy and not a sandwich bot

Arc has no public mempool. Blocks are produced every ~500 ms by a permissioned
validator set and transactions are not visible before they are included.
Sandwiching (jaredfromsubway-style) depends on seeing a victim's pending swap
and wrapping it; that is impossible here. What *is* possible:

| Strategy | Feasible on Arc | Status in this repo |
|---|---|---|
| Cyclic arbitrage across pools after each block ("backrun on state") | yes | implemented |
| UniswapX Dutch-order filling (reactor is deployed on Arc) | yes | planned (strategy interface is ready for it) |
| Liquidations | once a lending protocol deploys | planned |
| Sandwiching / frontrunning | no public mempool | not possible |

## Components

```
contracts/                 Foundry project
  src/ArcArbExecutor.sol   on-chain executor: runs a closed cycle of v4 swaps inside
                           PoolManager.unlock, reverts unless profit >= minProfit
  test/                    unit tests against a locally deployed PoolManager

src/                       TypeScript bot (viem)
  config.ts                env + zod config, dry-run by default
  chains.ts                Arc mainnet / testnet chain definitions
  abi/                     ABIs for PoolManager, StateView, Multicall3, executor
  discovery/               scans PoolManager Initialize logs, persists data/pools.<chain>.json
  state/                   fetches slot0 / liquidity / tick data for tracked pools each block
  math/                    exact port of v4 swap math (tick walk) in BigInt
  strategy/                cycle enumeration + optimal input search + opportunity ranking
  exec/                    eth_call simulation, gas policy, nonce management, sending
  main.ts                  block loop
  cli/                     one-shot tools (discover, scan)
```

## Data flow per block

1. `newHeads` arrives over WebSocket (fallback: HTTP polling every 250 ms).
2. `state/reader` refreshes every tracked pool in as few RPC calls as possible
   (Multicall3 batch of StateView reads: slot0, liquidity, tick bitmap words around
   the current tick, and the `liquidityNet` of the initialised ticks in that window).
3. `strategy/cycles` evaluates every 2-pool and 3-pool cycle in the token graph.
   For each cycle it runs the local swap simulator (`math/simulate`) and searches
   the input amount that maximises `out - in` (golden-section search on a log
   scale, bounded by config `maxInput` and by the liquidity actually available).
4. Candidates with expected profit above `minProfit + gasCost * gasSafety` are
   simulated on-chain with `eth_call` against the executor (same block state).
   Anything that reverts or returns less than expected is dropped.
5. The best surviving opportunity is sent as an EIP-1559 transaction to the
   executor with `minProfit` set on-chain, so a stale opportunity reverts instead
   of losing money. One in-flight transaction per block.
6. Receipts are logged with realised profit, gas paid, and inclusion latency.

## Executor contract

`ArcArbExecutor.execute(steps, amountIn, minProfit)`:

- `steps[i] = {PoolKey key, bool zeroForOne}`; the output currency of step i must be
  the input currency of step i+1 and the last output must equal the first input.
- Runs inside `PoolManager.unlock`. All swaps are exact-input. Because every swap
  happens in the same unlock, the intermediate deltas cancel and only the net delta
  of the start currency remains. If it is `>= minProfit` the contract `take`s it,
  otherwise it reverts. PoolManager itself reverts if any other currency has a
  non-zero delta, which is a free safety net.
- Roles: `owner` (withdraws profit, rotates keys, emergency call) and `operator`
  (the bot's hot key, may only call `execute`). Keep the owner key cold.
- Native USDC (currency `address(0)`, 18 decimals) and the ERC-20 USDC predeploy
  (`0x3600…0000`, 6 decimals) are different currencies to v4. The contract handles
  both: it has a `receive()` for native `take`s and `withdraw` uses v4's
  `CurrencyLibrary` which transfers either kind.

## Safety defaults

- `DRY_RUN=true` by default: everything runs, nothing is sent.
- Pools with hooks are ignored unless the hook address is allow-listed
  (hooks can change fees or deltas in ways the local simulator does not model).
- `minProfit` is enforced both off-chain and on-chain.
- Gas price capped by config; total in-flight exposure limited to one tx per block.
- Private key is read from the environment only; never logged.

## Latency notes

Arc blocks are ~500 ms and final on inclusion. The critical path is
`newHeads -> state refresh -> search -> eth_call -> send`. Run the bot close to an
RPC provider with WebSocket support, keep the tracked pool set small (only pools
with liquidity), and prefer a provider endpoint over the public RPC, which is
rate limited (HTTP 429 observed at ~10 req/s during discovery).
