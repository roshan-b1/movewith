// Built-in Macarena routine — the classic 16-count sequence, generated as landmarks so
// the whole app (3D dancer, segments, scoring) treats it like any extracted video.
// Unlike the warm-up demo's compact params, arms here are authored as explicit 3D
// elbow/wrist offsets from each shoulder (the Macarena lives in front of and behind the
// body — a frontal-plane abduction model can't express it). Coordinates follow BlazePose
// world conventions: x = person's LEFT, y = DOWN, z = toward camera NEGATIVE.
//
// Each 16-count phrase ends with the quarter-turn jump, so the routine runs the sequence
// four times facing front → left → back → right, like the real dance.

import { LANDMARK_COUNT, LM, type Landmark } from '../pose/types'
import { makeTempo } from '../audio/beats'
import { buildReferenceTrack } from '../reference/build'
import type { RawFrame } from '../reference/build'
import type { ReferenceTrack } from '../reference/types'

// v1: initial choreography.
export const MACARENA_TRACK_ID = 'macarena-v1'
export const OLD_MACARENA_TRACK_IDS: string[] = []

const BPM = 103 // the song's actual tempo neighborhood
const PHRASE_BEATS = 16
const PHRASES = 4
const TOTAL_BEATS = PHRASE_BEATS * PHRASES

/** One arm's pose: elbow and wrist offsets (meters) relative to its shoulder. */
type Arm = [ex: number, ey: number, ez: number, wx: number, wy: number, wz: number]

interface Pose {
  armL: Arm
  armR: Arm
  hipShiftX: number
  crouch: number
  knee: number // both knees, degrees
}

// ---- arm vocabulary (authored for the RIGHT arm; mirrored for the left) ----
// Offsets are from the arm's own shoulder. Right side is -x, so "toward the other
// shoulder" is +x here and gets mirrored automatically for the left arm.
const A_REST: Arm = [-0.04, 0.25, -0.02, -0.06, 0.48, -0.04]
const A_FRONT: Arm = [-0.02, 0.03, -0.26, -0.03, 0.05, -0.5]
const A_FRONT_UP: Arm = [-0.02, 0.05, -0.26, -0.03, -0.02, -0.49] // palm-flip beat: slight lift
const A_CROSS_SHOULDER: Arm = [-0.04, 0.17, -0.19, 0.3, 0.03, -0.12] // hand → opposite shoulder
const A_BEHIND_HEAD: Arm = [-0.25, -0.01, 0.03, 0.1, -0.14, 0.09] // elbow wide, hand behind neck
const A_CROSS_HIP: Arm = [0.0, 0.24, -0.02, 0.26, 0.42, 0.09] // hand → opposite back hip
const A_OWN_HIP: Arm = [-0.14, 0.22, 0.02, 0.02, 0.4, 0.08] // hand on own hip, elbow out

function mirrorArm(a: Arm): Arm {
  return [-a[0], a[1], a[2], -a[3], a[4], a[5]]
}

interface Key {
  beat: number
  pose: Partial<Pose>
}

const REST: Pose = { armL: mirrorArm(A_REST), armR: A_REST, hipShiftX: 0, crouch: 0, knee: 0 }

// The classic sequence, one move per count. Right leads (as traditionally taught).
const PHRASE: Key[] = [
  { beat: 0, pose: REST },
  { beat: 1, pose: { armR: A_FRONT } }, // right arm out, palm down
  { beat: 2, pose: { armL: mirrorArm(A_FRONT) } }, // left arm out
  { beat: 3, pose: { armR: A_FRONT_UP } }, // right palm up
  { beat: 4, pose: { armL: mirrorArm(A_FRONT_UP) } }, // left palm up
  { beat: 5, pose: { armR: A_CROSS_SHOULDER } }, // right hand → left shoulder
  { beat: 6, pose: { armL: mirrorArm(A_CROSS_SHOULDER) } }, // left hand → right shoulder
  { beat: 7, pose: { armR: A_BEHIND_HEAD } }, // right hand behind head
  { beat: 8, pose: { armL: mirrorArm(A_BEHIND_HEAD) } }, // left hand behind head
  { beat: 9, pose: { armR: A_CROSS_HIP } }, // right hand → left hip (behind)
  { beat: 10, pose: { armL: mirrorArm(A_CROSS_HIP) } }, // left hand → right hip
  { beat: 11, pose: { armR: A_OWN_HIP, armL: mirrorArm(A_OWN_HIP), hipShiftX: 0.1, crouch: 0.03, knee: 12 } },
  { beat: 12, pose: { hipShiftX: -0.1 } }, // hips sway
  { beat: 13, pose: { hipShiftX: 0.1, crouch: 0.05 } },
  { beat: 14, pose: { hipShiftX: -0.08, crouch: 0.02 } },
  { beat: 15, pose: { hipShiftX: 0, crouch: 0.14, knee: 40, armR: A_REST, armL: mirrorArm(A_REST) } }, // sink to prep the jump
  // beat 16 = beat 0 of the next phrase (upright, turned 90°) — the yaw handles the spin.
]

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}
function lerpArm(a: Arm, b: Arm, t: number): Arm {
  return a.map((v, i) => lerp(v, b[i]!, t)) as Arm
}
const ease = (t: number) => (1 - Math.cos(Math.PI * t)) / 2

