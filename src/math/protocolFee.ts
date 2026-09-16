/**
 * Port of Uniswap v4 `ProtocolFeeLibrary.sol` and the swap-fee selection in `Pool.swap`.
 *
 * `protocolFee` is a packed uint24: the low 12 bits apply to zeroForOne swaps and the
 * high 12 bits to oneForZero swaps, both in hundredths of a bip (max 1000 = 0.1%).
 */

/** Fee denominator: 1e6 pips = 100%. */
export const PIPS_DENOMINATOR = 1_000_000n
/** Maximum protocol fee per direction (0.1%). */
export const MAX_PROTOCOL_FEE = 1000

/** Protocol fee (pips) charged on zeroForOne swaps. */
export function getZeroForOneFee(protocolFee: number): number {
  return protocolFee & 0xfff
}

/** Protocol fee (pips) charged on oneForZero swaps. */
export function getOneForZeroFee(protocolFee: number): number {
  return (protocolFee >> 12) & 0xfff
}

/** Protocol fee (pips) for the given swap direction. */
export function protocolFeeForDirection(protocolFee: number, zeroForOne: boolean): number {
  return zeroForOne ? getZeroForOneFee(protocolFee) : getOneForZeroFee(protocolFee)
}

/**
 * Combined swap fee when a protocol fee is active: the protocol fee is taken from the input
 * first and the LP fee from the remainder. `p + lp - p * lp / 1e6` (integer division).
 */
export function calculateSwapFee(protocolFee: number, lpFee: number): bigint {
  const p = BigInt(protocolFee & 0xfff)
  const lp = BigInt(lpFee & 0xffffff)
  return p + lp - (p * lp) / PIPS_DENOMINATOR
}

/**
 * The total swap fee (pips) `Pool.swap` charges for a direction: the LP fee alone when the
 * protocol fee for that direction is 0, otherwise `calculateSwapFee`.
 */
export function swapFeeFor(protocolFee: number, lpFee: number, zeroForOne: boolean): bigint {
  const p = protocolFeeForDirection(protocolFee, zeroForOne)
  return p === 0 ? BigInt(lpFee) : calculateSwapFee(p, lpFee)
}

/**
 * Portion of a step's fee owed to the protocol, mirroring `Pool.swap`: the whole fee when the
 * LP fee is 0 (swapFee == protocolFee), otherwise `(amountIn + feeAmount) * protocolFee / 1e6`
 * rounded down.
 */
export function protocolFeeShare(
  stepAmountIn: bigint,
  stepFeeAmount: bigint,
  swapFee: bigint,
  protocolFee: number,
): bigint {
  if (protocolFee === 0) return 0n
  const p = BigInt(protocolFee)
  if (swapFee === p) return stepFeeAmount
  return ((stepAmountIn + stepFeeAmount) * p) / PIPS_DENOMINATOR
}
