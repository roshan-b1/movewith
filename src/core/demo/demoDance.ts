// A bundled "instructor" the app can teach on first open with zero assets — no video
// file required. We synthesize a real 16-second, 4×8-count routine by animating joint
// angles through forward kinematics into 33 world landmarks. The rest of the app treats
// it exactly like an extracted video: same ReferenceTrack, same scoring, same overlay.

import { LANDMARK_COUNT, LM, type Landmark } from '../pose/types'
import { makeTempo } from '../audio/beats'
import { buildReferenceTrack } from '../reference/build'
import type { RawFrame } from '../reference/build'
import type { ReferenceTrack } from '../reference/types'

/** Compact pose parameters; everything else is derived by FK. Angles in degrees. */
interface PoseParams {
  /** Upper-arm angle from straight-down: 0 = arms at sides, 90 = T, 180 = overhead. */
  armAbductionL: number
  armAbductionR: number
  /** Elbow bend: 0 = straight, 90 = forearm square. */
  elbowL: number
  elbowR: number
  /** Knee bend for squats/steps: 0 = straight. */
  kneeL: number
  kneeR: number
  /** Sideways hip shift (meters) for side-steps. +x = person's left. */
  hipShiftX: number
  /** Lowering of the whole upper body (meters) for crouches. */
  crouch: number
}

const REST: PoseParams = {
  armAbductionL: 10,
  armAbductionR: 10,
  elbowL: 5,
  elbowR: 5,
  kneeL: 0,
  kneeR: 0,
  hipShiftX: 0,
  crouch: 0,
}

const D2R = Math.PI / 180

// Segment lengths in meters (roughly adult proportions). y increases downward.
const UPPER_ARM = 0.26
const FOREARM = 0.24
const THIGH = 0.42
const SHIN = 0.42

function rot(v: { x: number; y: number }, deg: number) {
  const r = deg * D2R
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }
}

