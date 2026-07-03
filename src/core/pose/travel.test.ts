import { describe, expect, it } from 'vitest'
import { torsoAnchor, travelBaseline, stageTravel } from './travel'
import { LANDMARK_COUNT, LM, type Landmark } from './types'

/** Image-space landmarks for a torso centered at `x`, with the given torso length. */
function imageFrame(x: number, torso: number, visibility = 1): Landmark[] {
  const lms: Landmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0, visibility }))
  const shoulderY = 0.4
  lms[LM.leftShoulder] = { x: x + 0.08, y: shoulderY, z: 0, visibility }
  lms[LM.rightShoulder] = { x: x - 0.08, y: shoulderY, z: 0, visibility }
  lms[LM.leftHip] = { x: x + 0.05, y: shoulderY + torso, z: 0, visibility }
  lms[LM.rightHip] = { x: x - 0.05, y: shoulderY + torso, z: 0, visibility }
  return lms
}

describe('torsoAnchor', () => {
  it('measures torso size and hip x', () => {
    const a = torsoAnchor(imageFrame(0.5, 0.2))!
    expect(a.x).toBeCloseTo(0.5, 5)
    expect(a.size).toBeCloseTo(0.2, 5)
  })
  it('rejects missing or low-visibility torsos', () => {
    expect(torsoAnchor(undefined)).toBeNull()
    expect(torsoAnchor(imageFrame(0.5, 0.2, 0.1))).toBeNull()
  })
})

describe('travelBaseline', () => {
  it('takes the median across frames', () => {
    const frames = [
      ...Array.from({ length: 10 }, () => ({ image: imageFrame(0.5, 0.2) })),
      ...Array.from({ length: 3 }, () => ({ image: imageFrame(0.9, 0.3) })), // outliers
    ]
    const base = travelBaseline(frames)!
    expect(base.x).toBeCloseTo(0.5, 5)
    expect(base.size).toBeCloseTo(0.2, 5)
  })
  it('returns null when too few frames have a visible torso (e.g. the synthetic demo)', () => {
    expect(travelBaseline([{ image: undefined }, { image: undefined }])).toBeNull()
    expect(travelBaseline(Array.from({ length: 5 }, () => ({ image: imageFrame(0.5, 0.2) })))).toBeNull()
  })
})

describe('stageTravel', () => {
  const base = { size: 0.2, x: 0.5 }
  it('is zero at the baseline', () => {
    const t = stageTravel({ size: 0.2, x: 0.5 }, base)
    expect(t.x).toBeCloseTo(0, 5)
    expect(t.z).toBeCloseTo(0, 5)
  })
  it('moves toward the camera (+z) when the body looks bigger', () => {
    expect(stageTravel({ size: 0.3, x: 0.5 }, base).z).toBeGreaterThan(0.3)
    expect(stageTravel({ size: 0.15, x: 0.5 }, base).z).toBeLessThan(-0.3)
  })
  it("follows the hip midpoint laterally (image right = viewer's right = +x)", () => {
    expect(stageTravel({ size: 0.2, x: 0.7 }, base).x).toBeCloseTo(0.44, 2)
    expect(stageTravel({ size: 0.2, x: 0.3 }, base).x).toBeCloseTo(-0.44, 2)
  })
  it('clamps extreme moves', () => {
    expect(stageTravel({ size: 5, x: 0.5 }, base).z).toBeLessThanOrEqual(1.1)
    expect(stageTravel({ size: 0.001, x: 0.5 }, base).z).toBeGreaterThanOrEqual(-1.0)
    expect(Math.abs(stageTravel({ size: 0.2, x: 3 }, base).x)).toBeLessThanOrEqual(1.0)
  })
})
