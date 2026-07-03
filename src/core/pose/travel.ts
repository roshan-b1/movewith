// Stage travel for the 3D dancer, from IMAGE-SPACE landmarks. World landmarks are
// hip-centered per frame (MediaPipe), so an instructor walking toward the camera or
// across the frame leaves no trace in them — but it shows in the image: the body's
// apparent size grows with proximity, and the hip midpoint tracks lateral position.
// Comparing each frame against the routine's median gives a camera-relative offset.

import { LM, type Landmark } from './types'

export interface TorsoAnchor {
  /** Apparent torso length in image space (shoulder midpoint → hip midpoint). */
  size: number
  /** Hip midpoint x in image space (0..1). */
  x: number
}

/** Meters of lateral travel per unit of normalized image width. */
const X_SCALE = 2.2
/** Meters of depth travel per unit of relative size change. */
const Z_SCALE = 2.2
const X_MAX = 1.0
const Z_TOWARD_MAX = 1.1
const Z_AWAY_MAX = 1.0

/**
 * The torso anchor of one frame's image landmarks, or null when the torso isn't
 * confidently visible (all four torso points need decent visibility).
 */
export function torsoAnchor(image: Landmark[] | undefined, minVisibility = 0.4): TorsoAnchor | null {
  if (!image) return null
  const ls = image[LM.leftShoulder]
  const rs = image[LM.rightShoulder]
  const lh = image[LM.leftHip]
  const rh = image[LM.rightHip]
  if (!ls || !rs || !lh || !rh) return null
  for (const p of [ls, rs, lh, rh]) if ((p.visibility ?? 1) < minVisibility) return null
  const sx = (ls.x + rs.x) / 2
  const sy = (ls.y + rs.y) / 2
  const hx = (lh.x + rh.x) / 2
  const hy = (lh.y + rh.y) / 2
  const size = Math.hypot(sx - hx, sy - hy)
  if (!Number.isFinite(size) || size < 0.01) return null
  return { size, x: hx }
}

/** Median torso anchor across a routine — the dancer's "home" distance and position. */
export function travelBaseline(
  frames: ReadonlyArray<{ image?: Landmark[] }>,
  maxSamples = 240,
): TorsoAnchor | null {
  const sizes: number[] = []
  const xs: number[] = []
  const step = Math.max(1, Math.floor(frames.length / maxSamples))
  for (let i = 0; i < frames.length; i += step) {
    const a = torsoAnchor(frames[i]?.image)
    if (a) {
      sizes.push(a.size)
      xs.push(a.x)
    }
  }
  // Too few visible frames to trust a median — no travel rather than wrong travel.
  if (sizes.length < 8) return null
  sizes.sort((a, b) => a - b)
  xs.sort((a, b) => a - b)
  return { size: sizes[sizes.length >> 1]!, x: xs[xs.length >> 1]! }
}

/**
 * Camera-relative stage offset (meters) for a frame vs the routine's baseline.
 * +x = viewer's right; +z = toward the camera (three.js convention).
 */
export function stageTravel(current: TorsoAnchor, base: TorsoAnchor): { x: number; z: number } {
  const x = clamp((current.x - base.x) * X_SCALE, -X_MAX, X_MAX)
  // Apparent size scales inversely with distance: larger torso → closer → +z.
  const z = clamp(Z_SCALE * (1 - base.size / Math.max(current.size, 1e-3)), -Z_AWAY_MAX, Z_TOWARD_MAX)
  return { x, z }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
