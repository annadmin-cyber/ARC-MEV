# ARC-MEV

An arbitrage MEV bot for **Arc**, Circle's stablecoin Layer 1 (chain id 5042, mainnet live since
2026-09-16). It watches Uniswap v4 pools on Arc, finds price gaps between pools after every
~500 ms block, and captures them in one atomic transaction using v4 flash accounting. The bot
needs **no trading capital**: the only money it spends is USDC for gas, and profit lands in a
contract that only your cold key can withdraw from.

> **Why not a sandwich bot?** Arc has no public mempool. Its validators are permissioned and the
> RPC nodes refuse every pending-transaction API. Nobody outside the validator set can see a trade
> before it lands, so jaredfromsubway-style sandwiching is impossible here. What works is
> "backrunning on state": everyone sees the new block at the same time, and the fastest,
> highest-bidding bot captures the price gap in the next block. Arc orders transactions by
> priority fee, so this is a plain gas auction. See `docs/ARCHITECTURE.md`.

## What is in the box

| Path | What |
|---|---|
| `contracts/src/ArcArbExecutor.sol` | On-chain executor: runs a closed cycle of v4 swaps inside `PoolManager.unlock`, reverts unless profit ≥ `minProfit`, with cheap price guards that abort before any swap if someone beat you to it. |
| `contracts/test/` | 18 Foundry tests (ERC-20 and native-USDC cycles, 3-hop cycles, guards, access control). |
| `src/` | TypeScript bot (viem): discovery, per-block state cache, exact v4 swap math, cycle search, sizing, on-chain simulation, priority-fee bidding, sending. |
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

# 1. Discover pools (one-time; resumes if interrupted; ~10 min on the public RPC)
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
   `WS_URL` (provider WebSocket), optionally `SEND_RPC_URLS` (extra endpoints that also receive
   your signed transaction), and finally `DRY_RUN=false`.
4. **Run it.** `npm run bot`. Keep `LOG_LEVEL=info`; use `debug` to see per-block timings.
5. **Collect profit.** Profit accumulates in the executor. From the owner key:
   `cast send $EXECUTOR "sweep(address,address)" 0x3600000000000000000000000000000000000000 $OWNER`
   (use `0x0000000000000000000000000000000000000000` for native USDC).

## Configuration

Everything is in `.env` (see `.env.example` for defaults and comments). The knobs that matter:

| Variable | Meaning |
|---|---|
| `MIN_PROFIT_USDC_WEI` | Minimum net profit after gas, in 18-decimal USDC wei. |
| `MAX_INPUT_USDC_WEI` | Largest trade size the optimiser may pick. |
| `TIP_SHARE`, `MAX_PRIORITY_FEE_WEI`, `MIN_PRIORITY_FEE_WEI` | How aggressively to bid in the priority-fee auction. Arc sorts blocks by tip; top-of-block tips are hundreds of gwei. |
| `GAS_SAFETY` | Multiplier on estimated gas cost before it is subtracted from expected profit. A losing race still pays gas. |
| `GUARD_TOLERANCE_BPS` | Price tolerance for the on-chain guards. Smaller = cheaper failures, more false aborts. |
| `MAX_TRACKED_POOLS`, `MIN_POOL_LIQUIDITY`, `ALLOWED_HOOKS` | Which pools to watch. Hooked pools are skipped unless allow-listed because hooks can change fees or deltas the local simulator cannot model. |
| `START_CURRENCIES` | Currencies a cycle may start and end in (profit currency), with decimals. Default: native USDC (18) and ERC-20 USDC (6). |

## Risks you should understand

- **Losing races costs gas.** There are no bundles or revert protection on Arc. If another bot
  lands first, your transaction still executes, hits the price guard, reverts, and pays gas for the
  work done up to that point (the guard is checked first, so that is cheap, but not free).
- **Hooks.** Most pools created on launch day have hooks (memecoin launchpads). They are excluded by
  default for a reason.
- **Native vs ERC-20 USDC.** They are different currencies to Uniswap v4 (18 vs 6 decimals). The bot
  handles both, but do not mix them up when funding or sweeping.
- **This is early software on a chain that launched today.** Run it in dry-run mode for a while, read
  the logs, and start with small `MAX_INPUT_USDC_WEI`.

## Development

```bash
npm run typecheck && npm test        # TypeScript
cd contracts && forge test           # Solidity
```