/** Build all 33 world landmarks from compact params via forward kinematics. */
function poseFromParams(p: PoseParams): Landmark[] {
  const L = (x: number, y: number, z = 0): Landmark => ({ x, y, z, visibility: 1 })
  const out: Landmark[] = Array.from({ length: LANDMARK_COUNT }, () => L(0, 0))

  const dx = p.hipShiftX
  const dy = p.crouch

  // Torso anchors (person's left is +x).
  const lShoulder = { x: 0.18 + dx, y: -0.45 + dy }
  const rShoulder = { x: -0.18 + dx, y: -0.45 + dy }
  const lHip = { x: 0.1 + dx, y: 0 + dy }
  const rHip = { x: -0.1 + dx, y: 0 + dy }

  // Head/face (approximate, so the overlay reads as a person).
  out[LM.nose] = L(dx, -0.62 + dy, 0.02)
  out[LM.leftEye] = L(0.03 + dx, -0.65 + dy)
  out[LM.rightEye] = L(-0.03 + dx, -0.65 + dy)
  out[LM.leftEyeInner] = L(0.015 + dx, -0.65 + dy)
  out[LM.rightEyeInner] = L(-0.015 + dx, -0.65 + dy)
  out[LM.leftEyeOuter] = L(0.05 + dx, -0.65 + dy)
  out[LM.rightEyeOuter] = L(-0.05 + dx, -0.65 + dy)
  out[LM.leftEar] = L(0.07 + dx, -0.63 + dy)
  out[LM.rightEar] = L(-0.07 + dx, -0.63 + dy)
  out[LM.mouthLeft] = L(0.03 + dx, -0.58 + dy)
  out[LM.mouthRight] = L(-0.03 + dx, -0.58 + dy)

  out[LM.leftShoulder] = L(lShoulder.x, lShoulder.y)
  out[LM.rightShoulder] = L(rShoulder.x, rShoulder.y)
  out[LM.leftHip] = L(lHip.x, lHip.y)
  out[LM.rightHip] = L(rHip.x, rHip.y)

  // Arms. Upper-arm starts pointing straight down (0,1); abduct outward.
  const armChain = (
    shoulder: { x: number; y: number },
    abduction: number,
    elbow: number,
    sign: 1 | -1, // +1 = person's left, abduct toward +x
  ) => {
    const upperDir = rot({ x: 0, y: 1 }, sign * abduction)
    const elbowPt = { x: shoulder.x + upperDir.x * UPPER_ARM, y: shoulder.y + upperDir.y * UPPER_ARM }
    const foreDir = rot(upperDir, sign * elbow)
    const wristPt = { x: elbowPt.x + foreDir.x * FOREARM, y: elbowPt.y + foreDir.y * FOREARM }
    return { elbowPt, wristPt }
  }

  const la = armChain(lShoulder, p.armAbductionL, p.elbowL, 1)
  const ra = armChain(rShoulder, p.armAbductionR, p.elbowR, -1)
  out[LM.leftElbow] = L(la.elbowPt.x, la.elbowPt.y)
  out[LM.leftWrist] = L(la.wristPt.x, la.wristPt.y)
  out[LM.rightElbow] = L(ra.elbowPt.x, ra.elbowPt.y)
  out[LM.rightWrist] = L(ra.wristPt.x, ra.wristPt.y)
  // Hands trail the wrists.
  for (const [w, set] of [
    [LM.leftWrist, [LM.leftPinky, LM.leftIndex, LM.leftThumb]],
    [LM.rightWrist, [LM.rightPinky, LM.rightIndex, LM.rightThumb]],
  ] as const) {
    for (const idx of set) out[idx] = L(out[w]!.x, out[w]!.y + 0.04)
  }

  // Legs. Thigh points down; knee bend swings shin backward (toward -y at the foot).
  const legChain = (hip: { x: number; y: number }, knee: number, sign: 1 | -1) => {
    const thighDir = { x: 0, y: 1 }
    const kneePt = { x: hip.x + thighDir.x * THIGH, y: hip.y + thighDir.y * THIGH }
    const shinDir = rot(thighDir, -sign * knee) // bend
    const anklePt = { x: kneePt.x + shinDir.x * SHIN, y: kneePt.y + shinDir.y * SHIN }
    return { kneePt, anklePt }
  }
  const ll = legChain(lHip, p.kneeL, 1)
  const rl = legChain(rHip, p.kneeR, -1)
  out[LM.leftKnee] = L(ll.kneePt.x, ll.kneePt.y)
  out[LM.leftAnkle] = L(ll.anklePt.x, ll.anklePt.y)
  out[LM.rightKnee] = L(rl.kneePt.x, rl.kneePt.y)
  out[LM.rightAnkle] = L(rl.anklePt.x, rl.anklePt.y)
  out[LM.leftHeel] = L(ll.anklePt.x, ll.anklePt.y + 0.03)
  out[LM.rightHeel] = L(rl.anklePt.x, rl.anklePt.y + 0.03)
  out[LM.leftFootIndex] = L(ll.anklePt.x + 0.08, ll.anklePt.y + 0.04)
  out[LM.rightFootIndex] = L(rl.anklePt.x - 0.08, rl.anklePt.y + 0.04)

  return out
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}
function lerpParams(a: PoseParams, b: PoseParams, t: number): PoseParams {
  return {
    armAbductionL: lerp(a.armAbductionL, b.armAbductionL, t),
    armAbductionR: lerp(a.armAbductionR, b.armAbductionR, t),
    elbowL: lerp(a.elbowL, b.elbowL, t),
    elbowR: lerp(a.elbowR, b.elbowR, t),
    kneeL: lerp(a.kneeL, b.kneeL, t),
    kneeR: lerp(a.kneeR, b.kneeR, t),
    hipShiftX: lerp(a.hipShiftX, b.hipShiftX, t),
    crouch: lerp(a.crouch, b.crouch, t),
  }
}
// Ease so keyframes feel like dance hits, not linear slides.
const ease = (t: number) => (1 - Math.cos(Math.PI * t)) / 2

/** A keyframe pinned to a beat (0..32 across four 8-counts). */
interface KeyFrame {
  beat: number
  params: Partial<PoseParams>
}

