import { describe, it, expect } from 'vitest'
import { describeMove } from './describe'
import type { ReferenceFrame } from './types'
import type { Landmark } from '../pose/types'

// Angle layout: 10 joints — arms at 0..3, legs at 4..7, torso 8..9.
function frame(t: number, arm: number, leg: number, hipX?: number): ReferenceFrame {
  const angles = new Array(10).fill(90).map((v, j) => (j <= 3 ? arm : j <= 7 ? leg : v))
  const image: Landmark[] | undefined =
    hipX === undefined
      ? undefined
      : Array.from({ length: 33 }, () => ({ x: hipX, y: 0.5, z: 0, visibility: 1 }))
  return { t, world: [], angles, visibility: angles.map(() => 1), image }
}

function build(dur: number, fn: (t: number) => { arm: number; leg: number; hipX?: number }, dt = 0.1): ReferenceFrame[] {
  const out: ReferenceFrame[] = []
  for (let t = 0; t <= dur + 1e-9; t += dt) {
    const { arm, leg, hipX } = fn(+t.toFixed(3))
    out.push(frame(+t.toFixed(3), arm, leg, hipX))
  }
  return out
}

describe('describeMove', () => {
  it('calls an arms-driven move "Arms"', () => {
    const fs = build(6, (t) => ({ arm: 90 + 50 * Math.sin(t * 5), leg: 90 }))
    const c = describeMove(fs, 0, 6)!
    expect(c.focus).toBe('arms')
    expect(c.label).toMatch(/^Arms/)
  })

  it('calls a legs-driven move "Footwork"', () => {
    const fs = build(6, (t) => ({ arm: 90, leg: 90 + 50 * Math.sin(t * 5) }))
    expect(describeMove(fs, 0, 6)!.focus).toBe('legs')
  })

  it('calls balanced movement "Full body"', () => {
    const fs = build(6, (t) => ({ arm: 90 + 40 * Math.sin(t * 5), leg: 90 + 40 * Math.sin(t * 5 + 1) }))
    expect(describeMove(fs, 0, 6)!.focus).toBe('full body')
  })

  it('counts the repeats of a periodic move', () => {
    // Period 1.5s over 6s → 4 repeats.
    const fs = build(6, (t) => ({ arm: 90 + 45 * Math.sin((t * 2 * Math.PI) / 1.5), leg: 90 }))
    const c = describeMove(fs, 0, 6)!
    expect(c.reps).toBe(4)
    expect(c.label).toContain('4×')
  })

  it('does not invent repeats for a static hold', () => {
    const fs = build(6, () => ({ arm: 90, leg: 90 }))
    expect(describeMove(fs, 0, 6)!.reps).toBeNull()
  })

  it('spots a move that travels across the frame', () => {
    const fs = build(6, (t) => ({ arm: 90 + 40 * Math.sin(t * 5), leg: 90 + 40 * Math.sin(t * 4), hipX: 0.3 + (t / 6) * 0.4 }))
    const c = describeMove(fs, 0, 6)!
    expect(c.travels).toBe(true)
    expect(c.label).toContain('travels')
  })

  it('returns null with too little pose data', () => {
    expect(describeMove([], 0, 6)).toBeNull()
  })
})
