// The projectors decide whether the skeleton lands ON the dancer's body or floats off it.
// They must mirror exactly what CSS object-fit does to the <video> underneath, so they're
// worth pinning down: contain letterboxes (offsets >= 0), cover crops (offsets <= 0).

import { describe, it, expect } from 'vitest'
import { containProjector, coverProjector, imageProjector } from './drawSkeleton'
import type { Landmark } from '../../core/pose/types'

const lm = (x: number, y: number): Landmark => ({ x, y, z: 0, visibility: 1 })

describe('coverProjector', () => {
  it('fills the box exactly when the aspect ratios already match', () => {
    const p = coverProjector(640, 480)
    expect(p(lm(0, 0), 320, 240)).toEqual({ x: 0, y: 0 })
    expect(p(lm(1, 1), 320, 240)).toEqual({ x: 320, y: 240 })
  })

  it('crops the sides when the video is wider than the box', () => {
    // 16:9 video in a square box: height fills, width overflows and is cropped evenly.
    const p = coverProjector(1920, 1080)
    const center = p(lm(0.5, 0.5), 400, 400)
    expect(center).toEqual({ x: 200, y: 200 }) // centre stays centred

    const left = p(lm(0, 0.5), 400, 400)
    expect(left.x).toBeLessThan(0) // the left edge is cropped off screen
    expect(left.y).toBe(200)
    // Symmetric crop: as much lost on the right as on the left.
    expect(p(lm(1, 0.5), 400, 400).x).toBeCloseTo(400 - left.x, 5)
  })

  it('crops the top and bottom when the video is taller than the box', () => {
    const p = coverProjector(1080, 1920) // portrait video, landscape box
    const top = p(lm(0.5, 0), 400, 200)
    expect(top.y).toBeLessThan(0)
    expect(top.x).toBe(200)
    expect(p(lm(0.5, 1), 400, 200).y).toBeCloseTo(200 - top.y, 5)
  })

  it('keeps the body proportional — a square in the video stays square on canvas', () => {
    const p = coverProjector(1920, 1080)
    // Landmark x/y are normalised against the video's WIDTH and HEIGHT respectively, so a
    // physically square 200px region is a different normalised span on each axis. Cover
    // scales both axes by one factor, so it must come out square in pixels (no skew).
    const a = p(lm(0.5, 0.5), 400, 400)
    const b = p(lm(0.5 + 200 / 1920, 0.5 + 200 / 1080), 400, 400)
    expect(b.x - a.x).toBeCloseTo(b.y - a.y, 5)
  })

  it('falls back to a plain stretch before the video reports its size', () => {
    const p = coverProjector(0, 0)
    expect(p(lm(0.5, 0.5), 400, 200)).toEqual({ x: 200, y: 100 })
  })
})

describe('containProjector', () => {
  it('letterboxes instead of cropping: every point stays inside the box', () => {
    const p = containProjector(1920, 1080)
    const top = p(lm(0.5, 0), 400, 400)
    expect(top.y).toBeGreaterThan(0) // bar above, nothing cut off
    expect(p(lm(0, 0.5), 400, 400).x).toBe(0)
  })
})

describe('imageProjector', () => {
  it('stretches normalised coords straight onto the canvas', () => {
    expect(imageProjector(lm(0.5, 0.25), 800, 400)).toEqual({ x: 400, y: 100 })
  })
})
