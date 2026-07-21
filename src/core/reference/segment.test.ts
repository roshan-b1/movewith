import { describe, it, expect } from 'vitest'
import { evenMoveBounds, autoMoveBounds, beatTimes } from './segment'
import { makeTempo } from '../audio/beats'
import type { ReferenceFrame } from './types'

// A frame carrying a single fake joint angle; the rest is unused by segmentation.
function frame(t: number, angle: number): ReferenceFrame {
  return { t, world: [], angles: [angle], visibility: [1] }
}

// Build frames at `dt` spacing where the angle follows `fn(t)`. Motion = |Δangle|.
function frames(end: number, dt: number, fn: (t: number) => number): ReferenceFrame[] {
  const out: ReferenceFrame[] = []
  for (let t = 0; t <= end + 1e-9; t += dt) out.push(frame(+t.toFixed(3), fn(+t.toFixed(3))))
  return out
}

describe('evenMoveBounds', () => {
  it('splits a range into N even internal cuts', () => {
    expect(evenMoveBounds(0, 12, 4)).toEqual([4, 8])
  })

  it('returns no cuts when the range is tiny or target invalid', () => {
    expect(evenMoveBounds(0, 0.02, 4)).toEqual([])
    expect(evenMoveBounds(0, 12, 0)).toEqual([])
  })

  it('makes a single move (no cuts) when target >= span', () => {
    expect(evenMoveBounds(0, 5, 10)).toEqual([])
  })
})

describe('autoMoveBounds', () => {
  it('falls back to an even split when there is no pose data', () => {
    expect(autoMoveBounds([], 0, 12, 4)).toEqual([4, 8])
  })

  it('cuts where the movement changes into a new phrase', () => {
    // Two 8s phrases with different pose content → one cut at the change (~t=8).
    const fs = frames(16, 0.1, (t) => (t < 8 ? 0 : 1))
    const bounds = autoMoveBounds(fs, 0, 16, 8)
    expect(bounds).toHaveLength(1)
    expect(bounds[0]!).toBeGreaterThan(6.5)
    expect(bounds[0]!).toBeLessThan(9.5)
  })

  it('leaves a repeated move whole (no cut inside a repeat)', () => {
    // A short motion repeated the whole time (period 2s ≪ target) is one phrase → no cut.
    const fs = frames(16, 0.1, (t) => (Math.floor(t) % 2 === 0 ? 0 : 1))
    expect(autoMoveBounds(fs, 0, 16, 8)).toEqual([])
  })

  it('cuts each distinct phrase in a three-phrase clip', () => {
    // Three different 8s phrases → cuts at both changes (~8, ~16).
    const fs = frames(24, 0.1, (t) => (t < 8 ? 0 : t < 16 ? 1 : 2))
    const bounds = autoMoveBounds(fs, 0, 24, 8)
    expect(bounds).toHaveLength(2)
    expect(bounds[0]!).toBeGreaterThan(6.5)
    expect(bounds[0]!).toBeLessThan(9.5)
    expect(bounds[1]!).toBeGreaterThan(14.5)
    expect(bounds[1]!).toBeLessThan(17.5)
  })

  it('keeps cuts strictly inside the range and increasing', () => {
    const fs = frames(24, 0.1, (t) => (t < 8 ? 0 : t < 16 ? 1 : 2))
    const bounds = autoMoveBounds(fs, 0, 24, 8)
    for (const b of bounds) {
      expect(b).toBeGreaterThan(0)
      expect(b).toBeLessThan(24)
    }
    const sorted = bounds.slice().sort((a, b) => a - b)
    expect(bounds).toEqual(sorted)
  })
})

describe('beatTimes', () => {
  it('lists the beats strictly inside a range', () => {
    // 120 BPM = 0.5s per beat, first beat at 0. Beats inside (1, 3): 1.5, 2.0, 2.5.
    const ts = beatTimes(makeTempo(120, 0), 1, 3)
    expect(ts).toEqual([1.5, 2, 2.5])
  })
  it('honours a first-beat offset (grid extends both ways)', () => {
    // 0.2s/beat, first detected beat at 0.3. The grid is periodic, so 0.1 (0.3 - 0.2) is
    // also a beat; beats inside (0,1) are 0.1, 0.3, 0.5, 0.7, 0.9.
    const ts = beatTimes(makeTempo(300, 0.3), 0, 1).map((t) => +t.toFixed(2))
    expect(ts).toEqual([0.1, 0.3, 0.5, 0.7, 0.9])
  })
})

describe('autoMoveBounds — beat alignment', () => {
  const tempo = makeTempo(120, 0) // 0.5s/beat

  it('snaps a detected phrase change onto the beat grid', () => {
    // Two phrases change at ~t=12; with a tempo the cut lands on a beat (multiple of 0.5).
    const fs = frames(24, 0.1, (t) => (t < 12 ? 0 : 1))
    const bounds = autoMoveBounds(fs, 0, 24, 8, tempo)
    expect(bounds).toHaveLength(1)
    expect(Math.round(bounds[0]! / 0.5) * 0.5).toBeCloseTo(bounds[0]!, 6)
    expect(bounds[0]!).toBeGreaterThan(11)
    expect(bounds[0]!).toBeLessThan(13)
  })

  it('splits playback-only tracks on the beat grid (tempo but no pose)', () => {
    // No pose data → fall back to a beat-aligned split. Cuts must be multiples of 0.5s.
    const bounds = autoMoveBounds([], 0, 24, 4, tempo)
    expect(bounds.length).toBeGreaterThanOrEqual(4)
    for (const b of bounds) expect(Math.round(b / 0.5) * 0.5).toBeCloseTo(b, 6)
  })
})
