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
    // Two 8s phrases with genuinely different poses (arms swing ~80°) → one cut (~t=8).
    const fs = frames(16, 0.1, (t) => (t < 8 ? 20 : 100))
    const bounds = autoMoveBounds(fs, 0, 16, 8)
    expect(bounds).toHaveLength(1)
    expect(bounds[0]!).toBeGreaterThan(6.5)
    expect(bounds[0]!).toBeLessThan(9.5)
  })

  it('leaves a repeated move whole (no cut inside a repeat)', () => {
    // A big motion repeated the whole time (period 2s ≪ target) is one phrase → no cut.
    const fs = frames(16, 0.1, (t) => (Math.floor(t) % 2 === 0 ? 20 : 100))
    expect(autoMoveBounds(fs, 0, 16, 8)).toEqual([])
  })

  it('treats execution jitter as the same move, not a phrase change', () => {
    // One held pose with a few degrees of wobble — a repeat, never a cut, even over 60s.
    const fs = frames(60, 0.2, (t) => 90 + 3 * Math.sin(t * 13.7) + 2 * Math.sin(t * 5.1))
    expect(autoMoveBounds(fs, 0, 60, 8)).toEqual([])
  })

  it('cuts each distinct phrase in a three-phrase clip', () => {
    // Three different 8s phrases → cuts at both changes (~8, ~16).
    const fs = frames(24, 0.1, (t) => (t < 8 ? 20 : t < 16 ? 100 : 170))
    const bounds = autoMoveBounds(fs, 0, 24, 8)
    expect(bounds).toHaveLength(2)
    expect(bounds[0]!).toBeGreaterThan(6.5)
    expect(bounds[0]!).toBeLessThan(9.5)
    expect(bounds[1]!).toBeGreaterThan(14.5)
    expect(bounds[1]!).toBeLessThan(17.5)
  })

  it('keeps cuts strictly inside the range and increasing', () => {
    const fs = frames(24, 0.1, (t) => (t < 8 ? 20 : t < 16 ? 100 : 170))
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

// A full-length tutorial: `phraseCount` distinct 15s phrases at pose-extractor rate (5fps),
// each pose held with deterministic execution jitter. Exercises the detector at the scale of
// a real 3-minute upload, where noise once masqueraded as novelty.
function longDance(phraseCount: number, phraseSec: number, dt = 0.2): ReferenceFrame[] {
  const out: ReferenceFrame[] = []
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 6 }
  const poses: number[][] = []
  for (let p = 0; p < phraseCount; p++) {
    poses.push(Array.from({ length: 12 }, (_, i) => 90 + 70 * Math.sin(p * 2.7 + i * 1.3)))
  }
  for (let t = 0; t < phraseCount * phraseSec; t += dt) {
    const p = Math.min(phraseCount - 1, Math.floor(t / phraseSec))
    out.push({ t: +t.toFixed(2), world: [], angles: poses[p]!.map((a) => a + rnd()), visibility: poses[p]!.map(() => 1) })
  }
  return out
}

describe('autoMoveBounds — full-length tutorial', () => {
  it('finds every phrase change in a 3-minute video, on the beat, with no spurious cuts', () => {
    const fs = longDance(12, 15) // 180s, changes at 15, 30, …, 165
    const bounds = autoMoveBounds(fs, 0, 180, 8, makeTempo(120, 0))
    const trueCuts = Array.from({ length: 11 }, (_, i) => (i + 1) * 15)
    for (const tc of trueCuts) expect(bounds.some((b) => Math.abs(b - tc) < 2)).toBe(true)
    expect(bounds.length).toBeLessThanOrEqual(13) // at most a couple beyond the true 11
    for (const b of bounds) expect(Math.round(b / 0.5) * 0.5).toBeCloseTo(b, 6)
  })

  it('a 3-minute repetitive video stays one segment (jitter is not novelty)', () => {
    const fs = longDance(1, 180) // one move the whole time
    expect(autoMoveBounds(fs, 0, 180, 8, makeTempo(120, 0))).toEqual([])
  })
})

describe('autoMoveBounds — beat alignment', () => {
  const tempo = makeTempo(120, 0) // 0.5s/beat

  it('snaps a detected phrase change onto the beat grid', () => {
    // Two phrases change at ~t=12; with a tempo the cut lands on a beat (multiple of 0.5).
    const fs = frames(24, 0.1, (t) => (t < 12 ? 20 : 100))
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
