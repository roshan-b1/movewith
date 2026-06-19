// Joint-angle extraction. We compare dancers by JOINT ANGLES rather than raw
// positions because angles are invariant to body size, camera distance, and where
// the dancer stands in frame. Two people of different heights doing the same move
// produce nearly identical angle vectors.

import type { Landmark } from './types'
import { LM } from './types'

/** A body part grouping used for per-limb feedback (limb turns green/red). */
export type Limb = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'torso'

/** One tracked angle: the angle at vertex `b` formed by points a-b-c. */
export interface JointDef {
  name: string
  a: number
  b: number
  c: number
  limb: Limb
  /** Index in JOINT_ORDER of this joint's left/right mirror twin (for mirror mode). */
  mirrorName: string
}

/**
 * The angles we track. Vertex-based (the middle index is the corner). This set
 * captures the expressive joints for dance: elbows, armpits (shoulder), hips, knees.
 */
export const JOINTS: readonly JointDef[] = [
  { name: 'leftElbow', a: LM.leftShoulder, b: LM.leftElbow, c: LM.leftWrist, limb: 'leftArm', mirrorName: 'rightElbow' },
  { name: 'rightElbow', a: LM.rightShoulder, b: LM.rightElbow, c: LM.rightWrist, limb: 'rightArm', mirrorName: 'leftElbow' },
  { name: 'leftShoulder', a: LM.leftElbow, b: LM.leftShoulder, c: LM.leftHip, limb: 'leftArm', mirrorName: 'rightShoulder' },
  { name: 'rightShoulder', a: LM.rightElbow, b: LM.rightShoulder, c: LM.rightHip, limb: 'rightArm', mirrorName: 'leftShoulder' },
  { name: 'leftHip', a: LM.leftShoulder, b: LM.leftHip, c: LM.leftKnee, limb: 'leftLeg', mirrorName: 'rightHip' },
  { name: 'rightHip', a: LM.rightShoulder, b: LM.rightHip, c: LM.rightKnee, limb: 'rightLeg', mirrorName: 'leftHip' },
  { name: 'leftKnee', a: LM.leftHip, b: LM.leftKnee, c: LM.leftAnkle, limb: 'leftLeg', mirrorName: 'rightKnee' },
  { name: 'rightKnee', a: LM.rightHip, b: LM.rightKnee, c: LM.rightAnkle, limb: 'rightLeg', mirrorName: 'leftKnee' },
  // Trunk angles (at each hip, between the spine-up and the hip line) capture lean and
  // twist, so posture is actually graded instead of always reading "ok".
  { name: 'leftTrunk', a: LM.leftShoulder, b: LM.leftHip, c: LM.rightHip, limb: 'torso', mirrorName: 'rightTrunk' },
  { name: 'rightTrunk', a: LM.rightShoulder, b: LM.rightHip, c: LM.leftHip, limb: 'torso', mirrorName: 'leftTrunk' },
]

/** Fixed order of joint names — the index layout of every angle vector in the app. */
export const JOINT_ORDER: readonly string[] = JOINTS.map((j) => j.name)

/** name -> index in JOINT_ORDER */
export const JOINT_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  JOINT_ORDER.map((n, i) => [n, i]),
)

/** Precomputed permutation that swaps each joint with its left/right twin. */
export const MIRROR_PERMUTATION: readonly number[] = JOINTS.map((j) => JOINT_INDEX[j.mirrorName]!)

/** Angle (in degrees) at vertex `b` formed by the rays b->a and b->c, in 3D. */
export function angleAt(a: Landmark, b: Landmark, c: Landmark): number {
  const ux = a.x - b.x
  const uy = a.y - b.y
  const uz = a.z - b.z
  const vx = c.x - b.x
  const vy = c.y - b.y
  const vz = c.z - b.z

  const dot = ux * vx + uy * vy + uz * vz
  const lu = Math.hypot(ux, uy, uz)
  const lv = Math.hypot(vx, vy, vz)
  if (lu === 0 || lv === 0) return 0

  // Clamp guards against floating-point drift pushing the ratio outside [-1, 1].
  const cos = Math.min(1, Math.max(-1, dot / (lu * lv)))
  return (Math.acos(cos) * 180) / Math.PI
}

/**
 * Extract the full joint-angle vector (degrees) from a set of world landmarks,
 * in JOINT_ORDER. Missing/low-visibility points still produce a number; callers
 * can weight by visibility via {@link jointVisibility} if desired.
 */
export function jointAngles(world: Landmark[]): number[] {
  return JOINTS.map((j) => {
    const a = world[j.a]
    const b = world[j.b]
    const c = world[j.c]
    if (!a || !b || !c) return 0
    return angleAt(a, b, c)
  })
}

/** Minimum visibility across the three landmarks of each joint (0..1), in JOINT_ORDER. */
export function jointVisibility(world: Landmark[]): number[] {
  return JOINTS.map((j) => {
    const vs = [world[j.a]?.visibility, world[j.b]?.visibility, world[j.c]?.visibility]
    const known = vs.filter((v): v is number => typeof v === 'number')
    if (known.length === 0) return 1 // no info -> assume visible
    return Math.min(...known)
  })
}

/** Map a joint index to its limb group. */
export const JOINT_LIMB: readonly Limb[] = JOINTS.map((j) => j.limb)

/**
 * Mirror an angle vector by swapping each joint with its left/right twin. Because
 * angles are unsigned magnitudes, a mirrored "left elbow" is simply the "right
 * elbow" value — no landmark reflection needed. Used for mirror mode, where the
 * dancer faces the instructor like a mirror.
 */
export function mirrorAngles(angles: number[]): number[] {
  return MIRROR_PERMUTATION.map((srcIdx) => angles[srcIdx] ?? 0)
}
