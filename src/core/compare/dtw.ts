// Dynamic Time Warping: align two sequences of angle vectors that may run at
// slightly different speeds, so a dancer who is a beat early/late still matches.
// Used to score a whole section after a take (timing-forgiving), and to find the
// best alignment offset for live coloring.

/** Distance between two angle vectors. Default: RMS angle error in degrees. */
export type FrameDistance = (a: number[], b: number[]) => number

export function rmsAngleDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    sum += d * d
  }
  return Math.sqrt(sum / n)
}

export interface DtwResult {
  /** Total accumulated distance along the optimal path. */
  distance: number
  /** Optimal path as [indexInA, indexInB] pairs, from start to end. */
  path: Array<[number, number]>
  /** distance normalized by path length — comparable across section lengths. */
  normalizedDistance: number
}

export interface DtwOptions {
  dist?: FrameDistance
  /**
   * Sakoe-Chiba band radius (in frames). Limits how far the alignment can drift,
   * which bounds cost to O(n*band) and prevents pathological warps. Use a value
   * proportional to expected timing slack. Omit for an unbounded (full) DTW.
   */
  band?: number
}

const INF = Number.POSITIVE_INFINITY

/**
 * Classic DTW with optional Sakoe-Chiba band. Returns the alignment cost and path.
 * Both inputs are arrays of angle vectors.
 */
export function dtw(a: number[][], b: number[][], options: DtwOptions = {}): DtwResult {
  const dist = options.dist ?? rmsAngleDistance
  const n = a.length
  const m = b.length

  if (n === 0 || m === 0) {
    return { distance: 0, path: [], normalizedDistance: 0 }
  }

  // Band wide enough to always cover the diagonal even when n != m.
  const band = options.band ?? Math.max(n, m)
  const w = Math.max(band, Math.abs(n - m))

  // Accumulated cost matrix (n+1) x (m+1), padded with INF border.
  const D: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF))
  D[0]![0] = 0

  for (let i = 1; i <= n; i++) {
    const jStart = Math.max(1, i - w)
    const jEnd = Math.min(m, i + w)
    for (let j = jStart; j <= jEnd; j++) {
      const cost = dist(a[i - 1]!, b[j - 1]!)
      const best = Math.min(D[i - 1]![j]!, D[i]![j - 1]!, D[i - 1]![j - 1]!)
      D[i]![j] = cost + best
    }
  }

  // Backtrack the optimal path.
  const path: Array<[number, number]> = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1])
    const diag = D[i - 1]![j - 1]!
    const up = D[i - 1]![j]!
    const left = D[i]![j - 1]!
    const min = Math.min(diag, up, left)
    if (min === diag) {
      i--
      j--
    } else if (min === up) {
      i--
    } else {
      j--
    }
  }
  path.reverse()

  const distance = D[n]![m]!
  return {
    distance,
    path,
    normalizedDistance: path.length > 0 ? distance / path.length : 0,
  }
}
