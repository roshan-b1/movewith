import { describe, it, expect } from 'vitest'
import {
  clipDuration,
  mixDuration,
  clipOffsets,
  mapMixTime,
  clipSpan,
  insertClip,
  removeClip,
  moveClip,
  type MixClip,
} from './timeline'

let n = 0
function clip(sourceTrackId: string, startSec: number, endSec: number): MixClip {
  return { id: `c${n++}`, sourceTrackId, sourceName: sourceTrackId, startSec, endSec }
}

// A medley: 4s from dance A, 6s from B, 2s from A again → 12s total.
const A0 = clip('A', 10, 14) // 4s
const B0 = clip('B', 0, 6) // 6s
const A1 = clip('A', 20, 22) // 2s
const mix = [A0, B0, A1]

describe('durations', () => {
  it('clipDuration is end minus start, floored at 0', () => {
    expect(clipDuration(A0)).toBe(4)
    expect(clipDuration(B0)).toBe(6)
    expect(clipDuration({ ...A0, startSec: 5, endSec: 5 })).toBe(0)
    expect(clipDuration({ ...A0, startSec: 5, endSec: 4 })).toBe(0) // never negative
  })
  it('mixDuration sums the clips', () => {
    expect(mixDuration(mix)).toBe(12)
    expect(mixDuration([])).toBe(0)
  })
})

describe('clipOffsets', () => {
  it('gives running starts plus a trailing total', () => {
    expect(clipOffsets(mix)).toEqual([0, 4, 10, 12])
  })
  it('is [0] for an empty mix', () => {
    expect(clipOffsets([])).toEqual([0])
  })
})

describe('mapMixTime', () => {
  it('maps a time inside the first clip to its source', () => {
    const loc = mapMixTime(mix, 2)!
    expect(loc.index).toBe(0)
    expect(loc.offsetSec).toBe(2)
    expect(loc.sourceSec).toBe(12) // A0 starts at source 10, +2
    expect(loc.clip).toBe(A0)
  })

  it('maps a time inside a middle clip', () => {
    const loc = mapMixTime(mix, 7)! // 3s into B0 (which starts at global 4)
    expect(loc.index).toBe(1)
    expect(loc.offsetSec).toBe(3)
    expect(loc.sourceSec).toBe(3) // B0 source start 0, +3
  })

  it('puts a boundary time on the LATER clip (half-open)', () => {
    const loc = mapMixTime(mix, 4)! // exactly where B0 begins
    expect(loc.index).toBe(1)
    expect(loc.offsetSec).toBe(0)
    expect(loc.sourceSec).toBe(0)
  })

  it('clamps the exact end onto the last clip', () => {
    const loc = mapMixTime(mix, 12)!
    expect(loc.index).toBe(2)
    expect(loc.sourceSec).toBe(22) // A1 end
  })

  it('returns null for empty, negative, or past-the-end', () => {
    expect(mapMixTime([], 1)).toBeNull()
    expect(mapMixTime(mix, -0.5)).toBeNull()
    expect(mapMixTime(mix, 12.5)).toBeNull()
  })

  it('skips over a zero-length clip cleanly', () => {
    const empty = clip('C', 5, 5)
    const withEmpty = [A0, empty, B0] // 4 + 0 + 6
    const loc = mapMixTime(withEmpty, 4)! // start of B0 (empty clip occupies no time)
    expect(loc.clip).toBe(B0)
  })
})

describe('clipSpan', () => {
  it('returns the timeline span of a clip', () => {
    expect(clipSpan(mix, 0)).toEqual({ startSec: 0, endSec: 4 })
    expect(clipSpan(mix, 1)).toEqual({ startSec: 4, endSec: 10 })
    expect(clipSpan(mix, 2)).toEqual({ startSec: 10, endSec: 12 })
  })
  it('returns null out of range', () => {
    expect(clipSpan(mix, -1)).toBeNull()
    expect(clipSpan(mix, 3)).toBeNull()
  })
})

describe('insertClip', () => {
  const extra = clip('C', 0, 3)
  it('inserts at an index without mutating the input', () => {
    const out = insertClip(mix, extra, 1)
    expect(out.map((c) => c.id)).toEqual([A0.id, extra.id, B0.id, A1.id])
    expect(mix).toHaveLength(3) // original untouched
  })
  it('clamps out-of-range indices to the ends', () => {
    expect(insertClip(mix, extra, -5)[0]).toBe(extra)
    expect(insertClip(mix, extra, 99)[3]).toBe(extra)
  })
  it('appends onto an empty mix', () => {
    expect(insertClip([], extra, 0)).toEqual([extra])
  })
})

describe('removeClip', () => {
  it('drops the clip by id', () => {
    expect(removeClip(mix, B0.id).map((c) => c.id)).toEqual([A0.id, A1.id])
  })
  it('is a no-op for an unknown id', () => {
    expect(removeClip(mix, 'nope')).toHaveLength(3)
  })
})

describe('moveClip', () => {
  it('moves a clip later', () => {
    // Move A0 (index 0) to the end.
    expect(moveClip(mix, 0, 2).map((c) => c.id)).toEqual([B0.id, A1.id, A0.id])
  })
  it('moves a clip earlier', () => {
    expect(moveClip(mix, 2, 0).map((c) => c.id)).toEqual([A1.id, A0.id, B0.id])
  })
  it('clamps the destination', () => {
    expect(moveClip(mix, 0, 99).map((c) => c.id)).toEqual([B0.id, A1.id, A0.id])
  })
  it('is a safe no-op for a bad source index', () => {
    expect(moveClip(mix, 9, 0).map((c) => c.id)).toEqual([A0.id, B0.id, A1.id])
  })
  it('does not mutate the input', () => {
    moveClip(mix, 0, 2)
    expect(mix.map((c) => c.id)).toEqual([A0.id, B0.id, A1.id])
  })
})
