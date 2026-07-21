import { describe, it, expect } from 'vitest'
import { detectTalkingRanges, overlapFraction } from './talking'
import type { ReferenceFrame } from './types'

// Angle-vector layout: 10 joints, legs at indices 4..7 (hips + knees).
// Talking = arms gesture but legs hold still; dancing = legs swing hard.
function video(spans: { kind: 'talk' | 'dance'; dur: number }[], dt = 0.2): ReferenceFrame[] {
  const out: ReferenceFrame[] = []
  let t = 0
  let seed = 3
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 4 }
  for (const span of spans) {
    for (const end = t + span.dur; t < end - 1e-9; t += dt) {
      const angles = new Array(10).fill(0).map((_, j) => {
        const legs = j >= 4 && j <= 7
        if (span.kind === 'dance') return 90 + 60 * Math.sin(t * 5 + j) // everything moves
        return legs ? 90 + rnd() * 0.5 : 90 + 25 * Math.sin(t * 3 + j) // arms talk, legs still
      })
      out.push({ t: +t.toFixed(2), world: [], angles, visibility: angles.map(() => 1) })
    }
  }
  return out
}

describe('detectTalkingRanges', () => {
  it('finds the explanation stretch between two danced parts', () => {
    const fs = video([{ kind: 'dance', dur: 10 }, { kind: 'talk', dur: 8 }, { kind: 'dance', dur: 10 }])
    const ranges = detectTalkingRanges(fs, 0, 28)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.startSec).toBeGreaterThan(8.5)
    expect(ranges[0]!.endSec).toBeLessThan(19.5)
    expect(ranges[0]!.endSec - ranges[0]!.startSec).toBeGreaterThan(4)
  })

  it('flags nothing in a video that is all dancing', () => {
    const fs = video([{ kind: 'dance', dur: 30 }])
    expect(detectTalkingRanges(fs, 0, 30)).toEqual([])
  })

  it('flags an all-talk video via the absolute stillness floor', () => {
    const fs = video([{ kind: 'talk', dur: 30 }])
    const ranges = detectTalkingRanges(fs, 0, 30)
    expect(ranges).toHaveLength(1)
    expect(overlapFraction(ranges, 0, 30)).toBeGreaterThan(0.8)
  })

  it('ignores brief holds shorter than a real explanation', () => {
    const fs = video([{ kind: 'dance', dur: 10 }, { kind: 'talk', dur: 2 }, { kind: 'dance', dur: 10 }])
    expect(detectTalkingRanges(fs, 0, 22)).toEqual([])
  })
})

describe('overlapFraction', () => {
  const ranges = [{ startSec: 10, endSec: 20 }]
  it('measures how much of a segment is covered', () => {
    expect(overlapFraction(ranges, 12, 18)).toBe(1)
    expect(overlapFraction(ranges, 0, 10)).toBe(0)
    expect(overlapFraction(ranges, 15, 25)).toBeCloseTo(0.5, 5)
  })
})
