// Live pose tracking jitters frame to frame, which makes the skeleton shaky and the
// score bounce. The One-Euro filter is the standard fix for interactive motion: it
// smooths hard when you move slowly (kills jitter) and barely at all when you move fast
// (keeps it responsive, no rubber-banding lag). Pure and unit-tested, no DOM.

export interface OneEuroOptions {
  /** Baseline smoothing. Lower = smoother but laggier. */
  minCutoff?: number
  /** How much faster motion loosens the smoothing. Higher = more responsive when quick. */
  beta?: number
  /** Cutoff for the speed estimate itself. */
  dCutoff?: number
}

export class OneEuroFilter {
  private minCutoff: number
  private beta: number
  private dCutoff: number
  private xPrev: number | null = null
  private sPrev: number | null = null
  private dxPrev = 0
  private tPrev: number | null = null

  constructor(opts: OneEuroOptions = {}) {
    this.minCutoff = opts.minCutoff ?? 1.2
    this.beta = opts.beta ?? 0.4
    this.dCutoff = opts.dCutoff ?? 1.0
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  /** Filter one scalar sample taken at `tSeconds`. */
  filter(x: number, tSeconds: number): number {
    if (this.sPrev === null || this.tPrev === null) {
      this.sPrev = x
      this.xPrev = x
      this.tPrev = tSeconds
      this.dxPrev = 0
      return x
    }
    let dt = tSeconds - this.tPrev
    if (!(dt > 0)) dt = 1 / 30
    this.tPrev = tSeconds

    const dx = (x - (this.xPrev ?? x)) / dt
    const aD = this.alpha(this.dCutoff, dt)
    const edx = aD * dx + (1 - aD) * this.dxPrev
    this.dxPrev = edx

    const cutoff = this.minCutoff + this.beta * Math.abs(edx)
    const a = this.alpha(cutoff, dt)
    const s = a * x + (1 - a) * this.sPrev
    this.sPrev = s
    this.xPrev = x
    return s
  }

  reset(): void {
    this.xPrev = null
    this.sPrev = null
    this.tPrev = null
    this.dxPrev = 0
  }
}

import type { Landmark } from './types'

/** Applies a One-Euro filter to every coordinate of every landmark, frame over frame. */
export class LandmarkSmoother {
  private fx: OneEuroFilter[] = []
  private fy: OneEuroFilter[] = []
  private fz: OneEuroFilter[] = []

  constructor(private opts: OneEuroOptions = {}) {}

  private ensure(n: number): void {
    while (this.fx.length < n) {
      this.fx.push(new OneEuroFilter(this.opts))
      this.fy.push(new OneEuroFilter(this.opts))
      this.fz.push(new OneEuroFilter(this.opts))
    }
  }

  smooth(landmarks: Landmark[], tSeconds: number): Landmark[] {
    this.ensure(landmarks.length)
    return landmarks.map((lm, i) => ({
      x: this.fx[i]!.filter(lm.x, tSeconds),
      y: this.fy[i]!.filter(lm.y, tSeconds),
      z: this.fz[i]!.filter(lm.z, tSeconds),
      visibility: lm.visibility,
    }))
  }

  reset(): void {
    for (const f of this.fx) f.reset()
    for (const f of this.fy) f.reset()
    for (const f of this.fz) f.reset()
  }
}
