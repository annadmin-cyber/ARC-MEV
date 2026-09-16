import type { Address, Hex } from 'viem'
import type { Opportunity } from '../types.js'

/** Scale an amount from `decimals` to 18 decimals (rounds toward zero when scaling down). */
export function to18(amount: bigint, decimals: number): bigint {
  if (decimals === 18) return amount
  if (decimals < 18) return amount * 10n ** BigInt(18 - decimals)
  return amount / 10n ** BigInt(decimals - 18)
}

/** Scale an 18-decimal amount to `decimals` (rounds toward zero when scaling down). */
export function from18(amount18: bigint, decimals: number): bigint {
  if (decimals === 18) return amount18
  if (decimals < 18) return amount18 / 10n ** BigInt(18 - decimals)
  return amount18 * 10n ** BigInt(decimals - 18)
}

/**
 * Rank opportunities for execution:
 *
 * 1. `grossProfitUsdc` is set to the gross profit expressed with 18 decimals, using the decimals
 *    of the start currency (start currencies are USDC variants, so this is a USDC-wei value).
 *    Opportunities whose start currency has no known decimals stay unpriced and sort last.
 * 2. Sort by `grossProfitUsdc` descending (unpriced ones after, by raw profit), ties by cycle id.
 * 3. Drop any opportunity that shares a pool with a better one already kept: cycles through the
 *    same pool are not independent, executing one invalidates the other's state.
 *
 * The input array is not mutated; the returned opportunities are shallow copies with
 * `grossProfitUsdc` filled in.
 */
export function rankOpportunities<T extends Opportunity>(opps: T[], decimals: Map<Address, number>): T[] {
  const priced = opps.map((opp) => withUsdc(opp, decimals))
  priced.sort(compare)
  const used = new Set<Hex>()
  const kept: T[] = []
  for (const opp of priced) {
    const pools = opp.cycle.hops.map((h) => h.poolId)
    if (pools.some((p) => used.has(p))) continue
    for (const p of pools) used.add(p)
    kept.push(opp)
  }
  return kept
}

function withUsdc<T extends Opportunity>(opp: T, decimals: Map<Address, number>): T {
  const dec = decimals.get(opp.cycle.start.toLowerCase() as Address)
  if (dec === undefined) {
    const { grossProfitUsdc: _drop, ...rest } = opp
    return rest as T
  }
  return { ...opp, grossProfitUsdc: to18(opp.grossProfit, dec) }
}

function compare(a: Opportunity, b: Opportunity): number {
  const ua = a.grossProfitUsdc
  const ub = b.grossProfitUsdc
  if (ua !== undefined && ub !== undefined) {
    if (ua !== ub) return ua > ub ? -1 : 1
  } else if (ua !== undefined) {
    return -1
  } else if (ub !== undefined) {
    return 1
  } else if (a.grossProfit !== b.grossProfit) {
    return a.grossProfit > b.grossProfit ? -1 : 1
  }
  return a.cycle.id < b.cycle.id ? -1 : a.cycle.id > b.cycle.id ? 1 : 0
}
