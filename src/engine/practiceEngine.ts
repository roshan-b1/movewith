// The live loop. Each animation frame: read the webcam pose(s), ask what the instructor
// (or instructors — a group can test together) looks like right now, compare, and emit
// feedback (overall score + per-limb good/bad for the overlay). While "recording" a
// section take, it buffers each dancer's angle vectors so a whole 8-count can be
// DTW-scored per person when the take ends.

import { jointAngles, jointVisibility, mirrorAngles } from '../core/pose/angles'
import { compareAngles, type FrameComparison, type ScoreConfig, STRICT } from '../core/compare/similarity'
import { LandmarkSmoother } from '../core/pose/smoothing'
import { assignPeopleToSlots } from '../core/pose/people'
import type { Landmark } from '../core/pose/types'
import type { PoseProvider } from '../providers/poseProvider'

/** What the instructor(s) should look like at the current instant. One entry per tracked
 *  slot, ordered display-left → display-right (how the dancers appear on screen). */
export interface ReferenceContext {
  /** Reference angle vector per slot at the current time (null while unknown). */
  anglesList: (number[] | null)[]
  /** Whether the dancer is in mirror mode (we mirror the reference to match). */
  mirror: boolean
}

/** One tracked person's live read for this frame. */
export interface PersonLive {
  /** Image-space landmarks for the overlay (0..1), or null if this slot is empty. */
  image: Landmark[] | null
  /** Per-frame comparison vs this slot's reference, or null. */
  frame: FrameComparison | null
  /** True when too few joints are confidently tracked to trust this slot's score. */
  lowConfidence: boolean
}

export interface LiveResult {
  /** Per-slot live reads, same order as the ReferenceContext anglesList. */
  people: PersonLive[]
  /** First present person's image — kept for single-dancer consumers. */
  liveImage: Landmark[] | null
  /** First present person's comparison — kept for single-dancer consumers. */
  frame: FrameComparison | null
  /** Smoothed 0..100 score for the accuracy meter (mean across present slots). */
  rollingScore: number
  /** True while a section take is being recorded. */
  recording: boolean
  /** Whether any body was detected this frame (drives the "step into frame" hint). */
  bodyPresent: boolean
  /** 0..1 average confidence across present bodies this frame. */
  trackingConfidence: number
  /** True when no slot has a confidently-tracked body. */
  lowConfidence: boolean
}

/** A joint must be at least this visible to count toward the score. Below it, we don't
 *  penalize you for what the model cannot clearly see. */
const MIN_JOINT_VISIBILITY = 0.5

/** Detections per second. The webcam loop runs at display rate; detecting every frame
 *  wastes GPU/battery for no benefit, so we cap pose inference here. */
const DETECT_FPS = 30
/** Safety cap on each take buffer (~2 min at DETECT_FPS) so long sessions can't grow it
 *  without bound when looping is off and takes are never consumed. */
const MAX_TAKE_FRAMES = DETECT_FPS * 120

export type LiveListener = (r: LiveResult) => void

export class PracticeEngine {
  private provider: PoseProvider
  private webcam: HTMLVideoElement
  private getReference: () => ReferenceContext
  private cfg: ScoreConfig
  private listeners = new Set<LiveListener>()

  private running = false
  private rafId = 0
  private rollingPer: number[] = []
  private recording = false
  /** Per-slot take buffers: takes[slot] = angle vectors in time order. */
  private takes: number[][][] = []
  /** Per-slot One-Euro smoothers that de-jitter landmarks for steadier scoring/overlay. */
  private worldSmoothers: LandmarkSmoother[] = []
  private imageSmoothers: LandmarkSmoother[] = []
  /** Last timestamp passed to MediaPipe; must strictly increase or it throws. */
  private lastTsMs = 0
  /** Wall-clock of the last detection, for FPS throttling. */
  private lastDetectMs = 0

  constructor(opts: {
    provider: PoseProvider
    webcam: HTMLVideoElement
    getReference: () => ReferenceContext
    config?: ScoreConfig
  }) {
    this.provider = opts.provider
    this.webcam = opts.webcam
    this.getReference = opts.getReference
    this.cfg = opts.config ?? STRICT
  }

  setConfig(cfg: ScoreConfig) {
    this.cfg = cfg
  }

