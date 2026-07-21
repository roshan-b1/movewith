import { describe, it, expect } from 'vitest'
import { dancerBoundsAt, pickShowcaseTime } from './preview'
import type { ReferenceFrame } from './types'
import type { Landmark } from '../pose/types'

/** A person filling x in [cx-0.05, cx+0.05], y in [0.3, 0.7]. */
function frame(t: number, cx: number, visible = true): ReferenceFrame {
  const image: Landmark[] = [
    { x: cx - 0.05, y: 0.3, z: 0, visibility: visible ? 1 : 0 },
    { x: cx + 0.05, y: 0.7, z: 0, visibility: visible ? 1 : 0 },
    { x: cx, y: 0.5, z: 0, visibility: visible ? 1 : 0 },
  ]
  return { t, world: [], image, angles: [90], visibility: [1] }
}

/** A dancer present for the whole span at `cx`, sampled every 0.2s. */
function dancer(cx: number, from: number, to: number, visible = true): ReferenceFrame[] {
  const out: ReferenceFrame[] = []
  for (let t = from; t <= to + 1e-9; t += 0.2) out.push(frame(+t.toFixed(2), cx, visible))
  return out
}

describe('dancerBoundsAt', () => {
  it('boxes the dancer with padding, clamped to the frame', () => {
    const b = dancerBoundsAt(dancer(0.5, 0, 10), 5)!
    expect(b).not.toBeNull()
    // Body spans 0.1 wide, 0.4 tall; 15% padding each side.
    expect(b.x).toBeCloseTo(0.45 - 0.015, 4)
    expect(b.w).toBeCloseTo(0.1 + 0.03, 4)
    expect(b.h).toBeCloseTo(0.4 + 0.12, 4)
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.w).toBeLessThanOrEqual(1.0001)
  })

  it('tracks a dancer to their side of the frame', () => {
    const left = dancerBoundsAt(dancer(0.25, 0, 10), 5)!
    const right = dancerBoundsAt(dancer(0.75, 0, 10), 5)!
    expect(left.x + left.w / 2).toBeLessThan(right.x + right.w / 2)
  })

  it('returns null when the dancer is not on screen near that time', () => {
    // Tracked only up to t=2; asking at t=9 is well past their last frame.
    expect(dancerBoundsAt(dancer(0.5, 0, 2), 9)).toBeNull()
    expect(dancerBoundsAt([], 5)).toBeNull()
  })

  it('returns null for low-visibility or image-less frames', () => {
    expect(dancerBoundsAt(dancer(0.5, 0, 10, false), 5)).toBeNull()
    const noImage: ReferenceFrame[] = [{ t: 5, world: [], angles: [90], visibility: [1] }]
    expect(dancerBoundsAt(noImage, 5)).toBeNull()
  })
})

describe('pickShowcaseTime', () => {
  it('picks a moment where both dancers are on screen', () => {
    // A is there the whole time; B only joins after t=6.
    const a = dancer(0.3, 0, 12)
    const b = dancer(0.7, 6, 12)
    const t = pickShowcaseTime([a, b], 0, 12)
    expect(dancerBoundsAt(a, t)).not.toBeNull()
    expect(dancerBoundsAt(b, t)).not.toBeNull()
  })

  it('prefers the middle when everyone is always on screen', () => {
    const t = pickShowcaseTime([dancer(0.3, 0, 12), dancer(0.7, 0, 12)], 0, 12)
    expect(t).toBeGreaterThan(4)
    expect(t).toBeLessThan(8)
  })

  it('falls back to the range start with nothing tracked', () => {
    expect(pickShowcaseTime([], 3, 9)).toBe(3)
    expect(pickShowcaseTime([[]], 0, 0)).toBe(0)
  })
})
