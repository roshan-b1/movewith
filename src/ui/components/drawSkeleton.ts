// Canvas skeleton renderer shared by the instructor ghost and your live overlay.
// Connections are colored by per-limb feedback (green = on, red = off) when provided.

import { LM, POSE_CONNECTIONS, type Landmark } from '../../core/pose/types'
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

/** Projects image-space landmarks (0..1) onto a canvas overlaying an `object-contain`
 *  video, accounting for the letterbox bars so the skeleton lines up with the dancer. */
export function containProjector(videoW: number, videoH: number): Projector {
  return (lm, w, h) => {
    if (!videoW || !videoH) return { x: lm.x * w, y: lm.y * h }
    const videoAspect = videoW / videoH
    const boxAspect = w / h
    let dispW: number, dispH: number, offX: number, offY: number
    if (videoAspect > boxAspect) {
      dispW = w
      dispH = w / videoAspect
      offX = 0
      offY = (h - dispH) / 2
    } else {
      dispH = h
      dispW = h * videoAspect
      offY = 0
      offX = (w - dispW) / 2
    }
    return { x: offX + lm.x * dispW, y: offY + lm.y * dispH }
  }
}

/** Projects image-space landmarks (0..1) onto a canvas overlaying an `object-cover`
 *  video. Cover SCALES UP to fill the box and crops the overflow, so the landmarks have
 *  to be scaled and offset the same way (the offsets go negative — that's the cropped
 *  part). Without this the skeleton is stretched across the full canvas while the video
 *  underneath is cropped, and the lines drift off the dancer's body. */
export function coverProjector(videoW: number, videoH: number): Projector {
  return (lm, w, h) => {
    if (!videoW || !videoH) return { x: lm.x * w, y: lm.y * h }
    const scale = Math.max(w / videoW, h / videoH)
    const dispW = videoW * scale
    const dispH = videoH * scale
    const offX = (w - dispW) / 2
    const offY = (h - dispH) / 2
    return { x: offX + lm.x * dispW, y: offY + lm.y * dispH }
  }
}

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
  good: '#a3e635',
  bad: '#ff4d6d',
  neutral: '#ff2e88',
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
  /** Set false to draw WITHOUT clearing the canvas first (stacking several skeletons,
   *  e.g. the multi-dancer picker). Default true. */
  clear?: boolean
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[] | null,
  opts: DrawOptions = {},
): void {
  const { canvas } = ctx
  const w = canvas.width
  const h = canvas.height
  if (opts.clear !== false) ctx.clearRect(0, 0, w, h)
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

type Pt = { x: number; y: number }
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/**
 * Draw the instructor as a proper human silhouette: small head + neck, a torso that
 * tapers to a waist, and limbs that get thinner toward the hands and feet, with soft
 * joints. Built from the same landmarks but shaped like a person, not a stick toy.
 */
export function drawHumanFigure(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[] | null,
  opts: { project?: Projector; color?: string } = {},
): void {
  const { canvas } = ctx
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  if (!landmarks || landmarks.length === 0) return

  const project = opts.project ?? worldProjector
  const P = (i: number): Pt | null => {
    const lm = landmarks[i]
    return lm ? project(lm, w, h) : null
  }

  const ls = P(LM.leftShoulder)
  const rs = P(LM.rightShoulder)
  const lh = P(LM.leftHip)
  const rh = P(LM.rightHip)
  if (!ls || !rs || !lh || !rh) return

  const S = Math.max(Math.hypot(ls.x - rs.x, ls.y - rs.y), w * 0.1) // shoulder width as scale

  const topY = Math.min(ls.y, rs.y) - S
  const botY = Math.max(P(LM.leftAnkle)?.y ?? lh.y, P(LM.rightAnkle)?.y ?? rh.y) + S * 0.4
  const grad = ctx.createLinearGradient(0, topY, 0, botY)
  grad.addColorStop(0, '#ff6fb0')
  grad.addColorStop(1, '#ff2e88')

  ctx.save()
  ctx.fillStyle = opts.color ?? grad
  // Subtle separation from the dark background, not a big halo.
  ctx.shadowColor = 'rgba(255,46,136,0.5)'
  ctx.shadowBlur = S * 0.1

  const disc = (p: Pt | null, r: number) => {
    if (!p) return
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // A limb segment as a tapered band (wA at a, wB at b) with rounded joints.
  const limb = (a: Pt | null, b: Pt | null, wA: number, wB: number) => {
    if (!a || !b) return
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    ctx.beginPath()
    ctx.moveTo(a.x + nx * wA, a.y + ny * wA)
    ctx.lineTo(b.x + nx * wB, b.y + ny * wB)
    ctx.lineTo(b.x - nx * wB, b.y - ny * wB)
    ctx.lineTo(a.x - nx * wA, a.y - ny * wA)
    ctx.closePath()
    ctx.fill()
    disc(a, wA) // round the joints so segments blend smoothly
    disc(b, wB)
  }

  // Limbs (half-widths). Thinner toward the extremities = human, not robotic.
  limb(ls, P(LM.leftElbow), S * 0.15, S * 0.11)
  limb(P(LM.leftElbow), P(LM.leftWrist), S * 0.11, S * 0.07)
  limb(rs, P(LM.rightElbow), S * 0.15, S * 0.11)
  limb(P(LM.rightElbow), P(LM.rightWrist), S * 0.11, S * 0.07)
  limb(lh, P(LM.leftKnee), S * 0.2, S * 0.14)
  limb(P(LM.leftKnee), P(LM.leftAnkle), S * 0.14, S * 0.085)
  limb(rh, P(LM.rightKnee), S * 0.2, S * 0.14)
  limb(P(LM.rightKnee), P(LM.rightAnkle), S * 0.14, S * 0.085)
  // Feet.
  limb(P(LM.leftAnkle), P(LM.leftFootIndex), S * 0.09, S * 0.06)
  limb(P(LM.rightAnkle), P(LM.rightFootIndex), S * 0.09, S * 0.06)

  // Torso: shoulders down to a narrowed waist and out to the hips, with smooth curves.
  const waistL = lerpPt(ls, lh, 0.55)
  const waistR = lerpPt(rs, rh, 0.55)
  const center = mid(mid(ls, rs), mid(lh, rh))
  const pull = (p: Pt, amt: number): Pt => lerpPt(p, center, amt)
  ctx.beginPath()
  ctx.moveTo(ls.x, ls.y)
  ctx.quadraticCurveTo(pull(waistL, 0.18).x, pull(waistL, 0.18).y, lh.x, lh.y)
  ctx.lineTo(rh.x, rh.y)
  ctx.quadraticCurveTo(pull(waistR, 0.18).x, pull(waistR, 0.18).y, rs.x, rs.y)
  ctx.closePath()
  ctx.fill()
  disc(mid(lh, rh), S * 0.22) // round the hips/seat

  // Neck + head (small, slightly oval, with a real neck).
  const neckBase = lerpPt(mid(ls, rs), center, -0.05)
  const le = P(LM.leftEar)
  const re = P(LM.rightEar)
  const nose = P(LM.nose)
  const headCenter =
    le && re ? lerpPt(mid(le, re), neckBase, -0.06) : nose ?? { x: neckBase.x, y: neckBase.y - S * 0.55 }
  limb(neckBase, headCenter, S * 0.12, S * 0.1)
  const headRx = S * 0.2
  const headRy = S * 0.26
  ctx.beginPath()
  ctx.ellipse(headCenter.x, headCenter.y, headRx, headRy, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}
