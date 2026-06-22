// Decide where one "move" ends and the next begins inside a chosen range. A dance is a
// chain of moves separated by brief holds/transitions — the moments where the body slows
// down. We aim for roughly N evenly-spaced moves, then nudge each cut onto the nearest
// low-motion instant so it lands on a natural pause instead of mid-gesture. Pure + testable.

import type { ReferenceFrame } from './types'

// A dance is taught in short "moves"; every 3 consecutive moves form a "section" you learn
// move 1 → move 2 → move 3, then run together.
export const MOVES_PER_SECTION = 3

export interface Move {
  index: number
  startSec: number
  endSec: number
  sectionIndex: number
  /** 0-based position within its section (0, 1, 2). */
  indexInSection: number
}
export interface DanceSection {
  index: number
  startSec: number
  endSec: number
  moves: Move[]
}

/** Build the move list from a range plus its internal cut times. */
export function buildMovesFromBounds(start: number, end: number, bounds: number[]): Move[] {
  const cuts = [start, ...bounds.filter((b) => b > start + 0.05 && b < end - 0.05).sort((a, b) => a - b), end]
  const out: Move[] = []
  for (let i = 0; i < cuts.length - 1; i++) {
    out.push({
      index: i,
      startSec: cuts[i]!,
      endSec: cuts[i + 1]!,
      sectionIndex: Math.floor(i / MOVES_PER_SECTION),
      indexInSection: i % MOVES_PER_SECTION,
    })
  }
  return out.length ? out : [{ index: 0, startSec: start, endSec: end, sectionIndex: 0, indexInSection: 0 }]
}

/** Group an ordered move list into sections of MOVES_PER_SECTION. */
export function groupMoveSections(moves: Move[]): DanceSection[] {
  const secs: DanceSection[] = []
  for (const m of moves) {
    let s = secs[m.sectionIndex]
    if (!s) { s = { index: m.sectionIndex, startSec: m.startSec, endSec: m.endSec, moves: [] }; secs[m.sectionIndex] = s }
    s.moves.push(m)
    s.endSec = m.endSec
  }
  return secs
}

/** Internal cut times (strictly inside (start, end)) for an even split into ~N moves. */
export function evenMoveBounds(start: number, end: number, targetSec: number): number[] {
  const span = end - start
  if (span <= 0.05 || targetSec <= 0) return []
  const n = Math.max(1, Math.round(span / targetSec))
  const out: number[] = []
  for (let k = 1; k < n; k++) out.push(start + (k * span) / n)
  return out
}

/** Normalize a series to 0..1 by its max (so two signals can be summed fairly). */
function normalize(xs: number[]): number[] {
  const max = xs.reduce((m, x) => Math.max(m, x), 0)
  return max > 0 ? xs.map((x) => x / max) : xs.map(() => 0)
}

/**
 * Pose-change magnitude between consecutive frames within [start, end]. Combines joint-angle
 * change (limbs bending) with world-landmark velocity (the whole body stepping/traveling),
 * so a real pause — limbs still AND feet planted — shows up as a clear dip = a distinct move.
 */
function motionSeries(frames: ReferenceFrame[], start: number, end: number): { t: number; m: number }[] {
  const win = frames.filter((f) => f.t >= start && f.t <= end)
  if (win.length < 2) return []
  const times: number[] = []
  const angleDelta: number[] = []
  const worldDelta: number[] = []
  for (let i = 1; i < win.length; i++) {
    const pa = win[i - 1]!
    const pb = win[i]!
    const na = Math.min(pa.angles.length, pb.angles.length)
    let as = 0
    for (let j = 0; j < na; j++) {
      const d = (pb.angles[j] ?? 0) - (pa.angles[j] ?? 0)
      as += d * d
    }
    let ws = 0
    const nw = Math.min(pa.world.length, pb.world.length)
    for (let j = 0; j < nw; j++) {
      const u = pa.world[j]!
      const v = pb.world[j]!
      ws += (v.x - u.x) ** 2 + (v.y - u.y) ** 2 + (v.z - u.z) ** 2
    }
    times.push(pb.t)
    angleDelta.push(Math.sqrt(as))
    worldDelta.push(Math.sqrt(ws))
  }
  const na = normalize(angleDelta)
  const nw = normalize(worldDelta)
  return times.map((t, i) => ({ t, m: na[i]! + nw[i]! }))
}

/** Moving-average smoothing with the given radius (in samples). */
function smooth(xs: number[], radius: number): number[] {
  if (radius <= 0) return xs.slice()
  return xs.map((_, i) => {
    let sum = 0
    let count = 0
    for (let k = -radius; k <= radius; k++) {
      const j = i + k
      if (j >= 0 && j < xs.length) {
        sum += xs[j]!
        count++
      }
    }
    return count ? sum / count : 0
  })
}

/**
 * Auto-detect move boundaries inside [start, end]. Targets ~`targetSec`-long moves, then
 * snaps each cut to the lowest-motion instant near it (a hold = where a move resolves).
 * Falls back to an even split when there isn't enough pose data (e.g. playback-only tracks).
 */
export function autoMoveBounds(
  frames: ReferenceFrame[],
  start: number,
  end: number,
  targetSec: number,
): number[] {
  const span = end - start
  if (span <= 0.05 || targetSec <= 0) return []
  const n = Math.max(1, Math.round(span / targetSec))
  if (n <= 1) return []

  const even: number[] = []
  for (let k = 1; k < n; k++) even.push(start + (k * span) / n)

  const series = motionSeries(frames, start, end)
  if (series.length < 4) return even // no usable motion signal → even split

  const sm = smooth(series.map((s) => s.m), 2)
  const sliceLen = span / n
  // Search a bounded window around each target so the cut lands on a *nearby* pause and
  // chunks stay close to the requested length (a wide window can snap to a far-off hold).
  const window = Math.min(sliceLen * 0.45, 2.5)
  const minGap = sliceLen * 0.4

  const out: number[] = []
  let last = start
  for (const target of even) {
    // Nearest low-motion instant within ±window of the even target.
    let bestT = target
    let bestVal = Infinity
    for (let i = 0; i < series.length; i++) {
      const t = series[i]!.t
      if (t < target - window || t > target + window) continue
      if (sm[i]! < bestVal) {
        bestVal = sm[i]!
        bestT = t
      }
    }
    // Keep cuts spaced out and inside the range; nudge rather than drop so the move
    // count stays close to what the user asked for.
    let t = bestT
    if (t < last + minGap) t = Math.min(target, end - minGap)
    if (t < last + minGap || t > end - minGap) continue
    out.push(t)
    last = t
  }
  return out.length ? out : even
}
