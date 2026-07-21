// Step-character recognition: say something true and useful about WHAT each segment's
// move is like, from kinematics alone — which limbs do the work, whether it travels
// across the floor, and whether it repeats (and how many times). Not a step-name
// classifier (that needs a labeled move dataset); this is the honest, dataset-free tier
// that still gives segments meaningful labels. Pure + testable.

import type { ReferenceFrame } from './types'
import { JOINT_LIMB } from '../pose/angles'
import { LM } from '../pose/types'

export interface MoveCharacter {
  /** Which part of the body carries the move. */
  focus: 'arms' | 'legs' | 'full body'
  /** The dancer covers ground (side to side) rather than dancing in place. */
  travels: boolean
  /** Repetition count when the move visibly repeats (≥2), else null. */
  reps: number | null
  /** Compact display label, e.g. "Footwork · 4×" or "Arms · travels". */
  label: string
}

const ARM_JOINTS: readonly number[] = JOINT_LIMB
  .map((l, i) => (l === 'leftArm' || l === 'rightArm' ? i : -1))
  .filter((i) => i >= 0)
const LEG_JOINTS: readonly number[] = JOINT_LIMB
  .map((l, i) => (l === 'leftLeg' || l === 'rightLeg' ? i : -1))
  .filter((i) => i >= 0)

/** One group clearly outworks the other at this ratio. */
const FOCUS_RATIO = 1.7
/** Mid-hip image-x must sweep this much of the frame to count as traveling. */
const TRAVEL_MIN_X = 0.15
/** Poses must vary at least this much (mean deg from the mean pose) to look for repeats. */
const MIN_SPREAD_DEG = 6
/** A repeat lag counts when poses at that lag differ by under this fraction of the spread. */
const REPEAT_MATCH = 0.5

/** Mean |Δangle| per second over the given joints across the window. */
function groupRate(win: ReferenceFrame[], joints: readonly number[]): number {
  let sum = 0
  let n = 0
  for (let i = 1; i < win.length; i++) {
    const dt = win[i]!.t - win[i - 1]!.t
    if (dt <= 1e-6 || dt > 2) continue
    for (const j of joints) sum += Math.abs((win[i]!.angles[j] ?? 0) - (win[i - 1]!.angles[j] ?? 0)) / dt
    n += joints.length
  }
  return n ? sum / n : 0
}

/** Mean |angles(t) − angles(t+lag)| per joint, averaged over all valid t. */
function lagDistance(win: ReferenceFrame[], lag: number): number {
  let sum = 0
  let n = 0
  for (let i = 0; i + lag < win.length; i++) {
    const a = win[i]!.angles
    const b = win[i + lag]!.angles
    const dims = Math.min(a.length, b.length)
    let d = 0
    for (let j = 0; j < dims; j++) d += Math.abs((a[j] ?? 0) - (b[j] ?? 0))
    sum += dims ? d / dims : 0
    n++
  }
  return n ? sum / n : Infinity
}

/**
 * Characterize the move inside [startSec, endSec]. Returns null when there's too little
 * pose data to say anything (callers just show no label).
 */
export function describeMove(frames: ReferenceFrame[], startSec: number, endSec: number): MoveCharacter | null {
  const win = frames.filter((f) => f.t >= startSec && f.t <= endSec)
  if (win.length < 8) return null

  // Focus: whose |Δangle|/sec is bigger, arms' or legs'?
  const armRate = groupRate(win, ARM_JOINTS)
  const legRate = groupRate(win, LEG_JOINTS)
  const focus: MoveCharacter['focus'] =
    armRate > legRate * FOCUS_RATIO ? 'arms' : legRate > armRate * FOCUS_RATIO ? 'legs' : 'full body'

  // Travel: how far the mid-hip point sweeps across the image (when image landmarks exist).
  let travels = false
  const xs: number[] = []
  for (const f of win) {
    const lh = f.image?.[LM.leftHip]
    const rh = f.image?.[LM.rightHip]
    if (lh && rh) xs.push((lh.x + rh.x) / 2)
  }
  if (xs.length >= win.length / 2) {
    travels = Math.max(...xs) - Math.min(...xs) >= TRAVEL_MIN_X
  }

  // Repeats: the smallest lag at which the pose sequence matches itself. A static hold
  // matches every lag, so require real pose variety first.
  let reps: number | null = null
  const dims = win.reduce((m, f) => Math.min(m, f.angles.length), Infinity)
  if (dims >= 1) {
    const mean = new Array(dims).fill(0)
    for (const f of win) for (let j = 0; j < dims; j++) mean[j] += f.angles[j] ?? 0
    for (let j = 0; j < dims; j++) mean[j] /= win.length
    let spread = 0
    for (const f of win) {
      let d = 0
      for (let j = 0; j < dims; j++) d += Math.abs((f.angles[j] ?? 0) - mean[j])
      spread += d / dims
    }
    spread /= win.length

    if (spread >= MIN_SPREAD_DEG) {
      const durSec = win[win.length - 1]!.t - win[0]!.t
      const perSec = win.length / Math.max(durSec, 0.001)
      const minLag = Math.max(2, Math.round(0.4 * perSec)) // repeats faster than 0.4s are noise
      const maxLag = Math.floor((win.length - 1) / 2) // need at least two full periods
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (lagDistance(win, lag) < spread * REPEAT_MATCH) {
          const n = Math.round(durSec / (lag / perSec))
          if (n >= 2) reps = n
          break
        }
      }
    }
  }

  const focusLabel = focus === 'arms' ? 'Arms' : focus === 'legs' ? 'Footwork' : 'Full body'
  const label = focusLabel + (travels ? ' · travels' : '') + (reps ? ` · ${reps}×` : '')
  return { focus, travels, reps, label }
}
