# Arc mainnet research notes (2026-09-16, launch day)

Everything here was verified against `https://rpc.mainnet.arc.io` and the other public endpoints,
against the `circlefin/arc-node` sources, or against Foundry fork tests, unless marked otherwise.
These notes drive the design decisions in `ARCHITECTURE.md`.

## Chain

| Fact | Value |
|---|---|
| Chain id | 5042 (0x13b2) |
| Node software | arc-node v0.8.0 (reth v2.2.0 execution, Malachite BFT consensus) |
| Block time | ~0.5 s measured (min 210 / p50 525 / max 784 ms between heads) |
| Finality | single confirmation; `safe` == `finalized` == `latest`; no reorgs |
| Validators | 17 proposers rotating round-robin (genesis config lists 11) |
| Genesis | 2026-05-12; ~21.17M blocks at public launch (the chain ran privately for 4 months) |
| Block gas limit | 30M; per-transaction cap 16,777,216 (EIP-7825) |
| EVM | Osaka baseline plus EIP-7702 (type-4 txs live) and EIP-7708; PUSH0, TSTORE, MCOPY work; PREVRANDAO = 0; blob txs rejected |
| Timestamps | 1-second granularity, two or three blocks share a timestamp; order by block number |

## Gas and fees

- Gas is native USDC with 18 decimals. Base fee **and** priority fee go to the proposer; nothing is burned.
- Base fee is EIP-1559 with EWMA smoothing: floor 20 gwei, cap 20,000 gwei, observed 63–250 gwei on
  launch day at 35–95% utilisation. The **next block's base fee is published in the parent header's
  `extraData` as an 8-byte big-endian integer** (verified 199/199 blocks). Use it instead of guessing.
- `eth_maxPriorityFeePerGas` returns 0 everywhere. `eth_feeHistory` reward percentiles work.
- Transactions with `maxFeePerGas` below 20 gwei are silently dropped. There is no cap on tips;
  a 50,000 gwei tip has been included.
- Real tips: median 20 gwei, ~18% pay zero. Top-of-block bots pay 500–10,000+ gwei
  (0.7–4 USDC per tx for ~200–450k gas). Reverted top-of-block bot transactions are common.

## Ordering and the MEV surface

- **No public mempool.** `txpool_*`, `eth_pendingTransactions`, pending filters and
  `eth_subscribe("newPendingTransactions")` are refused on every public endpoint. arc-node hides them
  by default (`--public-api`) "as a potential MEV vector"; RPC providers are contractually barred from
  txpool/debug/trace/flashbots/mev namespaces and bundle APIs, and gossip transactions only to
  Circle-provided sentries (`--tx-propagation-policy Trusted`).
- **Blocks are sorted by descending effective tip** (`min(maxPriorityFeePerGas, maxFeePerGas - baseFee)`).
  The payload builder is reth's `CoinbaseTipOrdering` with no reordering and no bundles; the only
  exception is per-sender nonce chains. Verified empirically on 15 multi-transaction blocks.
- Ties fall back to arrival order at the proposer's node. The proposer of block N+1 is deterministic
  (`(height-1+round) % validators`); `block.miner` cycles with period 17.
- reth keeps ingesting transactions while building, so a late high-tip transaction can still land
  ahead of not-yet-yielded ones. Replacement needs a 10% bump and the window is tens of ms.
- **No revert protection.** A losing arbitrage still executes, reverts, and pays base fee plus its
  full tip on the gas used. The executor therefore checks price guards before any swap.
- Consequences for strategy: sandwiching is impossible for an outside bot; state-based backrunning
  (react to block N, land first in block N+1 by tip) is the game. Also feasible: UniswapX Dutch-order
  filling (reactor deployed), liquidations once lending arrives, stablecoin FX backruns.

## USDC: two views of one balance

- Native balance (18 decimals, `msg.value`, `eth_getBalance`) and the ERC-20 predeploy at
  `0x3600000000000000000000000000000000000000` (6 decimals) are the **same balance**:
  `balanceOf(x) == eth_getBalance(x) / 1e12` exactly. There is no wrap/unwrap; an ERC-20 transfer
  moves the native balance (via the system contract at `0x1800…0000`, which Foundry forks cannot run).
- Every native movement emits an 18-decimal `Transfer` log from `0xffff…fffe` (EIP-7708).
- Uniswap v4 treats `address(0)` and `0x3600…` as different currencies. 77% of new pools quote in the
  ERC-20 form, ~2% in native. A native/ERC-20 USDC pool exists (fee 0.5%, spacing 40, id `0x4baba711…`)
  and any deviation from 1e-12 in it is a riskless arbitrage, which the executor's USDC-form bridging
  captures.
