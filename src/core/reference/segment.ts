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

// ---- Distinct-movement detection (pose novelty) --------------------------------------
//
// A "move" is a stretch of choreography with its own pose content; a new move begins when
// that content changes into something different. Repeating the same motion is NOT a new move
// (the body keeps visiting the same poses), so a repeat should stay in one segment.
//
// We capture both with a self-similarity novelty curve (Foote): sample each frame's pose,
// compare every pair, and slide a checkerboard kernel down the diagonal. Where the block
// BEFORE an instant is self-similar, the block AFTER is self-similar, but the two are
// UNLIKE each other, novelty peaks — a genuine change of movement. A repeated phrase makes
// the before/after blocks look alike, so novelty stays flat and no cut is placed. The kernel
// spans ~one target segment, so each cut opens a new short phrase (a few moves), not a
// single gesture, and repeats within that span are absorbed rather than chopped.

const MAX_SAMPLES = 600 // cap the O(n²) similarity matrix; ~3 samples/sec even on a 3-min video
const CONTRAST_FLOOR = 0.07 // min before/after pose contrast (0..1) to call it a real change
// A joint re-doing the same move lands within a few degrees of last time (execution jitter);
// a genuinely different move swings joints by tens of degrees. Flooring the distance scale
// here keeps jitter from being inflated into fake "novelty" on repetitive/held stretches.
const MIN_DISTINCT_DEG = 15

interface PoseSamples {
  times: number[]
  feats: number[][] // per-sample joint-angle vector (degrees)
}

/** Uniformly resample the window's joint-angle vectors. Kept in raw degrees — all joints
 *  share the unit, and absolute scale is what separates jitter from a real move (see
 *  MIN_DISTINCT_DEG). Standardizing per joint would inflate noise on repetitive stretches. */
function samplePoses(frames: ReferenceFrame[], start: number, end: number): PoseSamples | null {
  const win = frames.filter((f) => f.t >= start && f.t <= end)
  if (win.length < 8) return null
  const dims = win.reduce((m, f) => Math.min(m, f.angles.length), Infinity)
  if (!(dims >= 1)) return null

  const span = end - start
  const n = Math.min(MAX_SAMPLES, win.length)
  const times: number[] = []
  const feats: number[][] = []
  let wi = 0
  for (let k = 0; k < n; k++) {
    const t = start + ((k + 0.5) * span) / n
    // Advance to the window frame nearest t (win is time-ordered).
    while (wi + 1 < win.length && Math.abs(win[wi + 1]!.t - t) <= Math.abs(win[wi]!.t - t)) wi++
    const f = win[wi]!
    times.push(f.t)
    feats.push(f.angles.slice(0, dims))
  }
  return { times, feats }
}

/** Symmetric pose-similarity matrix in (0,1]; 1 = identical pose. */
function similarityMatrix(feats: number[][]): number[][] {
  const n = feats.length
  const dims = feats[0]?.length ?? 0
  // Scale distances by the average squared distance so contrast is data-relative — but
  // floored at "a genuinely different move" size. Without the floor, a video where the body
  // only jitters in place (a hold or a repeated move) would have its noise stretched into
  // fake structure and get cut anyway.
  let sum = 0
  let cnt = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let d = 0
      const a = feats[i]!
      const b = feats[j]!
      for (let k = 0; k < a.length; k++) d += (a[k]! - b[k]!) ** 2
      sum += d
      cnt++
    }
  }
  const scale = Math.max(sum / Math.max(cnt, 1), dims * MIN_DISTINCT_DEG * MIN_DISTINCT_DEG)
  const S: number[][] = Array.from({ length: n }, () => new Array(n).fill(1))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let d = 0
      const a = feats[i]!
      const b = feats[j]!
      for (let k = 0; k < a.length; k++) d += (a[k]! - b[k]!) ** 2
      const s = Math.exp(-d / scale)
      S[i]![j] = s
      S[j]![i] = s
    }
  }
  return S
}

/**
 * Foote novelty at each sample, expressed as a before/after contrast in [-1, 1]: how much
 * more the two half-windows resemble themselves than each other. `L` is the kernel half-width
 * in samples (≈ half a target segment). Repetition → ~0; a clean phrase change → strongly
 * positive.
 */
