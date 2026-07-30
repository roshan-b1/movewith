// Section scoring: take everything the dancer did during one 8-count (a sequence of
// angle vectors), DTW-align it to the reference's angle vectors for that section, and
// average the per-pair frame scores. This is the timing-forgiving grade used to decide
// whether the section is "got it" and the next one unlocks.

import { dtw, type DtwOptions } from './dtw'
import { compareAngles, type ScoreConfig, STRICT, type LimbResult } from './similarity'
import type { Limb } from '../pose/angles'

export interface SectionScore {
  /** 0..100 over the DTW-aligned take. */
  score: number
  /** Worst-performing limb, useful for a one-line coaching tip. */
  worstLimb: Limb | null
  perLimb: Record<Limb, LimbResult>
  /** Number of aligned frame pairs scored. */
  pairs: number
  /**
   * Mean timing offset of the dancer vs the reference, as a fraction of the section
   * (-1..1). The DTW path says which live frame matched each reference frame; when the
   * live frame sits consistently LATER in the take than the reference frame does in the
   * section, the dancer is running behind (positive). Negative = rushing ahead.
   * Multiply by the section duration for seconds.
   */
  timingNorm: number
}

const ALL_LIMBS: readonly Limb[] = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'torso']

/**
 * Score a take against a reference section.
 * @param refAngles  reference angle vectors for the section, in time order
 * @param liveAngles the dancer's angle vectors captured during the take
 */
export function scoreSection(
  refAngles: number[][],
  liveAngles: number[][],
  cfg: ScoreConfig = STRICT,
  dtwOptions?: DtwOptions,
): SectionScore {
  const emptyLimbs = () =>
    Object.fromEntries(ALL_LIMBS.map((l) => [l, { errorDeg: 0, ok: true }])) as Record<Limb, LimbResult>

  if (refAngles.length === 0 || liveAngles.length === 0) {
    return { score: 0, worstLimb: null, perLimb: emptyLimbs(), pairs: 0, timingNorm: 0 }
  }

  const { path } = dtw(refAngles, liveAngles, dtwOptions)
  if (path.length === 0) {
    return { score: 0, worstLimb: null, perLimb: emptyLimbs(), pairs: 0, timingNorm: 0 }
  }

  let scoreSum = 0
  let offsetSum = 0
  const refSpan = Math.max(1, refAngles.length - 1)
  const liveSpan = Math.max(1, liveAngles.length - 1)
  const limbErrSum: Record<string, number> = {}

  for (const [ri, li] of path) {
    const cmp = compareAngles(refAngles[ri]!, liveAngles[li]!, cfg)
    scoreSum += cmp.score
    offsetSum += li / liveSpan - ri / refSpan
    for (const limb of ALL_LIMBS) {
      limbErrSum[limb] = (limbErrSum[limb] ?? 0) + cmp.perLimb[limb].errorDeg
    }
  }

  const perLimb = {} as Record<Limb, LimbResult>
  let worstLimb: Limb | null = null
  let worstErr = -1
  for (const limb of ALL_LIMBS) {
    const avg = (limbErrSum[limb] ?? 0) / path.length
    perLimb[limb] = { errorDeg: avg, ok: avg <= cfg.limbOkDeg }
    if (avg > worstErr) {
      worstErr = avg
      worstLimb = limb
    }
  }

  return {
    score: scoreSum / path.length,
    worstLimb,
    perLimb,
    pairs: path.length,
    timingNorm: offsetSum / path.length,
  }
}

/**
 * Turn a timing offset into a coaching line, or null when the dancer was basically on
 * time. Expressed in beats when the tempo is known (dancers count in beats, not seconds).
 */