/** Resolve the full pose at a beat WITHIN one phrase (0..16), carrying values forward. */
function poseAtPhraseBeat(beat: number): Pose {
  let prev: Pose = REST
  const resolved: { beat: number; pose: Pose }[] = []
  for (const k of PHRASE) {
    const full = { ...prev, ...k.pose }
    resolved.push({ beat: k.beat, pose: full })
    prev = full
  }
  // Wrap: the phrase ends by returning to REST at beat 16 (the landing).
  resolved.push({ beat: PHRASE_BEATS, pose: { ...prev, ...REST } })
  if (beat <= 0) return resolved[0]!.pose
  for (let i = 0; i < resolved.length - 1; i++) {
    const a = resolved[i]!
    const b = resolved[i + 1]!
    if (beat >= a.beat && beat <= b.beat) {
      const t = ease((beat - a.beat) / Math.max(1e-6, b.beat - a.beat))
      return {
        armL: lerpArm(a.pose.armL, b.pose.armL, t),
        armR: lerpArm(a.pose.armR, b.pose.armR, t),
        hipShiftX: lerp(a.pose.hipShiftX, b.pose.hipShiftX, t),
        crouch: lerp(a.pose.crouch, b.pose.crouch, t),
        knee: lerp(a.pose.knee, b.pose.knee, t),
      }
    }
  }
  return resolved[resolved.length - 1]!.pose
}

/** Facing (degrees about vertical) at a global beat: hold, then spin on the last beat. */
function yawAtBeat(beat: number): number {
  const phrase = Math.floor(beat / PHRASE_BEATS)
  const inPhrase = beat - phrase * PHRASE_BEATS
  const base = phrase * 90
  // The jump-turn happens across the final beat of the phrase (15 → 16).
  if (inPhrase <= PHRASE_BEATS - 1) return base
  return base + ease(inPhrase - (PHRASE_BEATS - 1)) * 90
}

const D2R = Math.PI / 180
const THIGH = 0.42
const SHIN = 0.42