function noveltyContrast(S: number[][], L: number): number[] {
  const n = S.length
  const sigma = Math.max(L / 2, 1)
  // Precompute the tapered checkerboard weights and their total positive mass (normalizer).
  const g: number[][] = []
  let W = 0
  for (let k = -L; k <= L; k++) {
    const row: number[] = []
    for (let l = -L; l <= L; l++) {
      const w = Math.exp(-(k * k + l * l) / (2 * sigma * sigma))
      row.push(w)
      if ((k < 0) === (l < 0)) W += w
    }
    g.push(row)
  }
  const out = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = -L; k <= L; k++) {
      const a = i + k
      if (a < 0 || a >= n) continue
      const grow = g[k + L]!
      const Sa = S[a]!
      for (let l = -L; l <= L; l++) {
        const b = i + l
        if (b < 0 || b >= n) continue
        const sign = (k < 0) === (l < 0) ? 1 : -1
        s += sign * grow[l + L]! * Sa[b]!
      }
    }
    out[i] = W > 0 ? s / W : 0
  }
  return out
}

/**
 * Distinct-move boundaries from pose novelty. Cuts fall on real phrase changes; repeated
 * motion is left whole. Beat-snapped when a tempo is known. Returns [] when the pose stays
 * one continuous phrase (nothing to cut) — the caller trusts that over any time-based split.
 */
function noveltyBounds(
  sp: PoseSamples,
  start: number,
  end: number,
  targetSec: number,
  tempo?: Tempo,
): number[] {
  const { times, feats } = sp
  const n = feats.length
  const span = end - start
  const sps = n / span // samples per second
  const L = Math.max(3, Math.min(Math.floor((n - 1) / 2), Math.round(targetSec * 0.5 * sps)))
  if (n < 2 * L + 1) return [] // window too short to host even one segment either side

  const S = similarityMatrix(feats)
  const contrast = noveltyContrast(S, L)

  const minGapSec = Math.max(1.2, targetSec * 0.5)
  const minGapSamples = Math.max(1, Math.round(minGapSec * sps))
  const maxCuts = Math.max(1, Math.round(span / (targetSec * 0.6)))

  // Local maxima of the contrast curve that clear the floor = candidate phrase changes.
  const peaks: { i: number; v: number }[] = []
  for (let i = 1; i < n - 1; i++) {
    const v = contrast[i]!
    if (v > CONTRAST_FLOOR && v >= contrast[i - 1]! && v > contrast[i + 1]!) {
      peaks.push({ i, v })
    }
  }
  peaks.sort((a, b) => b.v - a.v)

  // Greedily keep the strongest, spaced out, away from the ends.
  const edge = Math.max(minGapSamples, L)
  const chosen: number[] = []
  for (const p of peaks) {
    if (chosen.length >= maxCuts) break
    if (p.i < edge || p.i > n - 1 - edge) continue
    if (chosen.some((c) => Math.abs(c - p.i) < minGapSamples)) continue
    chosen.push(p.i)
  }
  chosen.sort((a, b) => a - b)

  const beats = tempo && tempo.bpm > 0 && tempo.beatIntervalSec > 0 ? beatTimes(tempo, start, end) : []
  const out: number[] = []
  let last = start
  for (const idx of chosen) {
    let t = times[idx]!
    if (beats.length) t = snapToBeat(t, beats, tempo!.beatIntervalSec * 1.5)
    if (t >= last + minGapSec && t < end - minGapSec) {
      out.push(t)
      last = t
    }
  }
  return out
}

/** Nearest beat to `t` within `tol` seconds, else `t` unchanged. */
function snapToBeat(t: number, beats: number[], tol: number): number {
  let best = t
  let bd = tol
  for (const b of beats) {
    const d = Math.abs(b - t)
    if (d < bd) { bd = d; best = b }
  }
  return best
}

/**
 * Auto-detect move boundaries inside [start, end]. When the dancing is tracked, cuts land on
 * distinct-movement changes (pose novelty) and a repeated phrase is kept whole — so each
 * segment is a short phrase of a few moves. Cuts snap to the beat when a tempo is known.
 * Without pose data (playback-only tracks) it falls back to a beat-aligned split, or an even
 * split when there's no tempo either.
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

  // Pose available → trust distinct-movement detection, including "no cuts" for a pure repeat.
  const poses = samplePoses(frames, start, end)
  if (poses) return noveltyBounds(poses, start, end, targetSec, tempo)

  // No usable pose (e.g. playback-only). Space it out: beat grid if we have a tempo, else even.
  const n = Math.max(1, Math.round(span / targetSec))
  if (n <= 1) return []
  if (tempo && tempo.bpm > 0 && tempo.beatIntervalSec > 0) {
    const beats = beatTimes(tempo, start, end)
    if (beats.length >= 4) {
      const aligned = beatAlignedBounds(frames, start, end, targetSec, beats, tempo)
      if (aligned.length) return aligned
    }
  }
  return evenMoveBounds(start, end, targetSec)
}
