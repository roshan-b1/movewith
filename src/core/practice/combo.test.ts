import { describe, it, expect } from 'vitest'
import { comboSpan, type ComboSegment } from './combo'

// Five 4-second segments back to back.
const segs: ComboSegment[] = [0, 1, 2, 3, 4].map((i) => ({
  index: i,
  startSec: i * 4,
  endSec: (i + 1) * 4,
}))

describe('comboSpan', () => {
  it('gives just the one segment when not combining', () => {
    const s = comboSpan(segs, [], 2, 1)!
    expect(s.indices).toEqual([2])
    expect([s.startSec, s.endSec]).toEqual([8, 12])
  })

  it('spans two consecutive segments so the join gets practised', () => {
    const s = comboSpan(segs, [], 1, 2)!
    expect(s.indices).toEqual([1, 2])
    expect([s.startSec, s.endSec]).toEqual([4, 12])
  })

  it('spans three', () => {
    const s = comboSpan(segs, [], 0, 3)!
    expect(s.indices).toEqual([0, 1, 2])
    expect([s.startSec, s.endSec]).toEqual([0, 12])
  })

  it('steps over parts marked skip', () => {
    // Segment 2 is an explanation: combining 1 with the next real move gives 1 + 3.
    const s = comboSpan(segs, [2], 1, 2)!
    expect(s.indices).toEqual([1, 3])
    expect([s.startSec, s.endSec]).toEqual([4, 16])
  })

  it('stops early at the end of the routine instead of overrunning', () => {
    const s = comboSpan(segs, [], 4, 3)!
    expect(s.indices).toEqual([4])
    expect([s.startSec, s.endSec]).toEqual([16, 20])
  })

  it('always includes the segment asked for, even if it is skipped', () => {
    const s = comboSpan(segs, [1], 1, 2)!
    expect(s.indices[0]).toBe(1)
    expect(s.indices).toEqual([1, 2])
  })

  it('returns null for an unknown segment', () => {
    expect(comboSpan(segs, [], 99, 2)).toBeNull()
    expect(comboSpan([], [], 0, 2)).toBeNull()
  })
})