  onResult(fn: LiveListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  start() {
    if (this.running) return
    this.running = true
    this.rafId = requestAnimationFrame(this.frame)
  }

  stop() {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.worldSmoothers.forEach((s) => s.reset())
    this.imageSmoothers.forEach((s) => s.reset())
  }

  /** Begin buffering every slot's angles for a section take. */
  startRecording() {
    this.takes = []
    this.recording = true
  }

  /** Stop buffering and return the captured angle vectors per slot (in time order). */
  stopRecording(): number[][][] {
    this.recording = false
    return this.takes
  }

  /** Slot `i`'s smoothers, created on first use so the slot count can change freely. */
  private smoothersFor(i: number): { world: LandmarkSmoother; image: LandmarkSmoother } {
    while (this.worldSmoothers.length <= i) {
      this.worldSmoothers.push(new LandmarkSmoother({ minCutoff: 1.2, beta: 0.4 }))
      this.imageSmoothers.push(new LandmarkSmoother({ minCutoff: 1.5, beta: 0.5 }))
    }
    return { world: this.worldSmoothers[i]!, image: this.imageSmoothers[i]! }
  }

  private frame = () => {
    if (!this.running) return

    const now = performance.now()
    // Throttle detection to DETECT_FPS — re-schedule without re-detecting if too soon.
    if (now - this.lastDetectMs < 1000 / DETECT_FPS) {
      this.rafId = requestAnimationFrame(this.frame)
      return
    }
    this.lastDetectMs = now

    // MediaPipe's VIDEO mode requires strictly-increasing timestamps.
    const tsMs = now <= this.lastTsMs ? this.lastTsMs + 1 : now
    this.lastTsMs = tsMs

    const ref = this.getReference()
    const slots = Math.max(1, ref.anglesList.length)
    const people: PersonLive[] = Array.from({ length: slots }, () => ({
      image: null,
      frame: null,
      lowConfidence: true,
    }))
    let anyBody = false
    let confSum = 0
    let confN = 0

    if (this.webcam.readyState >= 2) {
      const detected = this.provider.detectLiveAll(this.webcam, tsMs)
      const assigned = assignPeopleToSlots(detected, slots)
      const tSec = tsMs / 1000

      for (let i = 0; i < slots; i++) {
        const pose = assigned[i]
        if (!pose) continue
        anyBody = true
        // Smooth the raw landmarks so jitter doesn't shake the score or overlay.
        const sm = this.smoothersFor(i)
        const world = sm.world.smooth(pose.world, tSec)
        const image = sm.image.smooth(pose.image, tSec)

        const liveAngles = jointAngles(world)
        const vis = jointVisibility(world)
        // Confidence gating: drop joints the model can't clearly see (weight 0) so you
        // aren't scored on them.
        const weights = vis.map((v) => (v < MIN_JOINT_VISIBILITY ? 0 : v))
        const confidentJoints = weights.reduce((n, w) => (w > 0 ? n + 1 : n), 0)
        const lowConfidence = confidentJoints < Math.ceil(vis.length * 0.5)
        confSum += vis.reduce((s, v) => s + v, 0) / vis.length
        confN++

        const refAngles = ref.anglesList[i]
        let cmp: FrameComparison | null = null
        if (refAngles) {
          cmp = compareAngles(ref.mirror ? mirrorAngles(refAngles) : refAngles, liveAngles, this.cfg, weights)
          // Only a confident frame moves the score or feeds a take; an unreliable read
          // should neither punish nor flatter anyone.
          if (!lowConfidence) {
            this.rollingPer[i] = (this.rollingPer[i] ?? 0) * 0.8 + cmp.score * 0.2
            if (this.recording) {
              const buf = (this.takes[i] ??= [])
              buf.push(liveAngles)
              if (buf.length > MAX_TAKE_FRAMES) buf.shift()
            }
          }
        }
        people[i] = { image, frame: cmp, lowConfidence }
      }

      // Empty slots' meters decay so they don't sit on a stale high score.
      for (let i = 0; i < slots; i++) {
        if (!people[i]!.image) this.rollingPer[i] = (this.rollingPer[i] ?? 0) * 0.9
      }
    }

    const present = people.filter((p) => p.image !== null)
    const rollingVals = this.rollingPer.slice(0, slots)
    const rolling = rollingVals.length
      ? rollingVals.reduce((a, b) => a + (b ?? 0), 0) / rollingVals.length
      : 0
    const first = people.find((p) => p.image !== null)

    const result: LiveResult = {
      people,
      liveImage: first?.image ?? null,
      frame: first?.frame ?? null,
      rollingScore: rolling,
      recording: this.recording,
      bodyPresent: anyBody,
      trackingConfidence: confN ? confSum / confN : 0,
      lowConfidence: present.length === 0 || present.every((p) => p.lowConfidence),
    }

    for (const fn of this.listeners) fn(result)
    this.rafId = requestAnimationFrame(this.frame)
  }
}
