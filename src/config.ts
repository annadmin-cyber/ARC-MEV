import 'dotenv/config'
import { z } from 'zod'
import { isAddress, isHex, type Address, type Hex } from 'viem'

const address = z.string().refine((s): s is Address => isAddress(s), 'invalid address')
const hex = z.string().refine((s): s is Hex => isHex(s), 'invalid hex')
const bigintStr = (def: string) =>
  z
    .string()
    .default(def)
    .refine((s) => /^\d+$/.test(s), 'expected an unsigned integer string')
    .transform((s) => BigInt(s))
const bool = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) => ['1', 'true', 'yes', 'on'].includes(s.toLowerCase()))
/** dotenv parses `KEY=` (a common way to leave a setting unset) as the empty string: treat it as absent. */
const optional = <T extends z.ZodTypeAny>(inner: T) => z.preprocess((v) => (v === '' ? undefined : v), inner.optional())

const schema = z.object({
  CHAIN_ID: z.coerce.number().int().default(5042),
  RPC_URL: z.string().url().default('https://rpc.mainnet.arc.io'),
  /** JSON-RPC batch size for the main HTTP client; 0 (default) sends single requests. Keep 0 on
   *  dRPC (rejects batches) and on the official gateway (throttles batch entries). */
  RPC_BATCH: z.coerce.number().int().min(0).max(100).default(0),
  /** Optional WebSocket endpoint for newHeads; falls back to HTTP polling when absent. */
  WS_URL: optional(z.string().url()),
  /** Extra WebSocket endpoints (comma-separated) whose `newHeads` race with `WS_URL`; heads are de-duplicated by number. */
  WS_URLS: z.string().default(''),
  /** No head over WebSocket for this many ms -> fall back to HTTP polling until heads resume. */
  WS_STALL_MS: z.coerce.number().int().min(100).default(3000),
  /** Bot hot key. Only needed when DRY_RUN=false. */
  PRIVATE_KEY: optional(hex),
  /** Deployed ArcArbExecutor. Only needed for on-chain simulation and sending. */
  EXECUTOR_ADDRESS: optional(address),

  DRY_RUN: bool('true'),
  /** Minimum net profit (after gas) in USDC wei (18 decimals). Default 0.15 USDC: on launch day 16% of
   *  winning arbs were net-negative after their own fee, and the median win netted 0.13 USDC. */
  MIN_PROFIT_USDC_WEI: bigintStr('150000000000000000'),
  /** Largest input the optimizer may try, in USDC wei. Default 5,000 USDC. */
  MAX_INPUT_USDC_WEI: bigintStr('5000000000000000000000'),
  /** Multiply the estimated gas cost by this before comparing to profit. */
  GAS_SAFETY: z.coerce.number().default(1.5),
  /** Hard cap on maxFeePerGas in wei. Arc base fee floats (floor 20 gwei, cap 20,000 gwei). Default 25,000 gwei. */
  MAX_FEE_PER_GAS_WEI: bigintStr('25000000000000'),
  /** Priority fee budget as a fraction of expected gross profit. Winners on launch day paid ~6.6% of
   *  gross at the median for 1-10 USDC arbs and slot-0 winners out-bid the best loser 4.8x, so 0.3 is
   *  plenty; 62% of profitable arbs landed at position 5 or later. */
  TIP_SHARE: z.coerce.number().min(0).max(1).default(0.3),
  /** Hard cap on maxPriorityFeePerGas in wei. Slot-0 tips were ~210-330 gwei p50 on launch day, but by
   *  day two the bots taking 1-2 USDC arbs paid 3,000-13,000 gwei. Default 15,000 gwei; the market gate
   *  and MAX_TIP_SHARE decide whether such a bid is affordable for a given opportunity. */
  MAX_PRIORITY_FEE_WEI: bigintStr('15000000000000'),
  /** Largest share of the expected gross profit the tip may consume when the market rate is above the
   *  TIP_SHARE bid. Beyond it the opportunity is skipped as "outbid" instead of sent to lose. Default 0.8. */
  MAX_TIP_SHARE: z.coerce.number().min(0).max(1).default(0.8),
  /** Market tip gate: each block header's transactions reveal the tip the block's winner paid. The gate
   *  requires a send's tip to be at least MARKET_TIP_QUANTILE of the top tips of the last
   *  MARKET_TIP_BLOCKS blocks times MARKET_TIP_MARGIN (raising the bid while MAX_TIP_SHARE affords it,
   *  skipping otherwise). false = bid TIP_SHARE only, as before. */
  MARKET_TIP_GATE: bool('true'),
  MARKET_TIP_BLOCKS: z.coerce.number().int().min(1).max(10_000).default(120),
  /** Live sample (day two, quiet minute): top tips p50 40 gwei, p75 146, p90 830; contested blocks are the
   *  top decile, so 0.9 tracks them while lower quantiles only see the quiet blocks. */
  MARKET_TIP_QUANTILE: z.coerce.number().min(0).max(1).default(0.9),
  MARKET_TIP_MARGIN: z.coerce.number().min(0).default(1.25),
  /** Minimum priority fee in wei. Default 100 gwei (p75 of what lands). */
  MIN_PRIORITY_FEE_WEI: bigintStr('100000000000'),
  /** Extra RPC URLs (comma-separated) that also receive eth_sendRawTransaction, for latency fan-out. */
  SEND_RPC_URLS: z.string().default(''),
  /** sqrtPrice tolerance (bps) for on-chain state guards; 0 disables guards. */
  GUARD_TOLERANCE_BPS: z.coerce.number().int().min(0).default(1),
  /** Upper bound on the gas limit of execute() transactions (used when estimation fails). Bounded by the
   *  intrinsic gas of a transaction and the chain's per-transaction gas cap (`TX_GAS_CAP`). */
  GAS_LIMIT: z.coerce.number().int().min(21_000).max(16_777_216).default(1_500_000),
  /** Gas assumed when quoting profitability before an on-chain estimate exists. A 2-hop v4 cycle
   *  uses ~250-350k gas; keep this close to reality or good opportunities are rejected early. */
  QUOTE_GAS: z.coerce.number().int().min(21_000).default(400_000),

  /** Only pools whose liquidity is at least this are tracked. `L` scales with sqrt(units0 * units1), so a
   *  pool between an 8-decimal and a 6-decimal token (cirBTC/USDC: L ~ 4e11 for $10M) needs a much lower
   *  bar than an 18-decimal pair; v2 pairs store isqrt(reserve0 * reserve1). Default 1e8. */
  MIN_POOL_LIQUIDITY: bigintStr('100000000'),
  /** Max number of pools to refresh per block. */
  MAX_TRACKED_POOLS: z.coerce.number().int().default(300),
  /** Comma-separated hook addresses that are allowed. Empty = only hookless pools. */
  ALLOWED_HOOKS: z.string().default(''),
  /** Comma-separated `address:decimals` of currencies that may start a cycle (profit is measured in these).
   *  Default: native USDC (18 decimals) and the ERC-20 USDC predeploy (6 decimals). */
  START_CURRENCIES: z
    .string()
    .default('0x0000000000000000000000000000000000000000:18,0x3600000000000000000000000000000000000000:6'),
  /** Refetch every tracked pool from scratch every N blocks (safety net for missed logs). */
  FULL_REFRESH_BLOCKS: z.coerce.number().int().min(1).default(200),
  /** How many tick-bitmap words on each side of the current tick to fetch per pool. */
  TICK_WORDS_EACH_SIDE: z.coerce.number().int().min(1).default(2),
  /** HTTP polling interval (ms) when no WS_URL is configured. */
  POLL_INTERVAL_MS: z.coerce.number().int().default(250),

  /** Probe hooked v4 pools (which cannot be simulated locally) through the V4Quoter each block. */
  PROBE_HOOKED_POOLS: bool('true'),
  /** At most this many (hooked pool, tracked pool) pairs are quoted per block, most-spread first. */
  PROBE_MAX_PER_BLOCK: z.coerce.number().int().min(0).default(4),
  /** A hooked pool is probed only when its spot price differs from a tracked pool's by more than this (bps). */
  PROBE_MIN_SPREAD_BPS: z.coerce.number().int().min(0).default(30),
  /** Log-spaced input amounts quoted per probed cycle (one quoter round); a refinement pass follows. */
  PROBE_GRID: z.coerce.number().int().min(2).default(5),
  /** How a block's quoter calls reach the node: `multicall` packs them into one `Multicall3.aggregate3`
   *  `eth_call` (one request whatever the grid; works on every provider), `batch` issues one `eth_call`
   *  per quote in JSON-RPC batches of 20 (the previous behaviour; gateways rate-limit every entry). */
  PROBE_QUOTE_MODE: z.enum(['multicall', 'batch']).default('multicall'),

  /** After this many consecutive reverted or lost transactions, stop sending for BREAKER_PAUSE_BLOCKS. */
  MAX_CONSECUTIVE_REVERTS: z.coerce.number().int().min(1).default(3),
  /** Blocks the circuit breaker keeps sending paused. */
  BREAKER_PAUSE_BLOCKS: z.coerce.number().int().min(1).default(120),
  /** Gas (USDC wei, 18 decimals) the bot may spend per GAS_BUDGET_WINDOW_BLOCKS; beyond it, only dry-runs. Default 5 USDC. */
  GAS_BUDGET_USDC_WEI: bigintStr('5000000000000000000'),
  /** Rolling window (blocks, ~1 h at 500 ms) over which GAS_BUDGET_USDC_WEI applies. */
  GAS_BUDGET_WINDOW_BLOCKS: z.coerce.number().int().min(1).default(7200),
  /** Live monitor (HTML page, `/api/status` JSON, `/metrics` Prometheus text) on this port; 0 disables it. */
  MONITOR_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  /** Address the monitor binds to. Keep it on localhost and use an SSH tunnel: there is no authentication. */
  MONITOR_HOST: z.string().min(1).default('127.0.0.1'),
  /** Directory for persisted pool data. */
  DATA_DIR: z.string().default('data'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof schema> & {
  allowedHooks: Set<Address>
  /** Lower-cased start currency -> decimals. */
  startCurrencies: Map<Address, number>
  sendRpcUrls: string[]
  /** Every WebSocket endpoint to subscribe to (`WS_URL` first, then `WS_URLS`), de-duplicated; empty = poll. */
  wsUrls: string[]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env)
  const allowedHooks = new Set<Address>(
    parsed.ALLOWED_HOOKS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
      .map((s) => {
        if (!isAddress(s)) throw new Error(`ALLOWED_HOOKS: invalid address ${s}`)
        return s as Address
      }),
  )
  const startCurrencies = new Map<Address, number>()
  for (const entry of parsed.START_CURRENCIES.split(',')) {
    const trimmed = entry.trim().toLowerCase()
    if (!trimmed) continue
    const [addr, dec] = trimmed.split(':')
    if (!addr || !isAddress(addr)) throw new Error(`START_CURRENCIES: invalid address in "${entry}"`)
    const decimals = dec === undefined ? 18 : Number(dec)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`START_CURRENCIES: invalid decimals in "${entry}"`)
    }
    startCurrencies.set(addr as Address, decimals)
  }
  const sendRpcUrls = [parsed.RPC_URL, ...parsed.SEND_RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)]
  sendRpcUrls.splice(0, sendRpcUrls.length, ...new Set(sendRpcUrls))
  const wsUrls = [
    ...new Set([...(parsed.WS_URL ? [parsed.WS_URL] : []), ...parsed.WS_URLS.split(',').map((s) => s.trim()).filter(Boolean)]),
  ]
  for (const url of wsUrls) {
    if (!/^wss?:\/\//.test(url)) throw new Error(`WS_URLS: expected a ws:// or wss:// URL, got "${url}"`)
  }
  if (!parsed.DRY_RUN) {
    if (!parsed.PRIVATE_KEY) throw new Error('PRIVATE_KEY is required when DRY_RUN=false')
    if (!parsed.EXECUTOR_ADDRESS) throw new Error('EXECUTOR_ADDRESS is required when DRY_RUN=false')
  }
  return { ...parsed, allowedHooks, startCurrencies, sendRpcUrls, wsUrls }
}
