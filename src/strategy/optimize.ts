/**
 * One-dimensional maximisation of a profit curve `profit(x) = out(x) - x` over integer inputs.
 *
 * The curve is sampled on a log scale: a coarse log-spaced grid first (so that non-concave or
 * noisy curves still land in the right basin), then golden-section search on ln(x) inside the
 * bracket around the best grid point, then a small integer hill-climb to polish the result.
 */

export interface ProfitSample {
  amountIn: bigint
  amountOut: bigint
  /** amountOut - amountIn (may be negative). */
  profit: bigint
  /** True if the sample is only a lower bound (some hop ran out of known ticks). */
  truncated: boolean
}

/** Profit evaluator; must be total (never throw) for inputs in `[minInput, maxInput]`. */
export type ProfitFn = (amountIn: bigint) => ProfitSample

export interface OptimizeOptions {
  /** Smallest input to consider (inclusive, > 0). */
  minInput: bigint
  /** Largest input to consider (inclusive). */
  maxInput: bigint
  /** Log-spaced grid points sampled first (default 12). */
  gridPoints?: number
  /** Golden-section iterations on ln(x) (default 40). */
  goldenIterations?: number
  /** Upper bound on evaluations spent on the integer refinement (default 24). */
  refineEvaluations?: number
}

export interface OptimizeResult {
  best: ProfitSample
  /** Number of distinct inputs evaluated. */
  evaluations: number
}

const DEFAULT_GRID_POINTS = 12
const DEFAULT_GOLDEN_ITERATIONS = 40
const DEFAULT_REFINE_EVALUATIONS = 24
/** Inverse golden ratio. */
const PHI = (Math.sqrt(5) - 1) / 2

/**
 * Sample ordering: higher profit wins; on equal profit a non-truncated (exact) sample wins; on a
 * further tie the smaller input wins (less capital at risk, less price impact if state is stale).
 */
export function isBetterSample(a: ProfitSample, b: ProfitSample): boolean {
  if (a.profit !== b.profit) return a.profit > b.profit
  if (a.truncated !== b.truncated) return !a.truncated
  return a.amountIn < b.amountIn
}

/** Convert a natural-log coordinate to an integer input, clamped to `[min, max]`. */
export function fromLog(l: number, min: bigint, max: bigint): bigint {
  const v = Math.exp(l)
  if (!Number.isFinite(v)) return v > 0 ? max : min
  const x = BigInt(Math.round(v))
  return x < min ? min : x > max ? max : x
}

/** Natural log of a positive bigint (float precision is sufficient for a search coordinate). */
export function toLog(x: bigint): number {
  return Math.log(Number(x))
}

/**
 * Maximise `f` over integers in `[minInput, maxInput]`. Returns `null` only if the interval is
 * empty. The result's `best` is the sample with the highest profit seen at any stage, which may
 * still be negative: callers decide whether that constitutes an opportunity.
 */
export function optimizeInput(f: ProfitFn, opts: OptimizeOptions): OptimizeResult | null {
  const min = opts.minInput < 1n ? 1n : opts.minInput
  const max = opts.maxInput
  if (max < min) return null

  const memo = new Map<bigint, ProfitSample>()
  let best: ProfitSample | undefined
  const evaluate = (x: bigint): ProfitSample => {
    const cached = memo.get(x)
    if (cached) return cached
    const sample = f(x)
    memo.set(x, sample)
    if (best === undefined || isBetterSample(sample, best)) best = sample
    return sample
  }

  if (min === max) {
    const only = evaluate(min)
    return { best: only, evaluations: memo.size }
  }

  const lo = toLog(min)
  const hi = toLog(max)
  const grid = sampleGrid(evaluate, lo, hi, min, max, opts.gridPoints ?? DEFAULT_GRID_POINTS)
  const bracket = bracketAround(grid, lo, hi)
  goldenSection(evaluate, bracket.lo, bracket.hi, min, max, opts.goldenIterations ?? DEFAULT_GOLDEN_ITERATIONS)

  // `best` is defined because the grid evaluated at least two points.
  const polished = refineInteger(evaluate, best as ProfitSample, min, max, opts.refineEvaluations ?? DEFAULT_REFINE_EVALUATIONS)
  return { best: polished, evaluations: memo.size }
}

interface GridPoint {
  l: number
  sample: ProfitSample
}

/** Evaluate `n` log-spaced points including both ends; returns them in ascending order. */
function sampleGrid(
  evaluate: (x: bigint) => ProfitSample,
  lo: number,
  hi: number,
  min: bigint,
  max: bigint,
  n: number,
): GridPoint[] {
  const points = Math.max(2, n)
  const out: GridPoint[] = []
  for (let i = 0; i < points; i++) {
    const l = lo + ((hi - lo) * i) / (points - 1)
    out.push({ l, sample: evaluate(fromLog(l, min, max)) })
  }
  return out
}

/** Log-interval around the best grid point (its two neighbours, or the interval ends). */
function bracketAround(grid: GridPoint[], lo: number, hi: number): { lo: number; hi: number } {
  let bestIdx = 0
  for (let i = 1; i < grid.length; i++) {
    const current = grid[i]
    const incumbent = grid[bestIdx]
    if (current && incumbent && isBetterSample(current.sample, incumbent.sample)) bestIdx = i
  }
  const left = grid[bestIdx - 1]
  const right = grid[bestIdx + 1]
  return { lo: left ? left.l : lo, hi: right ? right.l : hi }
}

/**
 * Golden-section search for a maximum on the log interval `[a, b]`. Stops early once the two
 * interior probes collapse to the same integer input (nothing left to resolve).
 */
function goldenSection(
  evaluate: (x: bigint) => ProfitSample,
  a0: number,
  b0: number,
  min: bigint,
  max: bigint,
  iterations: number,
): void {
  let a = a0
  let b = b0
  let c = b - PHI * (b - a)
  let d = a + PHI * (b - a)
  let xc = fromLog(c, min, max)
  let xd = fromLog(d, min, max)
  let fc = evaluate(xc)
  let fd = evaluate(xd)
  for (let i = 0; i < iterations; i++) {
    if (xc === xd) break
    if (isBetterSample(fc, fd)) {
      b = d
      d = c
      xd = xc
      fd = fc
      c = b - PHI * (b - a)
      xc = fromLog(c, min, max)
      fc = evaluate(xc)
    } else {
      a = c
      c = d
      xc = xd
      fc = fd
      d = a + PHI * (b - a)
      xd = fromLog(d, min, max)
      fd = evaluate(xd)
    }
  }
}

/**
 * Integer hill-climb from `start`: try +/- step, move on improvement, otherwise shrink the step.
 * Steps start at ~0.1% of the input and end at 1, bounded by `budget` evaluations.
 */
function refineInteger(
  evaluate: (x: bigint) => ProfitSample,
  start: ProfitSample,
  min: bigint,
  max: bigint,
  budget: number,
): ProfitSample {
  let best = start
  let step = best.amountIn / 1024n
  if (step < 1n) step = 1n
  let spent = 0
  while (spent < budget) {
    let moved = false
    for (const candidate of [best.amountIn + step, best.amountIn - step]) {
      if (candidate < min || candidate > max) continue
      const sample = evaluate(candidate)
      spent++
      if (isBetterSample(sample, best)) {
        best = sample
        moved = true
        break
      }
    }
    if (!moved) {
      if (step === 1n) break
      step /= 4n
      if (step < 1n) step = 1n
    }
  }
  return best
}