- Value sent to `address(0)` or to the Arc `0x1800…` precompiles reverts. Blocklisted addresses revert.

## Uniswap v4 on Arc

| Contract | Address |
|---|---|
| PoolManager (canonical v4.0.0 bytecode) | `0x8366a39CC670B4001A1121B8F6A443A643e40951`, deployed block 1,948,056 |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| V4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| PositionManager | `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B` |
| UniversalRouter | `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| UniswapX V3DutchOrderReactor / OrderQuoter | `0x0000000015134054eA82AE0bb9fda66b36402C36` / `0x00000000a3db63Df9078cBF3dF88B4CAdD5a7F58` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

- Protocol fee controller is unset: protocol fee is 0 on every pool.
- 48k pools initialised, ~24.5k with liquidity, ~4.3k of those hookless. ~1 new pool per block on
  launch day; 46k swaps per 2,000 blocks across ~2k pools (up to 90 swaps per block).
- Launchpad hook families (`…2044` = afterSwap + afterSwapReturnsDelta, `…e0cc`/`…20cc` = before and
  after swap with return deltas) can take part of the output and cannot be priced with vanilla math.
  Price them only through `V4Quoter.quoteExactInput` (multi-hop in one call) and enforce `minProfit`.
- `eth_call` without `gasPrice` runs with `BASEFEE = 0` on reth.

## DEX census (full log scans from the deploy blocks)

| Venue | Where | Size |
|---|---|---|
| Uniswap v4 | PoolManager above | 49.6k pools initialised, 25.4k with liquidity, 21k of those hooked. 22.7k quote in ERC-20 USDC, 2.2k in native USDC. 17.9k use the 1%/200 launchpad tier |
| Uniswap v3 (official) | factory `0xf0db7b58379503491d857db50ac9ece64c653918` (block 1,948,019), QuoterV2 `0x7dfd4f31be6814d2906bde155c3e1b146eac1468`, SwapRouter02 `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77` | 16.3k pools, 12.6k with liquidity, $13.65M real stable/BTC balances, $10.9M of it in ONE pool: cirBTC/USDC 0.01% `0x82916bee18fcef517b26c72d7cb5f13694e1db41`. Only 40 pools hold ≥ $10k |
| Uniswap v2 (official) | factory `0x89e5db8b5aa49aa85ac63f691524311aeb649eba`, Router02 `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | 310 pairs, 289 hold < $1. USDC/"USDT" pair $130k (the "USDT" is an unverified 18-decimal token) |
| Aero CL (Slipstream-style clones) | factory `0xb89df768af2cfe637ceb352c587fe8edaf491d03` | 6 pools; USDC/EURC `0xbe080ac3…` and cirBTC/USDC `0xd945caee…` live; swap with the v3 pool interface |
| DYORSwap (v2 fork) | factory `0x942bd5bfdc5317c5507e326f8eb4bb6058ab5c10` (block 4,130,418) | 48 pairs; ARCAT/USDC $83k |
| Launchpads on v4 hooks | hooks `0xb6a6…e0cc` (1,297 pools), `0x20ee…6acc` (1,094), aka.fun native-USDC pools | where the launch-day volume is |
| Lending | Aave V4 MAIN_SPOKE `0xB843bdC3a87A05E77E07Df9FE48928b3A34b134d`, Morpho Blue `0x34CD04070dD72b14E241112F6d83812Df5Af7fCD` (11 markets) | tiny borrow today; liquidations not worth building around yet |

- There is **no wrapped native token**: Uniswap's routers point WETH9 at a 53-byte reverting stub.
  Native-USDC pools must be swapped through the PoolManager with `msg.value`.
- Market-maker hooks (`0x285f3cc5…`, `0x16e40ea8…`, `0x58f2cee5…`, `0x50e4e362…`, fee 0 with
  beforeSwap + afterSwapReturnsDelta) run the deepest USDC/EURC, CRCL/USDC and cirBTC/USDC v4 pools.
  Their fees are charged by the hook, so price them only through `V4Quoter` or an `eth_call` of the
  executor. The v4 USDC/EURC 375/4 pool `0xc6e1605e…` shows huge liquidity but the quoter reverts in
  both directions; rank pools by quoted depth, never by raw liquidity.
