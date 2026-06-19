import { describe, it, expect } from 'vitest'
import { compareAngles, cosineSimilarity, STRICT } from './similarity'
import { JOINT_ORDER } from '../pose/angles'

const N = JOINT_ORDER.length
const fill = (v: number) => new Array(N).fill(v)

describe('compareAngles', () => {
  it('scores identical poses at 100 with all limbs ok', () => {
    const ref = fill(90)
    const r = compareAngles(ref, ref, STRICT)
    expect(r.score).toBeCloseTo(100, 5)
    for (const limb of Object.values(r.perLimb)) expect(limb.ok).toBe(true)
  })

  it('scores a pose past maxError at 0', () => {
    const ref = fill(20)
    const live = fill(20 + STRICT.maxErrorDeg) // exactly at the zero-quality threshold
    const r = compareAngles(ref, live, STRICT)
    expect(r.score).toBeCloseTo(0, 5)
  })

  it('flags only the off limb as not ok', () => {
    const ref = fill(90)
    const live = fill(90)
    // Throw the left arm way off (both its joints) — leftElbow & leftShoulder.
    const idxElbow = JOINT_ORDER.indexOf('leftElbow')
    const idxShoulder = JOINT_ORDER.indexOf('leftShoulder')
    live[idxElbow] = 90 - 40
    live[idxShoulder] = 90 - 40
    const r = compareAngles(ref, live, STRICT)
    expect(r.perLimb.leftArm.ok).toBe(false)
    expect(r.perLimb.rightArm.ok).toBe(true)
    expect(r.perLimb.leftLeg.ok).toBe(true)
  })

  it('actually grades the torso (posture) instead of always passing it', () => {
    const ref = fill(90)
    const live = fill(90)
    const idxL = JOINT_ORDER.indexOf('leftTrunk')
    const idxR = JOINT_ORDER.indexOf('rightTrunk')
    expect(idxL).toBeGreaterThanOrEqual(0)
    expect(idxR).toBeGreaterThanOrEqual(0)
    live[idxL] = 90 - 40
    live[idxR] = 90 - 40
    const r = compareAngles(ref, live, STRICT)
    expect(r.perLimb.torso.ok).toBe(false)
  })

  it('weights low-visibility joints less', () => {
    const ref = fill(90)
    const live = fill(90)
    live[0] = 0 // huge error on joint 0
    const weighted = compareAngles(ref, live, STRICT, fill(0).map((_, i) => (i === 0 ? 0 : 1)))
    const unweighted = compareAngles(ref, live, STRICT)
    expect(weighted.score).toBeGreaterThan(unweighted.score)
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for parallel vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6)
  })
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6)
  })
})
