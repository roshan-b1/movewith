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
  it('falls back to an even split when there is no motion data', () => {
    expect(autoMoveBounds([], 0, 12, 4)).toEqual([4, 8])
  })

  it('snaps a cut onto a low-motion hold near the even target', () => {
    // Span 0..4, target 2s → 1 even cut at t=2. Motion is high everywhere except a
    // hold (constant angle) around t=2.2, so the cut should land there, not at 2.0.
    const fs = frames(4, 0.1, (t) => (t > 2.0 && t < 2.4 ? 50 : 50 + 30 * Math.sin(t * 20)))
    const bounds = autoMoveBounds(fs, 0, 4, 2)
    expect(bounds).toHaveLength(1)
    expect(bounds[0]!).toBeGreaterThan(1.9)
    expect(bounds[0]!).toBeLessThan(2.45)
  })

  it('produces roughly the requested number of moves', () => {
    const fs = frames(12, 0.1, (t) => 50 + 30 * Math.sin(t * 6))
    const bounds = autoMoveBounds(fs, 0, 12, 4) // ~3 moves → ~2 cuts
    expect(bounds.length).toBeGreaterThanOrEqual(1)
    expect(bounds.length).toBeLessThanOrEqual(2)
  })

  it('keeps cuts strictly inside the range and increasing', () => {
    const fs = frames(12, 0.1, (t) => 50 + 30 * Math.sin(t * 6))
    const bounds = autoMoveBounds(fs, 0, 12, 3)
    for (const b of bounds) {
      expect(b).toBeGreaterThan(0)
      expect(b).toBeLessThan(12)
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

describe('autoMoveBounds — beat-aligned', () => {
  const tempo = makeTempo(120, 0) // 0.5s/beat

  it('places every cut exactly on a beat', () => {
    // 24s at 120bpm, ~4s moves → 8 beats/segment. Cuts must be multiples of 0.5s.
    const fs = frames(24, 0.1, (t) => 50 + 30 * Math.sin(t * 6))
    const bounds = autoMoveBounds(fs, 0, 24, 4, tempo)
    expect(bounds.length).toBeGreaterThanOrEqual(4)
    for (const b of bounds) expect(Math.round(b / 0.5) * 0.5).toBeCloseTo(b, 6)
  })

  it('spaces segments to about the target length', () => {
    const fs = frames(24, 0.1, () => 50)
    const bounds = autoMoveBounds(fs, 0, 24, 4, tempo) // ~4s → 8 beats apart = 4s
    const cuts = [0, ...bounds, 24]
    for (let i = 1; i < cuts.length; i++) {
      const len = cuts[i]! - cuts[i - 1]!
      expect(len).toBeGreaterThan(2.5)
      expect(len).toBeLessThan(5.5)
    }
  })

  it('nudges a boundary onto the quietest nearby beat (a hold)', () => {
    // 8 beats/seg → first boundary near beat 8 (t=4). Make beat 7 (t=3.5) a dead hold
    // while everything else moves; the cut should snap back to 3.5, not sit at 4.0.
    const fs = frames(24, 0.1, (t) => (t > 3.35 && t < 3.65 ? 50 : 50 + 40 * Math.sin(t * 25)))
    const bounds = autoMoveBounds(fs, 0, 24, 4, tempo)
    expect(bounds[0]!).toBeCloseTo(3.5, 6)
  })

  it('works beat-only for playback tracks (tempo but no frames)', () => {
    const bounds = autoMoveBounds([], 0, 24, 4, tempo)
    expect(bounds.length).toBeGreaterThanOrEqual(4)
    for (const b of bounds) expect(Math.round(b / 0.5) * 0.5).toBeCloseTo(b, 6)
  })
})
