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

const schema = z.object({
  CHAIN_ID: z.coerce.number().int().default(5042),
  RPC_URL: z.string().url().default('https://rpc.mainnet.arc.io'),
  /** Optional WebSocket endpoint for newHeads; falls back to HTTP polling when absent. */
  WS_URL: z.string().url().optional(),
  /** Bot hot key. Only needed when DRY_RUN=false. */
  PRIVATE_KEY: hex.optional(),
  /** Deployed ArcArbExecutor. Only needed for on-chain simulation and sending. */
  EXECUTOR_ADDRESS: address.optional(),

  DRY_RUN: bool('true'),
  /** Minimum net profit (after gas) in USDC wei (18 decimals). Default 0.05 USDC. */
  MIN_PROFIT_USDC_WEI: bigintStr('50000000000000000'),
  /** Largest input the optimizer may try, in USDC wei. Default 5,000 USDC. */
  MAX_INPUT_USDC_WEI: bigintStr('5000000000000000000000'),
  /** Multiply the estimated gas cost by this before comparing to profit. */
  GAS_SAFETY: z.coerce.number().default(1.5),
  /** Hard cap on maxFeePerGas in wei. Arc base fee floats (floor 20 gwei, cap 20,000 gwei). Default 25,000 gwei. */
  MAX_FEE_PER_GAS_WEI: bigintStr('25000000000000'),
  /** Priority fee budget as a fraction of expected gross profit (0.5 = bid up to 50% of profit). */
  TIP_SHARE: z.coerce.number().min(0).max(1).default(0.5),
  /** Hard cap on maxPriorityFeePerGas in wei. Top-of-block tips on Arc are ~350 gwei p50, ~6000 gwei p90. Default 10,000 gwei. */
  MAX_PRIORITY_FEE_WEI: bigintStr('10000000000000'),
  /** Minimum priority fee in wei (below this the tx sorts behind everyone). Default 25 gwei. */
  MIN_PRIORITY_FEE_WEI: bigintStr('25000000000'),
  /** Extra RPC URLs (comma-separated) that also receive eth_sendRawTransaction, for latency fan-out. */
  SEND_RPC_URLS: z.string().default(''),
  /** sqrtPrice tolerance (bps) for on-chain state guards; 0 disables guards. */
  GUARD_TOLERANCE_BPS: z.coerce.number().int().min(0).default(1),
  /** Upper bound on the gas limit of execute() transactions (used when estimation fails). */
  GAS_LIMIT: z.coerce.number().int().default(1_500_000),
  /** Gas assumed when quoting profitability before an on-chain estimate exists. A 2-hop v4 cycle
   *  uses ~250-350k gas; keep this close to reality or good opportunities are rejected early. */
  QUOTE_GAS: z.coerce.number().int().min(21_000).default(400_000),

  /** Only pools whose liquidity is at least this are tracked. */
  MIN_POOL_LIQUIDITY: bigintStr('1000000000000'),
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
  /** Directory for persisted pool data. */
  DATA_DIR: z.string().default('data'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof schema> & {
  allowedHooks: Set<Address>
  /** Lower-cased start currency -> decimals. */
  startCurrencies: Map<Address, number>
  sendRpcUrls: string[]
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
  if (!parsed.DRY_RUN) {
    if (!parsed.PRIVATE_KEY) throw new Error('PRIVATE_KEY is required when DRY_RUN=false')
    if (!parsed.EXECUTOR_ADDRESS) throw new Error('EXECUTOR_ADDRESS is required when DRY_RUN=false')
  }
  return { ...parsed, allowedHooks, startCurrencies, sendRpcUrls }
}
