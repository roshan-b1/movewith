import { describe, it, expect } from 'vitest'
import { evenMoveBounds, autoMoveBounds } from './segment'
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
