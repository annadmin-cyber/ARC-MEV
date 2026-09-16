# ARC-MEV

An arbitrage MEV bot for **Arc**, Circle's stablecoin Layer 1 (chain id 5042, mainnet live since
2026-09-16). It watches Uniswap v4 pools, Uniswap v3 pools and Uniswap v2 / DYORSwap pairs on Arc,
finds price gaps between them after every ~500 ms block, and captures them in one atomic
transaction (v4 flash accounting plus a PoolManager flash loan for the v3/v2 hops). Hooked v4
pools, which cannot be simulated locally, are priced every block through Uniswap's on-chain
`V4Quoter`. The bot needs **no trading capital**: the only money it spends is USDC for gas, and
profit lands in a contract that only your cold key can withdraw from.

> **Why not a sandwich bot?** Arc has no public mempool. Its validators are permissioned and the
> RPC nodes refuse every pending-transaction API. Nobody outside the validator set can see a trade
> before it lands, so jaredfromsubway-style sandwiching is impossible here. What works is
> "backrunning on state": everyone sees the new block at the same time, and the fastest,
> highest-bidding bot captures the price gap in the next block. Arc orders transactions by
> priority fee, so this is a plain gas auction. See `docs/ARCHITECTURE.md`.

## What is in the box

| Path | What |
|---|---|
| `contracts/src/ArcArbExecutor.sol` | On-chain executor: runs a closed cycle of v4 / v3-style / v2-style swaps inside `PoolManager.unlock`, reverts unless profit ≥ `minProfit`, with cheap per-kind price guards that abort before any swap if someone beat you to it. |
| `contracts/test/` | Foundry tests (ERC-20 and native-USDC cycles, 3-hop and cross-venue cycles, flash-loaned v3/v2 hops, hostile callbacks, guards of every kind, access control) plus calldata / math vectors shared with the TypeScript tests. |
| `src/` | TypeScript bot (viem): multi-venue discovery, per-block state cache (one `eth_getLogs` per block routed by emitter), exact v4/v3 tick-walk and v2 math, cycle search, sizing, hooked-pool probing through `V4Quoter`, on-chain simulation, priority-fee bidding from the header's announced next base fee, circuit breaker and gas budget, sending. |
| `docs/` | Architecture, implementation spec, research notes on Arc. |

## Requirements

- Node.js 22+
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for deploying the contract)
- An Arc RPC endpoint. The public `https://rpc.mainnet.arc.io` works for trying things out but is
  rate-limited. For real use get a provider endpoint with WebSocket support (QuickNode, Alchemy,
  Blockdaemon, dRPC all serve Arc).

## Quick start (dry run, no keys, no money)

```bash
git clone --recurse-submodules <this repo>
cd ARC-MEV
npm install
cp .env.example .env            # defaults are safe: DRY_RUN=true

# 1. Discover pools (one-time; resumes if interrupted; ~10 min on the public RPC for the
#    PoolManager history plus ~5 min for the v3/v2 factories; later runs only scan new blocks)
npm run discover

# 2. Look at the current opportunities once
npm run scan

# 3. Run the bot in dry-run mode: it evaluates every block and logs what it *would* send
npm run bot
```

## Going live

1. **Create two keys.** An *owner* key (cold, holds profit) and an *operator* key (hot, on the bot
   machine, holds only gas money). Fund the operator with a few USDC on Arc. USDC is the gas token;
   bridge it in with Circle's CCTP from Ethereum, Base, Solana, etc.
2. **Deploy the executor.**
   ```bash
   cd contracts
   forge build
   OWNER=0xYourColdKey OPERATOR=0xYourHotKey \
   forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.arc.io \
     --private-key $DEPLOYER_KEY --broadcast
   ```
   Note the printed executor address.
3. **Configure the bot.** In `.env` set `EXECUTOR_ADDRESS`, `PRIVATE_KEY` (the operator key),
   `WS_URL`, `RPC_URL` and `SEND_RPC_URLS` as in the endpoint table below, and finally
   `DRY_RUN=false`. Start with `MAX_INPUT_USDC_WEI` at a few hundred USDC and the default
   `GAS_BUDGET_USDC_WEI` (5 USDC per hour) until you have seen a few real receipts.
4. **Run it.** `npm run bot`. Keep `LOG_LEVEL=info`; use `debug` to see per-block timings.
5. **Collect profit.** Profit accumulates in the executor. From the owner key:
   `cast send $EXECUTOR "sweep(address,address)" 0x3600000000000000000000000000000000000000 $OWNER`
   (use `0x0000000000000000000000000000000000000000` for native USDC).

## Which endpoints to use

Measured on launch day (details in `docs/ARC_RESEARCH.md`):

| Job | Use | Why |
|---|---|---|
| New blocks | `WS_URL=wss://rpc.mainnet.arc.io/ws` | delivered first for 87% of blocks; add Blockdaemon/QuickNode in `WS_URLS` as spares |
| Reads and simulation (`RPC_URL`) | `https://rpc.blockdaemon.mainnet.arc.io` or `https://rpc.drpc.mainnet.arc.io` | the official gateway's HTTP path lags its own WebSocket by ~300 ms and rate-limits hard; these two return revert data on `eth_call` |
| Sending (`SEND_RPC_URLS`) | `https://rpc.mainnet.arc.io,https://rpc.blockdaemon.mainnet.arc.io` | fastest send path plus a second route; the gateway allows about one send per second, Blockdaemon showed no limit |

The reaction budget from a new head to having your transaction on the wire is roughly 150–200 ms
if you want it in the very next block. Host the bot in US-East and keep the tracked pool set small.

