// Framework-agnostic pose types. No DOM, no MediaPipe imports here — this is the
// neutral shape every PoseProvider must produce, so the engine never depends on a
// specific tracking library.

/** A single tracked body point. Coordinates are in MediaPipe "world" space
 *  (meters, origin near the hips) for `world` landmarks, which is what we use for
 *  angle math because it is camera-distance and body-size independent. */
export interface Landmark {
  x: number
  y: number
  z: number
  /** 0..1 confidence that the point is present/visible. Optional. */
  visibility?: number
}

/** One detected pose at a moment in time. */
export interface PoseFrame {
  /** Seconds from the start of the source (video time or session time). */
  t: number
  /** 33 world landmarks (BlazePose). */
  world: Landmark[]
  /** Precomputed joint-angle vector (degrees), in JOINT_ORDER. Filled by the engine. */
  angles?: number[]
}

/** BlazePose 33-landmark indices. Single source of truth for the whole app. */
export const LM = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const

export const LANDMARK_COUNT = 33

/** Skeleton edges (pairs of landmark indices) for drawing the overlay. */
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftElbow],
  [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow],
  [LM.rightElbow, LM.rightWrist],
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip],
  [LM.leftHip, LM.rightHip],
  [LM.leftHip, LM.leftKnee],
  [LM.leftKnee, LM.leftAnkle],
  [LM.rightHip, LM.rightKnee],
  [LM.rightKnee, LM.rightAnkle],
  [LM.leftAnkle, LM.leftFootIndex],
  [LM.rightAnkle, LM.rightFootIndex],
]
