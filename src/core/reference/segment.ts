// Decide where one "move" ends and the next begins inside a chosen range. A dance is a
// chain of moves separated by brief holds/transitions — the moments where the body slows
// down. We aim for roughly N evenly-spaced moves, then nudge each cut onto the nearest
// low-motion instant so it lands on a natural pause instead of mid-gesture. Pure + testable.

import type { ReferenceFrame } from './types'
import type { Tempo } from '../audio/beats'

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

/** Beat times (seconds) strictly inside (start, end), in order, from a detected tempo. */
export function beatTimes(tempo: Tempo, start: number, end: number): number[] {
  const iv = tempo.beatIntervalSec
  if (!(iv > 0)) return []
  const out: number[] = []
  // First beat index whose time is > start.
  let k = Math.ceil((start - tempo.firstBeatSec) / iv)
  if (tempo.firstBeatSec + k * iv <= start) k++
  for (let t = tempo.firstBeatSec + k * iv; t < end - 1e-6; t += iv) {
    if (t > start + 1e-6) out.push(t)
  }
  return out
}

/**
 * Beat-aligned move boundaries: dance moves resolve on the count, so cuts are placed on
 * the beat grid every ~`beatsPerSeg` beats, then nudged to the QUIETEST beat in a small
 * neighbourhood (a hold = where a move actually lands). Musical and motion-aware.
 */
function beatAlignedBounds(
  frames: ReferenceFrame[],
  start: number,
  end: number,
  targetSec: number,
  beats: number[],
  tempo: Tempo,
): number[] {
  const beatsPerSeg = Math.max(1, Math.round(targetSec / tempo.beatIntervalSec))
  if (beats.length <= beatsPerSeg) return [] // not even one full segment of beats

  // Smoothed motion, sampled at each beat time (0 when there's no pose data — beat-only).
  const series = motionSeries(frames, start, end)
  const sm = smooth(series.map((s) => s.m), 2)
  const motionAt = (t: number): number => {
    if (series.length === 0) return 0
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < series.length; i++) {
      const d = Math.abs(series[i]!.t - t)
      if (d < bd) { bd = d; bi = i }
    }
    return sm[bi] ?? 0
  }

  const nudge = Math.max(1, Math.floor(beatsPerSeg / 3)) // beats to search either side
  const minGap = tempo.beatIntervalSec * Math.max(1, beatsPerSeg - nudge)
  const out: number[] = []
  let last = start
  for (let target = beatsPerSeg; target < beats.length; target += beatsPerSeg) {
    let bestT = beats[target]!
    let bestVal = motionAt(bestT)
    for (let d = -nudge; d <= nudge; d++) {
      const idx = target + d
      if (idx <= 0 || idx >= beats.length) continue
      const v = motionAt(beats[idx]!)
      if (v < bestVal) { bestVal = v; bestT = beats[idx]! }
    }
    if (bestT >= last + minGap && bestT < end - minGap) {
      out.push(bestT)
      last = bestT
    }
  }
  return out
}

/** Motion-only fallback (no tempo): even targets nudged onto nearby low-motion instants. */
function motionMoveBounds(frames: ReferenceFrame[], start: number, end: number, n: number): number[] {
  const span = end - start
  const even: number[] = []
  for (let k = 1; k < n; k++) even.push(start + (k * span) / n)

  const series = motionSeries(frames, start, end)
  if (series.length < 4) return even // no usable motion signal → even split

  const sm = smooth(series.map((s) => s.m), 2)
  const sliceLen = span / n
  const window = Math.min(sliceLen * 0.45, 2.5)
  const minGap = sliceLen * 0.4

  const out: number[] = []
  let last = start
  for (const target of even) {
    let bestT = target
    let bestVal = Infinity
    for (let i = 0; i < series.length; i++) {
      const t = series[i]!.t
      if (t < target - window || t > target + window) continue
      if (sm[i]! < bestVal) { bestVal = sm[i]!; bestT = t }
    }
    let t = bestT
    if (t < last + minGap) t = Math.min(target, end - minGap)
    if (t < last + minGap || t > end - minGap) continue
    out.push(t)
    last = t
  }
  return out.length ? out : even
}

/**
 * Auto-detect move boundaries inside [start, end]. When the song's tempo is known, cuts
 * are aligned to the beat grid (~`targetSec` per move) and snapped to the quietest nearby
 * beat — musical and accurate. Without a tempo it falls back to motion-dip detection, and
 * without pose data (e.g. playback-only) to an even split.
 */
export function autoMoveBounds(
  frames: ReferenceFrame[],
  start: number,
  end: number,
  targetSec: number,
  tempo?: Tempo,
): number[] {
  const span = end - start
  if (span <= 0.05 || targetSec <= 0) return []
  const n = Math.max(1, Math.round(span / targetSec))
  if (n <= 1) return []

  if (tempo && tempo.bpm > 0 && tempo.beatIntervalSec > 0) {
    const beats = beatTimes(tempo, start, end)
    if (beats.length >= 4) {
      const aligned = beatAlignedBounds(frames, start, end, targetSec, beats, tempo)
      if (aligned.length) return aligned
    }
  }
  return motionMoveBounds(frames, start, end, n)
}
