// Multi-person track association: turn per-frame pose detections (unordered people)
// into stable per-PERSON tracks across the video, so the dancer you pick in "Test my
// skills" stays the same dancer for the whole song. Pure and deterministic — the
// matching is greedy nearest-torso between consecutive frames, which is plenty for
// dance videos where people don't teleport between samples.

import { LM, type Landmark } from './types'

export interface DetectedPerson {
  world: Landmark[]
  image: Landmark[]
}

export interface DetectedFrame {
  t: number
  people: DetectedPerson[]
}

export interface PersonFrame {
  t: number
  world: Landmark[]
  image: Landmark[]
}

export interface AssociateOptions {
  /** Max image-space distance (0..1) a person can move between samples and still be
   *  the same track. Generous because sampling is sparse (~12fps). */
  maxJump?: number
  /** A track missing for longer than this (seconds) is closed, not resumed. */
  maxGapSec?: number
  /** Tracks seen in fewer than this fraction of frames are dropped (passers-by). */
  minCoverage?: number
}

/** Torso centre in image space: midpoint of shoulders and hips. */
function torsoCenter(image: Landmark[]): { x: number; y: number } | null {
  const ls = image[LM.leftShoulder]
  const rs = image[LM.rightShoulder]
  const lh = image[LM.leftHip]
  const rh = image[LM.rightHip]
  if (!ls || !rs || !lh || !rh) return null
  return { x: (ls.x + rs.x + lh.x + rh.x) / 4, y: (ls.y + rs.y + lh.y + rh.y) / 4 }
}

/** Rough body size in image space (shoulder-to-hip span) — bigger = closer/more prominent. */
function torsoSize(image: Landmark[]): number {
  const ls = image[LM.leftShoulder]
  const rs = image[LM.rightShoulder]
  const lh = image[LM.leftHip]
  const rh = image[LM.rightHip]
  if (!ls || !rs || !lh || !rh) return 0
  const shoulderW = Math.hypot(ls.x - rs.x, ls.y - rs.y)
  const trunkH = Math.hypot((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2, (ls.y + rs.y) / 2 - (lh.y + rh.y) / 2)
  return shoulderW + trunkH
}

interface OpenTrack {
  frames: PersonFrame[]
  last: { x: number; y: number }
  lastT: number
  sizes: number[]
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/**
 * Associate per-frame detections into person tracks, most prominent first.
 * Track 0 is the "main" dancer (largest median body size among well-covered tracks).
 */
export function associatePeople(frames: DetectedFrame[], opts: AssociateOptions = {}): PersonFrame[][] {
  const maxJump = opts.maxJump ?? 0.3
  const maxGapSec = opts.maxGapSec ?? 2.5
  const minCoverage = opts.minCoverage ?? 0.25

  const open: OpenTrack[] = []
  const closed: OpenTrack[] = []

  for (const frame of frames.slice().sort((a, b) => a.t - b.t)) {
    // Close tracks that have been gone too long.
    for (let i = open.length - 1; i >= 0; i--) {
      if (frame.t - open[i]!.lastT > maxGapSec) closed.push(...open.splice(i, 1))
    }

    const candidates = frame.people
      .map((p) => ({ p, c: torsoCenter(p.image), s: torsoSize(p.image) }))
      .filter((x): x is { p: DetectedPerson; c: { x: number; y: number }; s: number } => x.c !== null)

    // Greedy matching: repeatedly take the globally closest (track, person) pair.
    const pairs: Array<{ ti: number; ci: number; d: number }> = []
    open.forEach((tr, ti) =>
      candidates.forEach((cand, ci) => {
        const d = Math.hypot(tr.last.x - cand.c.x, tr.last.y - cand.c.y)
        if (d <= maxJump) pairs.push({ ti, ci, d })
      }),
    )
    pairs.sort((a, b) => a.d - b.d)
    const usedT = new Set<number>()
    const usedC = new Set<number>()
    for (const { ti, ci } of pairs) {
      if (usedT.has(ti) || usedC.has(ci)) continue
      usedT.add(ti)
      usedC.add(ci)
      const tr = open[ti]!
      const cand = candidates[ci]!
      tr.frames.push({ t: frame.t, world: cand.p.world, image: cand.p.image })
      tr.last = cand.c
      tr.lastT = frame.t
      tr.sizes.push(cand.s)
    }
    // Unmatched detections start new tracks.
    candidates.forEach((cand, ci) => {
      if (usedC.has(ci)) return
      open.push({
        frames: [{ t: frame.t, world: cand.p.world, image: cand.p.image }],
        last: cand.c,
        lastT: frame.t,
        sizes: [cand.s],
      })
    })
  }
  closed.push(...open)

  // Keep tracks that were around for a meaningful share of the video, then order by
  // prominence (median body size) so track 0 is the main dancer.
  const total = frames.length
  return closed
    .filter((tr) => total > 0 && tr.frames.length >= Math.max(2, total * minCoverage))
    .sort((a, b) => median(b.sizes) - median(a.sizes))
    .map((tr) => tr.frames)
}
