// Assemble a ReferenceTrack from raw extracted frames + tempo, and provide samplers
// the live engine uses to ask "what should the body look like at time t / in section s".

import { jointAngles, jointVisibility } from '../pose/angles'
import type { Landmark } from '../pose/types'
import { buildSections, type Tempo } from '../audio/beats'
import {
  REFERENCE_VERSION,
  type ReferenceFrame,
  type ReferenceTrack,
} from './types'

export interface RawFrame {
  t: number
  world: Landmark[]
  /** Image-space landmarks (0..1) for overlaying on the real video. Optional. */
  image?: Landmark[]
}

export interface BuildArgs {
  id: string
  name: string
  createdAt: number
  videoBlobKey: string | null
  durationSec: number
  fps: number
  rawFrames: RawFrame[]
  tempo: Tempo
  beatsPerSection?: number
  sourceType?: 'upload' | 'bundled'
}

/** Precompute angles/visibility for every frame and cut the track into 8-counts. */
export function buildReferenceTrack(args: BuildArgs): ReferenceTrack {
  const frames: ReferenceFrame[] = args.rawFrames
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((f) => ({
      t: f.t,
      world: f.world,
      ...(f.image ? { image: f.image } : {}),
      angles: jointAngles(f.world),
      visibility: jointVisibility(f.world),
    }))

  const sections = buildSections(args.tempo, {
    durationSec: args.durationSec,
    beatsPerSection: args.beatsPerSection,
    includeLeadIn: true,
  })

  return {
    version: REFERENCE_VERSION,
    id: args.id,
    name: args.name,
    createdAt: args.createdAt,
    source: { type: args.sourceType ?? 'upload', durationSec: args.durationSec, fps: args.fps },
    videoBlobKey: args.videoBlobKey,
    tempo: args.tempo,
    frames,
    sections,
  }
}

/** Index of the reference frame nearest in time to `t` (binary search). */
export function nearestFrameIndex(frames: ReferenceFrame[], t: number): number {
  if (frames.length === 0) return -1
  let lo = 0
  let hi = frames.length - 1
  if (t <= frames[lo]!.t) return lo
  if (t >= frames[hi]!.t) return hi
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const mt = frames[mid]!.t
    if (mt === t) return mid
    if (mt < t) lo = mid + 1
    else hi = mid - 1
  }
  // lo is the first frame after t; pick whichever of lo/hi is closer.
  const after = frames[lo]!
  const before = frames[hi]!
  return Math.abs(after.t - t) < Math.abs(t - before.t) ? lo : hi
}

/** Reference angle vector at time `t` (nearest frame). */
export function anglesAt(track: ReferenceTrack, t: number): number[] | null {
  const i = nearestFrameIndex(track.frames, t)
  return i >= 0 ? track.frames[i]!.angles : null
}

/** All reference angle vectors whose time falls within [startSec, endSec). */
export function sectionAngles(track: ReferenceTrack, startSec: number, endSec: number): number[][] {
  return track.frames.filter((f) => f.t >= startSec && f.t < endSec).map((f) => f.angles)
}
