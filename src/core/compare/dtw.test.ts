import { describe, it, expect } from 'vitest'
import { dtw, rmsAngleDistance } from './dtw'
import { scoreSection } from './score'
import { STRICT } from './similarity'
import { JOINT_ORDER } from '../pose/angles'

const N = JOINT_ORDER.length
const vec = (v: number) => new Array(N).fill(v)

describe('rmsAngleDistance', () => {
  it('is 0 for identical vectors', () => {
    expect(rmsAngleDistance(vec(30), vec(30))).toBe(0)
  })
  it('equals the constant offset when all joints differ by it', () => {
    expect(rmsAngleDistance(vec(30), vec(40))).toBeCloseTo(10, 6)
  })
})

describe('dtw', () => {
  it('aligns identical sequences at zero cost down the diagonal', () => {
    const seq = [vec(10), vec(20), vec(30)]
    const r = dtw(seq, seq)
    expect(r.distance).toBeCloseTo(0, 6)
    expect(r.path[0]).toEqual([0, 0])
    expect(r.path[r.path.length - 1]).toEqual([2, 2])
  })

  it('matches a time-stretched sequence to its original near zero cost', () => {
    const ref = [vec(10), vec(20), vec(30)]
    // Same movement, performed slower (each pose held an extra frame).
    const slow = [vec(10), vec(10), vec(20), vec(30), vec(30)]
    const r = dtw(ref, slow)
    expect(r.normalizedDistance).toBeCloseTo(0, 6)
  })

  it('respects a Sakoe-Chiba band without crashing', () => {
    const a = Array.from({ length: 20 }, (_, i) => vec(i))
    const b = Array.from({ length: 20 }, (_, i) => vec(i))
    const r = dtw(a, b, { band: 2 })
    expect(r.normalizedDistance).toBeCloseTo(0, 6)
  })
})

describe('scoreSection', () => {
  it('gives a perfect take 100', () => {
    const ref = [vec(10), vec(40), vec(80)]
    const r = scoreSection(ref, ref, STRICT)
    expect(r.score).toBeCloseTo(100, 4)
    expect(r.worstLimb).not.toBeNull()
  })

  it('still scores well when the dancer is just slightly off-tempo', () => {
    const ref = [vec(10), vec(20), vec(30), vec(40)]
    const lateButSame = [vec(10), vec(10), vec(20), vec(30), vec(40)]
    const r = scoreSection(ref, lateButSame, STRICT)
    expect(r.score).toBeGreaterThan(95)
  })

  it('penalizes a wrong take', () => {
    const ref = [vec(10), vec(20), vec(30)]
    const wrong = [vec(120), vec(130), vec(140)]
    const r = scoreSection(ref, wrong, STRICT)
    expect(r.score).toBeLessThan(20)
  })
})
