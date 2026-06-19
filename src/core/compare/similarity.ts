// Turn two angle vectors (reference vs you) into a 0-100 score plus per-joint and
// per-limb breakdowns. The per-limb result drives the green/red skeleton overlay;
// the score drives the accuracy meter and the unlock-the-next-section gate.

import { JOINT_LIMB, JOINT_ORDER, type Limb } from '../pose/angles'

export type { Limb } from '../pose/angles'

/** How forgiving the grader is. Looser = bigger tolerance before a joint reads "off". */
export interface ScoreConfig {
  /** Angle error (degrees) at which a joint scores 0. Below it, score falls off linearly. */
  maxErrorDeg: number
  /** A limb is "ok" (green) when its average joint error is under this many degrees. */
  limbOkDeg: number
}

export const STRICT: ScoreConfig = { maxErrorDeg: 45, limbOkDeg: 18 }
export const LOOSE: ScoreConfig = { maxErrorDeg: 70, limbOkDeg: 30 }

export interface LimbResult {
  errorDeg: number
  ok: boolean
}

export interface FrameComparison {
  /** Overall 0..100, visibility-weighted average of per-joint quality. */
  score: number
  /** Per-joint absolute angle error in degrees, in JOINT_ORDER. */
  perJointErrorDeg: number[]
  /** Per-joint quality 0..1, in JOINT_ORDER. */
  perJointQuality: number[]
  /** Aggregated per-limb feedback. */
  perLimb: Record<Limb, LimbResult>
}

const ALL_LIMBS: readonly Limb[] = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'torso']

/** Smallest absolute difference between two angles in degrees (both already 0..180). */
export function angleError(refDeg: number, liveDeg: number): number {
  return Math.abs(refDeg - liveDeg)
}

/**
 * Compare a reference angle vector against a live one.
 * @param weights optional per-joint weights (e.g. visibility 0..1); defaults to 1.
 */
export function compareAngles(
  ref: number[],
  live: number[],
  cfg: ScoreConfig = STRICT,
  weights?: number[],
): FrameComparison {
  const n = JOINT_ORDER.length
  const perJointErrorDeg: number[] = new Array(n).fill(0)
  const perJointQuality: number[] = new Array(n).fill(0)

  // Accumulators for limb errors.
  const limbErrSum: Record<string, number> = {}
  const limbErrCount: Record<string, number> = {}

  let weightedQualitySum = 0
  let weightSum = 0

  for (let i = 0; i < n; i++) {
    const err = angleError(ref[i] ?? 0, live[i] ?? 0)
    const quality = Math.min(1, Math.max(0, 1 - err / cfg.maxErrorDeg))
    perJointErrorDeg[i] = err
    perJointQuality[i] = quality

    const w = weights ? Math.min(1, Math.max(0, weights[i] ?? 1)) : 1
    weightedQualitySum += quality * w
    weightSum += w

    const limb = JOINT_LIMB[i]!
    limbErrSum[limb] = (limbErrSum[limb] ?? 0) + err
    limbErrCount[limb] = (limbErrCount[limb] ?? 0) + 1
  }

  const perLimb = {} as Record<Limb, LimbResult>
  for (const limb of ALL_LIMBS) {
    const count = limbErrCount[limb] ?? 0
    const avg = count > 0 ? (limbErrSum[limb] ?? 0) / count : 0
    perLimb[limb] = { errorDeg: avg, ok: count === 0 ? true : avg <= cfg.limbOkDeg }
  }

  const score = weightSum > 0 ? (weightedQualitySum / weightSum) * 100 : 0
  return { score, perJointErrorDeg, perJointQuality, perLimb }
}

/** Cosine similarity of two equal-length vectors, in [-1, 1]. Utility for DTW/analysis. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
