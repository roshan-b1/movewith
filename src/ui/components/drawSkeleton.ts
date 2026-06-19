// Canvas skeleton renderer shared by the instructor ghost and your live overlay.
// Connections are colored by per-limb feedback (green = on, red = off) when provided.

import { POSE_CONNECTIONS, type Landmark } from '../../core/pose/types'
import type { Limb, LimbResult } from '../../core/compare/similarity'

/** Limb group for each entry in POSE_CONNECTIONS, used to color the overlay. */
const CONNECTION_LIMBS: readonly Limb[] = [
  'torso', // shoulderL-shoulderR
  'leftArm', // shoulderL-elbowL
  'leftArm', // elbowL-wristL
  'rightArm', // shoulderR-elbowR
  'rightArm', // elbowR-wristR
  'torso', // shoulderL-hipL
  'torso', // shoulderR-hipR
  'torso', // hipL-hipR
  'leftLeg', // hipL-kneeL
  'leftLeg', // kneeL-ankleL
  'rightLeg', // hipR-kneeR
  'rightLeg', // kneeR-ankleR
  'leftLeg', // ankleL-footL
  'rightLeg', // ankleR-footR
]

export type Projector = (lm: Landmark, width: number, height: number) => { x: number; y: number }

/** Default projection for image-normalised landmarks (0..1 -> pixels). */
export const imageProjector: Projector = (lm, w, h) => ({ x: lm.x * w, y: lm.y * h })

/**
 * Orthographic projection for world landmarks (meters, hip-centred, y-down) — used to
 * draw the synthetic instructor ghost. Tuned so a standing figure fills the frame.
 */
export const worldProjector: Projector = (lm, w, h) => ({
  x: (0.5 + lm.x * 0.95) * w,
  y: (0.46 + lm.y * 0.62) * h,
})

const COLORS = {
  good: '#36d399',
  bad: '#ff5c6c',
  neutral: '#9b8cff',
  joint: '#ffffff',
}

export interface DrawOptions {
  perLimb?: Record<Limb, LimbResult>
  project?: Projector
  lineWidth?: number
  jointRadius?: number
  baseColor?: string
  /** 0..1 visibility threshold below which a point is skipped. */
  minVisibility?: number
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[] | null,
  opts: DrawOptions = {},
): void {
  const { canvas } = ctx
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  if (!landmarks || landmarks.length === 0) return

  const project = opts.project ?? imageProjector
  const lineWidth = opts.lineWidth ?? Math.max(3, w * 0.006)
  const jointRadius = opts.jointRadius ?? Math.max(3, w * 0.007)
  const minVis = opts.minVisibility ?? 0

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  POSE_CONNECTIONS.forEach(([aIdx, bIdx], i) => {
    const a = landmarks[aIdx]
    const b = landmarks[bIdx]
    if (!a || !b) return
    if ((a.visibility ?? 1) < minVis || (b.visibility ?? 1) < minVis) return

    let color = opts.baseColor ?? COLORS.neutral
    if (opts.perLimb) {
      const limb = CONNECTION_LIMBS[i]!
      color = opts.perLimb[limb]?.ok ? COLORS.good : COLORS.bad
    }

    const pa = project(a, w, h)
    const pb = project(b, w, h)
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()
  })

  // Joints on top.
  ctx.fillStyle = opts.baseColor ?? COLORS.joint
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < minVis) continue
    const p = project(lm, w, h)
    ctx.beginPath()
    ctx.arc(p.x, p.y, jointRadius, 0, Math.PI * 2)
    ctx.fill()
  }
}
