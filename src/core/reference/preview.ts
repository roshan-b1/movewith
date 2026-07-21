// Picking WHICH dancer to be graded against only works if you can tell them apart. Names
// like "Dancer 1" mean nothing on their own, so the picker shows a cropped snapshot of each
// person taken from the video. These are the pure parts: where each dancer sits in the
// frame, and a moment where everyone is on screen at once to snapshot them.

import type { ReferenceFrame } from './types'
import { nearestFrameIndex } from './build'
import { LM } from '../pose/types'

export interface Box {
  /** All normalized 0..1 of the video frame. */
  x: number
  y: number
  w: number
  h: number
}

/** Landmarks this far below full confidence are ignored when framing someone. */
const MIN_VIS = 0.4
/** A frame counts as "this dancer is on screen" only within this many seconds of t. */
const NEAR_SEC = 0.4

/**
 * Bounding box around a dancer at time `t`, padded and clamped to the frame. Returns null
 * when that dancer isn't tracked near `t` (they've left the shot, or never had image
 * landmarks — generated routines don't).
 */
export function dancerBoundsAt(frames: ReferenceFrame[], t: number, pad = 0.15): Box | null {
  const i = nearestFrameIndex(frames, t)
  if (i < 0) return null
  const f = frames[i]!
  if (Math.abs(f.t - t) > NEAR_SEC || !f.image) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const lm of f.image) {
    if ((lm.visibility ?? 1) < MIN_VIS) continue
    if (lm.x < minX) minX = lm.x
    if (lm.x > maxX) maxX = lm.x
    if (lm.y < minY) minY = lm.y
    if (lm.y > maxY) maxY = lm.y
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null

  // Pad relative to the body so short/far dancers get proportional headroom.
  const px = (maxX - minX) * pad
  const py = (maxY - minY) * pad
  const x = Math.max(0, minX - px)
  const y = Math.max(0, minY - py)
  return {
    x,
    y,
    w: Math.min(1 - x, maxX - minX + px * 2),
    h: Math.min(1 - y, maxY - minY + py * 2),
  }
}

/** Head + torso landmarks: what actually makes someone recognizable in a small chip. */
const PORTRAIT_POINTS: readonly number[] = [
  LM.nose, LM.leftEye, LM.rightEye, LM.leftEar, LM.rightEar,
  LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip,
]

/**
 * A head-and-torso box for a dancer at time `t`. Preferred over the full-body box for the
 * picker: at chip size a whole body is unidentifiable, and — the real problem — a full body
 * with arms out is wide enough that cropping it drags in whoever is standing next to them.
 * Falls back to the full body when the head/torso isn't tracked.
 */
export function dancerPortraitAt(frames: ReferenceFrame[], t: number): Box | null {
  const i = nearestFrameIndex(frames, t)
  if (i < 0) return null
  const f = frames[i]!
  if (Math.abs(f.t - t) > NEAR_SEC || !f.image) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let seen = 0
  for (const p of PORTRAIT_POINTS) {
    const lm = f.image[p]
    if (!lm || (lm.visibility ?? 1) < MIN_VIS) continue
    seen++
    if (lm.x < minX) minX = lm.x
    if (lm.x > maxX) maxX = lm.x
    if (lm.y < minY) minY = lm.y
    if (lm.y > maxY) maxY = lm.y
  }
  // Need at least a shoulder line plus something above it to frame a portrait.
  if (seen < 4 || !Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
    return dancerBoundsAt(frames, t)
  }

  const w = maxX - minX
  const h = maxY - minY
  // Extra headroom above (hair sits above the eyes/ears) and a little breathing room around.
  const padX = w * 0.18
  const padTop = h * 0.35
  const padBottom = h * 0.08
  const x = Math.max(0, minX - padX)
  const y = Math.max(0, minY - padTop)
  return {
    x,
    y,
    w: Math.min(1 - x, w + padX * 2),
    h: Math.min(1 - y, h + padTop + padBottom),
  }
}

/**
 * A time inside [start, end] where the MOST dancers are simultaneously on screen, so one
 * snapshot can identify everybody. Scans on a coarse grid and prefers the middle of the
 * range (intros and outros often have people missing), returning `start` if nothing is
 * ever tracked.
 */
export function pickShowcaseTime(dancers: ReferenceFrame[][], start: number, end: number): number {
  const span = end - start
  if (!(span > 0) || dancers.length === 0) return start
  const steps = 24
  const mid = start + span / 2
  let bestT = mid
  let bestScore = -Infinity
  for (let k = 0; k <= steps; k++) {
    const t = start + (span * k) / steps
    let visible = 0
    for (const d of dancers) if (dancerBoundsAt(d, t)) visible++
    // Tie-break toward the middle so we don't snapshot a title card.
    const score = visible - Math.abs(t - mid) / span
    if (score > bestScore) { bestScore = score; bestT = t }
  }
  return bestT
}