- Cross-venue spreads at the snapshot: USDC/EURC 0.24% across 8 pools, cirBTC/USDC 0.50%, CRCL/USDC
  up to 8% including 1%–10% fee outliers. Thin but real.
- Tokens: EURC `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`, cirBTC (8 dec)
  `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0`, CRCL `0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b`
  (18 dec, "Circle Internet Group • Arc Token", issuer unknown), USYC has zero supply.
- Aggregators with code: KyberSwap MetaAggregationRouterV2, OpenOcean, 0x AllowanceHolder. Pyth oracle
  proxy `0x2880aB155794e7179c9eE2e38200202908C17B43`.
- Testnet has none of the official Uniswap deployments; a community PoolManager
  `0x2756F3F7bFAf103F4c550f4d24CdCa82B093240A` has 124 pools, all empty. Test on a mainnet fork.

## Other venues seen on chain (first pass)

- A Uniswap-v3-style factory at `0xf0db7b58379503491d857db50ac9ece64c653918` has active pools (fee
  tiers 100 and 10000 seen); top-of-block winners arbitrage v4 against these pools.
- A v2-style factory (WarpDex) at `0x32330c2400a6e0830d56661169ebb6c147e3577a`.
- EURC `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`, USYC `0x8a5D989Bbb96929F689B0200f435f53dA42bF490`.
- CCTP v2 TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` (domain 26) for bridging USDC in.

## RPC endpoints

| Endpoint | Notes |
|---|---|
| `https://rpc.mainnet.arc.io`, `wss://rpc.mainnet.arc.io/ws` | official gateway ("arc/v1"); `newHeads` and `logs` work on the WS; rate limits `eth_getLogs` hard |
| `https://rpc.blockdaemon.mainnet.arc.io`, `wss://…/websocket` | reth exposed directly, no key today; getLogs capped at 20k results; returns revert data on `eth_call` |
| `https://rpc.drpc.mainnet.arc.io`, `wss://rpc.drpc.mainnet.arc.io` | free tier has `debug_traceCall`, `eth_simulateV1`, `eth_createAccessList`; returns revert data |
| `https://rpc.quicknode.mainnet.arc.io`, `wss://…` | same gateway behaviour as official |
| `https://arc-mainnet.g.alchemy.com/v2/KEY` | key required |

- `eth_getLogs`: 10,000-block range cap (`-32012`), 20,000-result cap (`-32602`, "retry with the range
  a-b"), rate limit as JSON-RPC `-32005` with HTTP 200 as well as HTTP 429. Querying a block the node
  does not have yet gives `-32014` / `-32001`.
- `eth_getBlockReceipts`, `eth_feeHistory` and `eth_call` state overrides work on the official gateway.
- Broadcast signed transactions to several endpoints at once; each forwards to Circle's sentries
  independently.

## Tooling

- **viem 2.56.5** ships an `arc` chain but with an empty RPC list and no multicall3 entry, so this repo
  defines its own chain objects. viem's fee estimator calls `eth_maxPriorityFeePerGas` (returns 0 on
  Arc); always set `maxPriorityFeePerGas` explicitly.
- **Foundry** builds and deploys fine (`evm_version = "cancun"` is safe). Stock `anvil --fork-url` runs
  a vanilla EVM: no Arc precompiles at `0x1800…`, no EIP-7708 logs, no blocklist or zero-address rules,
  so ERC-20 USDC transfers fail on a stock fork. Circle publishes **Arc Foundry**
  (`github.com/circlefin/arc-foundry`: `arc-forge`, `arc-cast`, `arc-anvil`) with Arc semantics;
  use `arc-anvil --fork-url` for realistic fork tests.
- Contract verification on mainnet Blockscout is blocked by Cloudflare; verify on testnet
  (`--verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/`) or via the web form.
- Funding: testnet faucet `faucet.circle.com` (20 USDC / 2 h). Mainnet: bridge USDC with CCTP v2
  (destination domain 26) or Circle's bridge kit; remember bridged USDC is also the gas budget.

## Explorer and tooling (first pass)

- `explorer.arc.io` is Blockscout behind a Cloudflare challenge ("permissioned"); the testnet explorer
  API is open (`--verifier blockscout --verifier-url https://explorer.testnet.arc.io/api/`).
- Testnet: chain 5042002, `https://rpc.testnet.arc.io`, faucet `https://faucet.circle.com`. The mainnet
  Uniswap v4 addresses are not deployed on testnet.
- Running a follower node is permissionless (`circlefin/arc-node`, ~250 GB snapshot) but gives no
  mempool visibility; its value is unthrottled local reads.
