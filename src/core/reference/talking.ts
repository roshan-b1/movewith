// Talking-vs-dancing detection. Tutorial videos mix demonstration with explanation, and
// the difference lives in the LEGS: an instructor explaining a move gestures with their
// arms but stands still, while dancing keeps the lower body busy. So a sustained stretch
// of near-still legs = a talking/explaining part, which practice can auto-skip. Pure.

import type { ReferenceFrame } from './types'
import { JOINT_LIMB } from '../pose/angles'

export interface TimeRange {
  startSec: number
  endSec: number
}

/** Leg-joint indices in the angle vector (hips + knees). */
const LEG_JOINTS: readonly number[] = JOINT_LIMB
  .map((limb, i) => (limb === 'leftLeg' || limb === 'rightLeg' ? i : -1))
  .filter((i) => i >= 0)

/** A talking stretch must be at least this long — brief holds inside a dance don't count. */
const MIN_TALK_SEC = 3.5
/** Gaps shorter than this between two talking stretches merge into one. */
const MERGE_GAP_SEC = 1.0
/** Legs quieter than this many deg/sec read as "standing still" even in an all-talk video. */
const STILL_LEGS_DEG_PER_SEC = 25
/** ...or quieter than this fraction of the video's own busy-legs level, when that's higher. */
const RELATIVE_STILL = 0.2

/** Mean |Δangle|/sec over the leg joints at each frame transition. */
function legRates(frames: ReferenceFrame[]): { t: number; rate: number }[] {
  const out: { t: number; rate: number }[] = []
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!
    const b = frames[i]!
    const dt = b.t - a.t
    if (dt <= 1e-6 || dt > 2) continue // skip gaps (dropped tracking)
    let sum = 0
    for (const j of LEG_JOINTS) sum += Math.abs((b.angles[j] ?? 0) - (a.angles[j] ?? 0))
    out.push({ t: (a.t + b.t) / 2, rate: sum / LEG_JOINTS.length / dt })
  }
  return out
}

/** Moving-average smooth over ± `radiusSec` of neighbours. */
function smoothByTime(xs: { t: number; rate: number }[], radiusSec: number): number[] {
  return xs.map((x, i) => {
    let sum = 0
    let n = 0
    for (let j = i; j >= 0 && xs[j]!.t >= x.t - radiusSec; j--) { sum += xs[j]!.rate; n++ }
    for (let j = i + 1; j < xs.length && xs[j]!.t <= x.t + radiusSec; j++) { sum += xs[j]!.rate; n++ }
    return n ? sum / n : 0
  })
}

/**
 * Find the talking/explaining stretches inside [start, end]: sustained runs where the
 * legs sit near-still. Returns merged, ordered ranges; empty when the whole thing is
 * dancing (or there's no usable pose data).
 */
export function detectTalkingRanges(frames: ReferenceFrame[], start: number, end: number): TimeRange[] {
  const win = frames.filter((f) => f.t >= start && f.t <= end)
  const rates = legRates(win)
  if (rates.length < 8) return []

  const sm = smoothByTime(rates, 1.25)
  // The video's own "legs are dancing" level: the 80th percentile of smoothed leg rate.
  const sorted = sm.slice().sort((a, b) => a - b)
  const busy = sorted[Math.floor(sorted.length * 0.8)] ?? 0
  const threshold = Math.max(STILL_LEGS_DEG_PER_SEC, busy * RELATIVE_STILL)

  // Collect sustained below-threshold runs.
  const ranges: TimeRange[] = []
  let runStart: number | null = null
  for (let i = 0; i < rates.length; i++) {
    const still = sm[i]! < threshold
    if (still && runStart === null) runStart = rates[i]!.t
    if ((!still || i === rates.length - 1) && runStart !== null) {
      const runEnd = still ? rates[i]!.t : rates[i - 1]!.t
      if (runEnd - runStart >= MIN_TALK_SEC) ranges.push({ startSec: runStart, endSec: runEnd })
      runStart = null
    }
  }

  // Merge near-adjacent ranges.
  const merged: TimeRange[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.startSec - last.endSec < MERGE_GAP_SEC) last.endSec = r.endSec
    else merged.push({ ...r })
  }
  return merged
}

/** Fraction (0..1) of [s, e] covered by the given ranges. */
export function overlapFraction(ranges: TimeRange[], s: number, e: number): number {
  const span = e - s
  if (span <= 0) return 0
  let covered = 0
  for (const r of ranges) {
    covered += Math.max(0, Math.min(e, r.endSec) - Math.max(s, r.startSec))
  }
  return Math.min(1, covered / span)
}