export function describeTiming(
  timingNorm: number,
  durationSec: number,
  beatIntervalSec?: number,
): string | null {
  const sec = timingNorm * durationSec
  const beats = beatIntervalSec && beatIntervalSec > 0 ? sec / beatIntervalSec : null
  // On time: within a third of a beat (or 0.25s without a tempo).
  if (beats !== null ? Math.abs(beats) < 0.34 : Math.abs(sec) < 0.25) return null
  const amount =
    beats !== null
      ? Math.abs(beats) < 0.75
        ? 'about half a beat'
        : Math.abs(beats) < 1.5
          ? 'about a beat'
          : `about ${Math.round(Math.abs(beats))} beats`
      : `about ${Math.abs(sec).toFixed(1)}s`
  return sec > 0
    ? `Timing: you ran ${amount} behind the music. Start each move a touch sooner.`
    : `Timing: you rushed ${amount} ahead of the music. Let the beat catch up to you.`
}

export type SectionPhase = 'start' | 'middle' | 'end'

export interface PhaseScore {
  phase: SectionPhase
  score: number
}

/** SectionScore plus WHERE in the segment it went wrong (start / middle / end). */
export interface DetailedSectionScore extends SectionScore {
  phases: PhaseScore[]
}

const PHASES: readonly SectionPhase[] = ['start', 'middle', 'end']

/**
 * Score a take with a per-phase breakdown: the reference and the take are each cut into
 * thirds (by time order) and scored independently, so feedback can say not just WHAT was
 * off (worst limb) but WHEN (e.g. "the ending slipped"). Sequences too short to cut
 * meaningfully return no phases.
 */
export function scoreSectionDetailed(
  refAngles: number[][],
  liveAngles: number[][],
  cfg: ScoreConfig = STRICT,
  dtwOptions?: DtwOptions,
): DetailedSectionScore {
  const overall = scoreSection(refAngles, liveAngles, cfg, dtwOptions)
  const phases: PhaseScore[] = []
  if (refAngles.length >= 6 && liveAngles.length >= 6) {
    for (let i = 0; i < 3; i++) {
      const r = refAngles.slice(Math.floor((refAngles.length * i) / 3), Math.ceil((refAngles.length * (i + 1)) / 3))
      const l = liveAngles.slice(Math.floor((liveAngles.length * i) / 3), Math.ceil((liveAngles.length * (i + 1)) / 3))
      phases.push({ phase: PHASES[i]!, score: scoreSection(r, l, cfg, dtwOptions).score })
    }
  }
  return { ...overall, phases }
}

// ---- Run summary: grading a whole run-through, segment by segment ----------------------

/** How a segment landed. Drives the "which sections were perfect, which were close" recap. */
export type SegmentGrade = 'nailed' | 'close' | 'off'

/** Thresholds for the three buckets (0..100). Kept here so UI and summary agree. */
export const GRADE_NAILED = 85
export const GRADE_CLOSE = 65

export function gradeScore(score: number): SegmentGrade {
  if (score >= GRADE_NAILED) return 'nailed'
  if (score >= GRADE_CLOSE) return 'close'
  return 'off'
}

export interface RatedSegment {
  /** Segment index (0-based) as shown to the dancer (+1). */
  index: number
  score: number
  worstLimb: Limb | null
  /** Which third of the segment slipped the most (start / middle / end), when known. */
  worstPhase: SectionPhase | null
  grade: SegmentGrade
}

export interface RunSummary {
  segments: RatedSegment[]
  /** Average score across the rated segments (0..100). */
  overall: number
  nailed: number
  close: number
  off: number
}

/**
 * Roll up a full run-through (each segment scored on its own) into an overall grade plus
 * the per-segment buckets. Empty input → a zeroed summary (nothing was rated).
 */
export function summarizeRun(
  items: { index: number; score: number; worstLimb: Limb | null; worstPhase?: SectionPhase | null }[],
): RunSummary {
  const segments: RatedSegment[] = items.map((it) => ({
    index: it.index,
    score: it.score,
    worstLimb: it.worstLimb,
    worstPhase: it.worstPhase ?? null,
    grade: gradeScore(it.score),
  }))
  const overall = segments.length ? segments.reduce((s, x) => s + x.score, 0) / segments.length : 0
  return {
    segments,
    overall,
    nailed: segments.filter((s) => s.grade === 'nailed').length,
    close: segments.filter((s) => s.grade === 'close').length,
    off: segments.filter((s) => s.grade === 'off').length,
  }
}
