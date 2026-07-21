import { describe, it, expect } from 'vitest'
import { sliceTakeBySegments, type TimedFrame, type SegmentRange } from './takeSlice'

/** A take recorded at 10fps across [from, to), each frame tagged with its routine time. */
function take(from: number, to: number, step = 0.1): TimedFrame[] {
  const out: TimedFrame[] = []
  for (let t = from; t < to - 1e-9; t += step) out.push({ t: +t.toFixed(2), angles: [+t.toFixed(2)] })
  return out
}

const segs: SegmentRange[] = [
  { index: 0, startSec: 0, endSec: 4 },
  { index: 1, startSec: 4, endSec: 8 },
  { index: 2, startSec: 8, endSec: 12 },
]

describe('sliceTakeBySegments', () => {
  it('splits one continuous take into its segments', () => {
    const out = sliceTakeBySegments(take(0, 12), segs)
    expect(out.map((s) => s.index)).toEqual([0, 1, 2])
    for (const s of out) expect(s.angles.length).toBe(40) // 4s at 10fps
  })

  it('never double-counts a frame sitting exactly on a boundary', () => {
    const out = sliceTakeBySegments([{ t: 4, angles: [4] }], segs)
    const hits = out.filter((s) => s.angles.length > 0)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.index).toBe(1) // ranges are half-open: 4 starts segment 1
  })

  it('accounts for every frame exactly once across segments', () => {
    const t = take(0, 12)
    const out = sliceTakeBySegments(t, segs)
    expect(out.reduce((n, s) => n + s.angles.length, 0)).toBe(t.length)
  })

  it('leaves segments the dancer never reached empty', () => {
    // They bailed halfway: nothing recorded past 6s.
    const out = sliceTakeBySegments(take(0, 6), segs)
    expect(out[0]!.angles.length).toBe(40)
    expect(out[1]!.angles.length).toBe(20)
    expect(out[2]!.angles).toEqual([])
  })

  it('handles a take that skipped a chunk of the routine', () => {
    // Playback jumped over segment 1 (marked skip), so no frames carry those times.
    const t = [...take(0, 4), ...take(8, 12)]
    const out = sliceTakeBySegments(t, segs)
    expect(out[0]!.angles.length).toBe(40)
    expect(out[1]!.angles).toEqual([])
    expect(out[2]!.angles.length).toBe(40)
  })

  it('is empty-safe', () => {
    expect(sliceTakeBySegments([], segs).every((s) => s.angles.length === 0)).toBe(true)
    expect(sliceTakeBySegments(take(0, 4), [])).toEqual([])
  })
})
