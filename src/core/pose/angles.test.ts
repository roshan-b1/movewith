import { describe, it, expect } from 'vitest'
import { angleAt, jointAngles, mirrorAngles, JOINT_ORDER, JOINT_INDEX } from './angles'
import { LANDMARK_COUNT, LM, type Landmark } from './types'

const P = (x: number, y: number, z = 0): Landmark => ({ x, y, z, visibility: 1 })

describe('angleAt', () => {
  it('measures a right angle as 90 degrees', () => {
    expect(angleAt(P(1, 0), P(0, 0), P(0, 1))).toBeCloseTo(90, 5)
  })

  it('measures a straight line as 180 degrees', () => {
    expect(angleAt(P(1, 0), P(0, 0), P(-1, 0))).toBeCloseTo(180, 5)
  })

  it('measures a fully bent (overlapping) joint as 0 degrees', () => {
    expect(angleAt(P(1, 0), P(0, 0), P(1, 0))).toBeCloseTo(0, 5)
  })

  it('returns 0 for degenerate (zero-length) rays instead of NaN', () => {
    expect(angleAt(P(0, 0), P(0, 0), P(0, 1))).toBe(0)
  })
})

describe('jointAngles', () => {
  it('produces one value per tracked joint, in JOINT_ORDER', () => {
    const world: Landmark[] = Array.from({ length: LANDMARK_COUNT }, () => P(0, 0))
    // Make the left elbow a clean right angle: shoulder above, wrist to the side.
    world[LM.leftShoulder] = P(0, 1)
    world[LM.leftElbow] = P(0, 0)
    world[LM.leftWrist] = P(1, 0)
    const angles = jointAngles(world)
    expect(angles).toHaveLength(JOINT_ORDER.length)
    expect(angles[JOINT_INDEX.leftElbow!]).toBeCloseTo(90, 4)
  })
})

describe('mirrorAngles', () => {
  it('swaps each joint with its left/right twin', () => {
    // Build a vector where every joint has a distinct value.
    const v = JOINT_ORDER.map((_, i) => i * 10)
    const mirrored = mirrorAngles(v)
    // left elbow value should now sit where right elbow was, and vice versa.
    expect(mirrored[JOINT_INDEX.leftElbow!]).toBe(v[JOINT_INDEX.rightElbow!])
    expect(mirrored[JOINT_INDEX.rightKnee!]).toBe(v[JOINT_INDEX.leftKnee!])
  })

  it('is its own inverse (mirror twice = identity)', () => {
    const v = JOINT_ORDER.map((_, i) => i * 7 + 1)
    expect(mirrorAngles(mirrorAngles(v))).toEqual(v)
  })
})
