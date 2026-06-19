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
    return { score: 0, worstLimb: null, perLimb: emptyLimbs(), pairs: 0 }
  }

  const { path } = dtw(refAngles, liveAngles, dtwOptions)
  if (path.length === 0) {
    return { score: 0, worstLimb: null, perLimb: emptyLimbs(), pairs: 0 }
  }

  let scoreSum = 0
  const limbErrSum: Record<string, number> = {}

  for (const [ri, li] of path) {
    const cmp = compareAngles(refAngles[ri]!, liveAngles[li]!, cfg)
    scoreSum += cmp.score
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
  }
}
