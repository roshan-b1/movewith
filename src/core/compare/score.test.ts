import { describe, expect, it } from 'vitest'
import { scoreSection, scoreSectionDetailed, gradeScore, summarizeRun, describeTiming } from './score'
import { STRICT } from './similarity'

// 10 joint angles per frame (the app's angle vector length).
const frame = (deg: number) => Array.from({ length: 10 }, () => deg)

describe('scoreSectionDetailed', () => {
  it('scores a perfect take at ~100 with three clean phases', () => {
    const ref = Array.from({ length: 24 }, (_, i) => frame(i * 3))
    const r = scoreSectionDetailed(ref, ref, STRICT)
    expect(r.score).toBeGreaterThan(99)
    expect(r.phases).toHaveLength(3)
    expect(r.phases.map((p) => p.phase)).toEqual(['start', 'middle', 'end'])
    for (const p of r.phases) expect(p.score).toBeGreaterThan(99)
  })

  it('localizes a botched ending to the end phase', () => {
    const ref = Array.from({ length: 24 }, (_, i) => frame(i * 3))
    // Perfect for two thirds, then completely wrong.
    const live = ref.map((f, i) => (i < 16 ? f : frame(120)))
    const r = scoreSectionDetailed(ref, live, STRICT)
    const byPhase = Object.fromEntries(r.phases.map((p) => [p.phase, p.score]))
    expect(byPhase.start).toBeGreaterThan(90)
    expect(byPhase.end!).toBeLessThan(byPhase.start! - 20)
    expect(r.score).toBeLessThan(scoreSection(ref, ref, STRICT).score)
  })

  it('returns no phases for takes too short to slice', () => {
    const ref = Array.from({ length: 4 }, () => frame(10))
    expect(scoreSectionDetailed(ref, ref, STRICT).phases).toHaveLength(0)
  })
})

describe('timing offset', () => {
  // A moving pose ramp; the "late" take holds the opening pose for a while first, so every
  // reference pose is reached later in the take than it happens in the section.
  const ramp = Array.from({ length: 30 }, (_, i) => frame(i * 4))

  it('is ~0 for an on-time take', () => {
    expect(Math.abs(scoreSection(ramp, ramp, STRICT).timingNorm)).toBeLessThan(0.02)
  })

  it('goes positive when the dancer runs behind', () => {
    const late = [...Array.from({ length: 8 }, () => frame(0)), ...ramp]
    expect(scoreSection(ramp, late, STRICT).timingNorm).toBeGreaterThan(0.05)
  })

  it('goes negative when the dancer rushes ahead', () => {
    // The take finishes the ramp early, then holds the final pose.
    const early = [...ramp, ...Array.from({ length: 8 }, () => frame(29 * 4))]
    expect(scoreSection(ramp, early, STRICT).timingNorm).toBeLessThan(-0.05)
  })

  it('describes offsets in beats, staying quiet when on time', () => {
    expect(describeTiming(0.01, 8, 0.5)).toBeNull() // 0.08s ≈ 0.16 beats → on time
    expect(describeTiming(0.03, 8, 0.5)).toMatch(/behind the music/) // 0.24s ≈ half a beat
    expect(describeTiming(-0.03, 8, 0.5)).toMatch(/rushed .* ahead/)
    expect(describeTiming(0.07, 8, 0.5)).toMatch(/about a beat behind/)
    expect(describeTiming(0.05, 8)).toMatch(/about 0\.4s behind/) // no tempo → seconds
  })
})

describe('gradeScore', () => {
  it('buckets by the nailed/close thresholds', () => {
    expect(gradeScore(100)).toBe('nailed')
    expect(gradeScore(85)).toBe('nailed') // boundary is inclusive
    expect(gradeScore(84.9)).toBe('close')
    expect(gradeScore(65)).toBe('close')
    expect(gradeScore(64.9)).toBe('off')
    expect(gradeScore(0)).toBe('off')
  })
})

describe('summarizeRun', () => {
  it('averages the run and tallies each bucket', () => {
    const s = summarizeRun([
      { index: 0, score: 92, worstLimb: null },
      { index: 1, score: 70, worstLimb: 'leftArm' },
      { index: 2, score: 40, worstLimb: 'rightLeg' },
    ])
    expect(s.overall).toBeCloseTo((92 + 70 + 40) / 3, 5)
    expect(s.nailed).toBe(1)
    expect(s.close).toBe(1)
    expect(s.off).toBe(1)
    expect(s.segments.map((x) => x.grade)).toEqual(['nailed', 'close', 'off'])
    expect(s.segments[1]!.worstLimb).toBe('leftArm') // carries through for the tip
  })

  it('zeroes out an empty run instead of dividing by zero', () => {
    const s = summarizeRun([])
    expect(s.overall).toBe(0)
    expect(s.segments).toHaveLength(0)
    expect([s.nailed, s.close, s.off]).toEqual([0, 0, 0])
  })
})
