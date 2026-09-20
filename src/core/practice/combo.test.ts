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
    const s = comboSpan(segs, 2, 1)!
    expect(s.indices).toEqual([2])
    expect([s.startSec, s.endSec]).toEqual([8, 12])
  })

  it('spans two consecutive segments so the join gets practised', () => {
    const s = comboSpan(segs, 1, 2)!
    expect(s.indices).toEqual([1, 2])
    expect([s.startSec, s.endSec]).toEqual([4, 12])
  })

  it('spans three', () => {
    const s = comboSpan(segs, 0, 3)!
    expect(s.indices).toEqual([0, 1, 2])
    expect([s.startSec, s.endSec]).toEqual([0, 12])
  })

  it('covers the moves either side of a deleted hole', () => {
    // The explanation that sat between 4s and 8s was deleted, so it is not in the list at
    // all: combining from the move at 4s reaches straight across the gap to the next one.
    const withHole: ComboSegment[] = [
      { index: 0, startSec: 0, endSec: 4 },
      { index: 1, startSec: 8, endSec: 12 },
      { index: 2, startSec: 12, endSec: 16 },
    ]
    const s = comboSpan(withHole, 0, 2)!
    expect(s.indices).toEqual([0, 1])
    expect([s.startSec, s.endSec]).toEqual([0, 12])
  })

  it('stops early at the end of the routine instead of overrunning', () => {
    const s = comboSpan(segs, 4, 3)!
    expect(s.indices).toEqual([4])
    expect([s.startSec, s.endSec]).toEqual([16, 20])
  })

  it('returns null for an unknown segment', () => {
    expect(comboSpan(segs, 99, 2)).toBeNull()
    expect(comboSpan([], 0, 2)).toBeNull()
  })
})
