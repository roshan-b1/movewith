import { describe, it, expect } from 'vitest'
import { OneEuroFilter, LandmarkSmoother } from './smoothing'
import type { Landmark } from './types'

const variance = (a: number[]) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length
}

describe('OneEuroFilter', () => {
  it('returns the first sample unchanged', () => {
    expect(new OneEuroFilter().filter(5, 0)).toBe(5)
  })

  it('converges to a constant input', () => {
    const f = new OneEuroFilter()
    let v = 0
    for (let i = 0; i <= 30; i++) v = f.filter(5, i / 30)
    expect(v).toBeCloseTo(5, 3)
  })

  it('reduces jitter variance of a noisy constant', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0 })
    const input: number[] = []
    const output: number[] = []
    for (let i = 0; i < 200; i++) {
      const x = 10 + (i % 2 === 0 ? 1 : -1) // alternating +/- 1 jitter
      input.push(x)
      output.push(f.filter(x, i / 60))
    }
    // After warmup, the filtered signal should be far steadier than the raw one.
    expect(variance(output.slice(50))).toBeLessThan(variance(input.slice(50)) * 0.5)
  })

  it('still tracks a moving signal (does not flatline)', () => {
    const f = new OneEuroFilter()
    let v = 0
    for (let i = 0; i < 60; i++) v = f.filter(i, i / 60) // ramp 0..59
    expect(v).toBeGreaterThan(50) // followed the ramp up
  })
})

describe('LandmarkSmoother', () => {
  it('smooths each landmark and preserves visibility', () => {
    const s = new LandmarkSmoother({ minCutoff: 1, beta: 0 })
    const noisy = (i: number): Landmark[] => [
      { x: 0.5 + (i % 2 ? 0.05 : -0.05), y: 0.5, z: 0, visibility: 0.9 },
    ]
    let out: Landmark[] = []
    for (let i = 0; i < 60; i++) out = s.smooth(noisy(i), i / 60)
    expect(out[0]!.visibility).toBe(0.9)
    expect(Math.abs(out[0]!.x - 0.5)).toBeLessThan(0.05) // jitter pulled toward center
  })
})