// 4 × 8-count routine (120 bpm). Beat 0..32. Each move lands on a count.
const ROUTINE: KeyFrame[] = [
  { beat: 0, params: REST },
  // 8-count #1 — arm raises (both arms up, down, up, down)
  { beat: 2, params: { armAbductionL: 165, armAbductionR: 165, elbowL: 5, elbowR: 5 } },
  { beat: 4, params: { armAbductionL: 10, armAbductionR: 10 } },
  { beat: 6, params: { armAbductionL: 165, armAbductionR: 165 } },
  { beat: 8, params: { armAbductionL: 10, armAbductionR: 10 } },
  // 8-count #2 — side steps with a reaching arm (T-pose lean)
  { beat: 10, params: { hipShiftX: 0.12, armAbductionL: 95, armAbductionR: 30, elbowR: 90 } },
  { beat: 12, params: { hipShiftX: 0, armAbductionL: 10, armAbductionR: 10, elbowR: 5 } },
  { beat: 14, params: { hipShiftX: -0.12, armAbductionR: 95, armAbductionL: 30, elbowL: 90 } },
  { beat: 16, params: { hipShiftX: 0, armAbductionL: 10, armAbductionR: 10, elbowL: 5 } },
  // 8-count #3 — T-pose hold to hands-on-hips
  { beat: 18, params: { armAbductionL: 90, armAbductionR: 90, elbowL: 5, elbowR: 5 } },
  { beat: 22, params: { armAbductionL: 90, armAbductionR: 90 } },
  { beat: 24, params: { armAbductionL: 35, armAbductionR: 35, elbowL: 110, elbowR: 110 } },
  // 8-count #4 — two squats with arms forward
  { beat: 26, params: { crouch: 0.18, kneeL: 55, kneeR: 55, armAbductionL: 80, armAbductionR: 80, elbowL: 80, elbowR: 80 } },
  { beat: 28, params: { crouch: 0, kneeL: 0, kneeR: 0, armAbductionL: 10, armAbductionR: 10, elbowL: 5, elbowR: 5 } },
  { beat: 30, params: { crouch: 0.18, kneeL: 55, kneeR: 55, armAbductionL: 80, armAbductionR: 80, elbowL: 80, elbowR: 80 } },
  { beat: 32, params: { crouch: 0, kneeL: 0, kneeR: 0, armAbductionL: 10, armAbductionR: 10, elbowL: 5, elbowR: 5 } },
]

function paramsAtBeat(beat: number): PoseParams {
  // Resolve full params at each keyframe by carrying forward previous values.
  let prev: PoseParams = REST
  const resolved: { beat: number; params: PoseParams }[] = []
  for (const kf of ROUTINE) {
    const full = { ...prev, ...kf.params }
    resolved.push({ beat: kf.beat, params: full })
    prev = full
  }
  if (beat <= resolved[0]!.beat) return resolved[0]!.params
  const last = resolved[resolved.length - 1]!
  if (beat >= last.beat) return last.params
  for (let i = 0; i < resolved.length - 1; i++) {
    const a = resolved[i]!
    const b = resolved[i + 1]!
    if (beat >= a.beat && beat <= b.beat) {
      const t = ease((beat - a.beat) / (b.beat - a.beat))
      return lerpParams(a.params, b.params, t)
    }
  }
  return last.params
}

export const DEMO_TRACK_ID = 'demo-routine-v1'

/** Build the bundled demo ReferenceTrack. `createdAt` is injected for determinism. */
export function generateDemoDance(createdAt: number, fps = 24): ReferenceTrack {
  const bpm = 120
  const beatsTotal = 32
  const tempo = makeTempo(bpm, 0)
  const durationSec = (beatsTotal * 60) / bpm // 16s
  const frameCount = Math.round(durationSec * fps)

  const rawFrames: RawFrame[] = []
  for (let i = 0; i <= frameCount; i++) {
    const t = (i / fps)
    const beat = (t * bpm) / 60
    rawFrames.push({ t, world: poseFromParams(paramsAtBeat(beat)) })
  }

  return buildReferenceTrack({
    id: DEMO_TRACK_ID,
    name: 'Warm-Up Routine (demo)',
    createdAt,
    videoBlobKey: null,
    durationSec,
    fps,
    rawFrames,
    tempo,
    beatsPerSection: 8,
    sourceType: 'bundled',
  })
}
