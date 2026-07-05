import { describe, expect, it } from 'vitest'
import { scoreSection, scoreSectionDetailed } from './score'
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