## Configuration

Everything is in `.env` (see `.env.example` for defaults and comments). The knobs that matter:

| Variable | Meaning |
|---|---|
| `MIN_PROFIT_USDC_WEI` | Minimum net profit after gas, in 18-decimal USDC wei. |
| `MAX_INPUT_USDC_WEI` | Largest trade size the optimiser may pick. |
| `TIP_SHARE`, `MAX_PRIORITY_FEE_WEI`, `MIN_PRIORITY_FEE_WEI` | How aggressively to bid in the priority-fee auction. Arc sorts blocks by tip; top-of-block tips are hundreds of gwei. |
| `GAS_SAFETY` | Multiplier on estimated gas cost before it is subtracted from expected profit. A losing race still pays gas. |
| `GUARD_TOLERANCE_BPS` | Price tolerance for the on-chain guards. Smaller = cheaper failures, more false aborts. |
| `MAX_TRACKED_POOLS`, `MIN_POOL_LIQUIDITY`, `ALLOWED_HOOKS` | Which pools to watch (every venue). Liquidity `L` scales with `sqrt(units0 * units1)`, so the default minimum is 1e8: the deepest pool on Arc (cirBTC/USDC 0.01% v3, 8 x 6 decimals, ~$10M) has `L` ≈ 4e11 while an 18-decimal pair with $130k has ≈ 1.6e18; v2 pairs count `isqrt(reserve0 * reserve1)`. Hooked pools are never simulated locally unless allow-listed; they go through the probe instead. |
| `START_CURRENCIES` | Currencies a cycle may start and end in (profit currency), with decimals. Default: native USDC (18) and ERC-20 USDC (6). |
| `QUOTE_GAS` | Gas assumed when pricing an opportunity before `eth_estimateGas` has run (default 400k; a 2-hop v4 cycle uses ~150k, a v3 hop ~200k cold). |
| `PROBE_HOOKED_POOLS`, `PROBE_MAX_PER_BLOCK`, `PROBE_MIN_SPREAD_BPS`, `PROBE_GRID` | Hooked-pool probing: when a probed hooked pool (or a tracked pool on its pair) trades and the spot prices differ by more than the spread, the 2-hop cycle is quoted through `V4Quoter` at `PROBE_GRID` log-spaced inputs in one JSON-RPC batch, at most `PROBE_MAX_PER_BLOCK` pairs per block. Every quote is one `eth_call` against your RPC's rate limit: on the public gateway use `PROBE_MAX_PER_BLOCK=1 PROBE_GRID=3`; keep the defaults (4 / 5) on a provider endpoint. |
| `WS_URL`, `WS_URLS`, `WS_STALL_MS`, `POLL_INTERVAL_MS` | Head source: every WebSocket endpoint's `newHeads` race (de-duplicated by block number); no head for `WS_STALL_MS` switches to `eth_blockNumber` polling until heads resume. Without any WebSocket the bot polls. |
| `MAX_CONSECUTIVE_REVERTS`, `BREAKER_PAUSE_BLOCKS` | Circuit breaker: after that many reverted or lost transactions in a row, sending pauses for that many blocks (a run of failures usually means the model is off). |
| `GAS_BUDGET_USDC_WEI`, `GAS_BUDGET_WINDOW_BLOCKS` | Rolling gas budget: once that much gas (18-decimal USDC wei) was paid within the window, the bot only dry-runs until enough spending rolls out of it. |

## What has been verified (and what has not)

Everything below was run against Arc mainnet in **dry-run mode, without keys and without ever
sending a transaction**. No executor has been deployed by this repo's authors and no live send has
been tested; the contract is exercised only by its Foundry tests.

- Discovery of all three venues (Uniswap v4 PoolManager, Uniswap v3 factory, Uniswap v2 and
  DYORSwap factories), liquidity and activity refresh for every kind, and `npm run scan` /
  `npm run bot` over a store of 33.6k pools (28.3k v4, 5.1k v3, 285 v2) with 571 tracked pools and
  62 probed hooked pools: consecutive blocks were processed with v4, v3 and v2 state updates
  applied from logs, probes ran every block and opportunities of every kind (v4>v4, v3>v4, hooked
  v4>v4) were found, sized, priced and reported.
- The local v3 simulator matched the on-chain QuoterV2 to the wei for 1,000 USDC, 100,000 USDC and
  0.05 cirBTC through the cirBTC/USDC 0.01% pool; the v2 derivation matched the pair's reserves.
- Executor calldata is byte-identical to Solidity `abi.encodeCall` for a v4-only and a mixed
  v4 + v3 + v2 plan (checked-in vectors).

## Risks you should understand

- **Losing races costs gas.** There are no bundles or revert protection on Arc. If another bot
  lands first, your transaction still executes, hits the price guard, reverts, and pays gas for the
  work done up to that point (the guard is checked first, so that is cheap, but not free).
- **Hooks.** Most pools created on launch day have hooks (memecoin launchpads). They are never
  simulated locally; the probe only quotes hooks that share a pair with a tracked pool, and the
  market-maker hooks it targets can be paused or reconfigured by their owners at any time. Every
  probed opportunity is re-simulated through the executor before it is sent.
- **Native vs ERC-20 USDC.** They are different currencies to Uniswap v4 (18 vs 6 decimals). The bot
  handles both, but do not mix them up when funding or sweeping.
- **This is early software on a chain that launched today.** Run it in dry-run mode for a while, read
  the logs, and start with small `MAX_INPUT_USDC_WEI`.

## Development

```bash
npm run typecheck && npm test        # TypeScript
cd contracts && forge test           # Solidity
```
