// The versioned, serializable record produced from a tutorial video and persisted to
// IndexedDB. Bumping REFERENCE_VERSION lets future loaders migrate old saved dances
// instead of breaking on them — part of keeping the foundation stable over time.

import type { Landmark } from '../pose/types'
import type { Tempo, Section } from '../audio/beats'

export const REFERENCE_VERSION = 1 as const

/** One sampled frame of the reference performance. */
export interface ReferenceFrame {
  /** Seconds from start of video. */
  t: number
  /** 33 world landmarks. Used for the synthetic ghost and angle math. */
  world: Landmark[]
  /** 33 image-space landmarks (0..1 of the video frame) for drawing the skeleton
   *  aligned on top of the real instructor video. Absent for the synthetic demo. */
  image?: Landmark[]
  /** Precomputed joint-angle vector (degrees), in JOINT_ORDER. */
  angles: number[]
  /** Per-joint visibility 0..1, in JOINT_ORDER (for weighting comparisons). */
  visibility: number[]
}

export interface ReferenceSource {
  type: 'upload' | 'bundled'
  durationSec: number
  /** Effective sampling rate the frames were extracted at. */
  fps: number
}

export interface ReferenceTrack {
  version: typeof REFERENCE_VERSION
  id: string
  name: string
  /** Epoch millis. Passed in (not generated) so the core stays deterministic/testable. */
  createdAt: number
  source: ReferenceSource
  /** Key of the original video Blob stored separately in IndexedDB (null for fixtures). */
  videoBlobKey: string | null
  tempo: Tempo
  /** The ACTIVE dancer's frames — everything downstream (scoring, ghost, skeleton)
   *  reads these, so picking a dancer is just swapping this array. */
  frames: ReferenceFrame[]
  sections: Section[]
  /** Every dancer found in the video (most prominent first). Present only when the
   *  video had 2+ people; `frames` always equals `dancers[activeDancer]` then. */
  dancers?: ReferenceFrame[][]
  /** Which entry of `dancers` is being learned/graded against. */
  activeDancer?: number
}

/** The segments + settings the dancer set up, saved so they're restored next time. */
export interface PracticeSetup {
  trimStart: number
  trimEnd: number
  /** Internal cut times between segments (the user's segmentation). */
  moveBounds: number[]
  moveSec?: number
  /** Reps per segment; Infinity = loop till they move on. */
  reps?: number
  breakSecs?: number
  cameraOn?: boolean
  /** Show yourself (camera) while practicing and replay your take after each segment. */
  selfView?: boolean
  /** Segment indices skipped in practice (e.g. the instructor's explanation parts). */
  skip?: number[]
}

/** Per-dance learning progress, persisted alongside the track. */
export interface DanceProgress {
  trackId: string
  /** Best section score 0..100, keyed by section index. */
  bestSectionScores: Record<number, number>
  /** Highest section index unlocked (0-based). Section 0 is always unlocked. */
  unlockedThrough: number
  /** Section indices the dancer has marked complete (won't auto-resurface). */
  completed?: number[]
  /** Best full-run score 0..100, if attempted. */
  bestFullRun?: number
  /** The dancer's saved trim + segments + settings for this track. */
  setup?: PracticeSetup
}