function buildLandmarks(p: Pose, yawDeg: number): Landmark[] {
  const L = (x: number, y: number, z = 0): Landmark => ({ x, y, z, visibility: 1 })
  const out: Landmark[] = Array.from({ length: LANDMARK_COUNT }, () => L(0, 0))

  const dx = p.hipShiftX
  const dy = p.crouch

  const lShoulder = { x: 0.18 + dx, y: -0.45 + dy }
  const rShoulder = { x: -0.18 + dx, y: -0.45 + dy }
  const lHip = { x: 0.1 + dx, y: 0 + dy }
  const rHip = { x: -0.1 + dx, y: 0 + dy }

  // Face with real depth so the head solver (and yaw) read correctly.
  out[LM.nose] = L(dx, -0.62 + dy, -0.06)
  out[LM.leftEye] = L(0.03 + dx, -0.65 + dy, -0.055)
  out[LM.rightEye] = L(-0.03 + dx, -0.65 + dy, -0.055)
  out[LM.leftEyeInner] = L(0.015 + dx, -0.65 + dy, -0.055)
  out[LM.rightEyeInner] = L(-0.015 + dx, -0.65 + dy, -0.055)
  out[LM.leftEyeOuter] = L(0.05 + dx, -0.65 + dy, -0.05)
  out[LM.rightEyeOuter] = L(-0.05 + dx, -0.65 + dy, -0.05)
  out[LM.leftEar] = L(0.07 + dx, -0.63 + dy)
  out[LM.rightEar] = L(-0.07 + dx, -0.63 + dy)
  out[LM.mouthLeft] = L(0.03 + dx, -0.58 + dy, -0.05)
  out[LM.mouthRight] = L(-0.03 + dx, -0.58 + dy, -0.05)

  out[LM.leftShoulder] = L(lShoulder.x, lShoulder.y)
  out[LM.rightShoulder] = L(rShoulder.x, rShoulder.y)
  out[LM.leftHip] = L(lHip.x, lHip.y)
  out[LM.rightHip] = L(rHip.x, rHip.y)

  // Arms straight from authored offsets.
  const arm = (sh: { x: number; y: number }, a: Arm, elbowIdx: number, wristIdx: number, hand: number[]) => {
    out[elbowIdx] = L(sh.x + a[0], sh.y + a[1], a[2])
    out[wristIdx] = L(sh.x + a[3], sh.y + a[4], a[5])
    // Stub hand points: kept nearly coincident ON PURPOSE — the dancer's wrist driver
    // gates on index/pinky being distinct, and these synthetic hands shouldn't drive it.
    for (const idx of hand) out[idx] = L(sh.x + a[3], sh.y + a[4] + 0.04, a[5])
  }
  arm(lShoulder, p.armL, LM.leftElbow, LM.leftWrist, [LM.leftPinky, LM.leftIndex, LM.leftThumb])
  arm(rShoulder, p.armR, LM.rightElbow, LM.rightWrist, [LM.rightPinky, LM.rightIndex, LM.rightThumb])

  // Legs: sagittal knee bend (same scheme as the warm-up demo — squats read from the front).
  const legChain = (hip: { x: number; y: number }) => {
    const half = (p.knee / 2) * D2R
    const c = Math.cos(half)
    const s = Math.sin(half)
    const kneePt = { x: hip.x, y: hip.y + c * THIGH, z: -s * THIGH }
    const anklePt = { x: hip.x, y: kneePt.y + c * SHIN, z: kneePt.z + s * SHIN }
    return { kneePt, anklePt }
  }
  const ll = legChain(lHip)
  const rl = legChain(rHip)
  out[LM.leftKnee] = L(ll.kneePt.x, ll.kneePt.y, ll.kneePt.z)
  out[LM.leftAnkle] = L(ll.anklePt.x, ll.anklePt.y, ll.anklePt.z)
  out[LM.rightKnee] = L(rl.kneePt.x, rl.kneePt.y, rl.kneePt.z)
  out[LM.rightAnkle] = L(rl.anklePt.x, rl.anklePt.y, rl.anklePt.z)
  out[LM.leftHeel] = L(ll.anklePt.x, ll.anklePt.y + 0.03, ll.anklePt.z + 0.02)
  out[LM.rightHeel] = L(rl.anklePt.x, rl.anklePt.y + 0.03, rl.anklePt.z + 0.02)
  out[LM.leftFootIndex] = L(ll.anklePt.x + 0.08, ll.anklePt.y + 0.04, ll.anklePt.z - 0.05)
  out[LM.rightFootIndex] = L(rl.anklePt.x - 0.08, rl.anklePt.y + 0.04, rl.anklePt.z - 0.05)

  // Finally rotate the whole body about the vertical axis for the phrase facing.
  if (yawDeg !== 0) {
    const r = yawDeg * D2R
    const c = Math.cos(r)
    const s = Math.sin(r)
    for (const lm of out) {
      const x = lm.x
      const z = lm.z ?? 0
      lm.x = x * c + z * s
      lm.z = -x * s + z * c
    }
  }
  return out
}

/** Build the bundled Macarena ReferenceTrack. `createdAt` injected for determinism. */
export function generateMacarena(createdAt: number, fps = 24): ReferenceTrack {
  const tempo = makeTempo(BPM, 0)
  const durationSec = (TOTAL_BEATS * 60) / BPM // ≈ 37.3s
  const frameCount = Math.round(durationSec * fps)

  const rawFrames: RawFrame[] = []
  for (let i = 0; i <= frameCount; i++) {
    const t = i / fps
    const beat = Math.min((t * BPM) / 60, TOTAL_BEATS)
    const inPhrase = beat % PHRASE_BEATS
    rawFrames.push({ t, world: buildLandmarks(poseAtPhraseBeat(inPhrase), yawAtBeat(beat)) })
  }

  return buildReferenceTrack({
    id: MACARENA_TRACK_ID,
    name: 'Macarena (built-in)',
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
