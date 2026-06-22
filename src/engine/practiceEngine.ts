// The live loop. Each animation frame: read the webcam pose, ask what the instructor
// looks like right now, compare them, and emit feedback (overall score + per-limb
// good/bad for the overlay). While "recording" a section take, it buffers the dancer's
// angle vectors so a whole 8-count can be DTW-scored when the take ends.

import { jointAngles, jointVisibility, mirrorAngles } from '../core/pose/angles'
import { compareAngles, type FrameComparison, type ScoreConfig, STRICT } from '../core/compare/similarity'
import { LandmarkSmoother } from '../core/pose/smoothing'
import type { Landmark } from '../core/pose/types'
import type { PoseProvider } from '../providers/poseProvider'

/** What the instructor should look like at the current instant. */
export interface ReferenceContext {
  /** Reference angle vector at the current instructor time, or null if unknown. */
  angles: number[] | null
  /** Whether the dancer is in mirror mode (we mirror the reference to match). */
  mirror: boolean
}

export interface LiveResult {
  /** Image-space landmarks of the dancer for the overlay (0..1), or null if no body. */
  liveImage: Landmark[] | null
  /** Per-frame comparison vs the instructor, or null if no reference/body. */
  frame: FrameComparison | null
  /** Smoothed 0..100 score for the accuracy meter. */
  rollingScore: number
  /** True while a section take is being recorded. */
  recording: boolean
  /** Whether a body was detected this frame (drives the "step into frame" hint). */
  bodyPresent: boolean
  /** 0..1 average confidence the tracker has in the body it sees this frame. */
  trackingConfidence: number
  /** True when too few joints are confidently tracked to trust the score. */
  lowConfidence: boolean
}

/** A joint must be at least this visible to count toward the score. Below it, we don't
 *  penalize you for what the model cannot clearly see. */
const MIN_JOINT_VISIBILITY = 0.5

/** Detections per second. The webcam loop runs at display rate; detecting every frame
 *  wastes GPU/battery for no benefit, so we cap pose inference here. */
const DETECT_FPS = 30
/** Safety cap on the take buffer (~2 min at DETECT_FPS) so long sessions can't grow it
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
  private rolling = 0
  private recording = false
  private takeAngles: number[][] = []
  /** One-Euro smoothers that de-jitter the live landmarks for steadier scoring/overlay. */
  private worldSmoother = new LandmarkSmoother({ minCutoff: 1.2, beta: 0.4 })
  private imageSmoother = new LandmarkSmoother({ minCutoff: 1.5, beta: 0.5 })
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
    this.worldSmoother.reset()
    this.imageSmoother.reset()
  }

  /** Begin buffering the dancer's angles for a section take. */
  startRecording() {
    this.takeAngles = []
    this.recording = true
  }

  /** Stop buffering and return the captured angle vectors (in time order). */
  stopRecording(): number[][] {
    this.recording = false
    return this.takeAngles
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

    let result: LiveResult = {
      liveImage: null,
      frame: null,
      rollingScore: this.rolling,
      recording: this.recording,
      bodyPresent: false,
      trackingConfidence: 0,
      lowConfidence: true,
    }

    if (this.webcam.readyState >= 2) {
      const pose = this.provider.detectLive(this.webcam, tsMs)
      if (pose) {
        const tSec = tsMs / 1000
        // Smooth the raw landmarks first so jitter doesn't shake the score or overlay.
        const world = this.worldSmoother.smooth(pose.world, tSec)
        const image = this.imageSmoother.smooth(pose.image, tSec)

        const liveAngles = jointAngles(world)
        const vis = jointVisibility(world)
        // Confidence gating: drop joints the model can't clearly see (weight 0) so you
        // aren't scored on them. Also derive an overall tracking-confidence read.
        const weights = vis.map((v) => (v < MIN_JOINT_VISIBILITY ? 0 : v))
        const confidentJoints = weights.reduce((n, w) => (w > 0 ? n + 1 : n), 0)
        const trackingConfidence = vis.reduce((s, v) => s + v, 0) / vis.length
        const lowConfidence = confidentJoints < Math.ceil(vis.length * 0.5)

        const ref = this.getReference()

        if (ref.angles) {
          const refAngles = ref.mirror ? mirrorAngles(ref.angles) : ref.angles
          const cmp = compareAngles(refAngles, liveAngles, this.cfg, weights)
          // Only a confident frame moves the score or feeds a take; an unreliable read
          // should neither punish nor flatter you.
          result = {
            liveImage: image,
            frame: cmp,
            rollingScore: this.rolling,
            recording: this.recording,
            bodyPresent: true,
            trackingConfidence,
            lowConfidence,
          }
          if (!lowConfidence) {
            this.rolling = this.rolling * 0.8 + cmp.score * 0.2
            result.rollingScore = this.rolling
            if (this.recording) {
              this.takeAngles.push(liveAngles)
              if (this.takeAngles.length > MAX_TAKE_FRAMES) this.takeAngles.shift()
            }
          }
        } else {
          result = { ...result, liveImage: image, bodyPresent: true, trackingConfidence, lowConfidence }
        }
      } else {
        // No body in frame — let the meter decay so it doesn't sit on a stale high score.
        this.rolling *= 0.9
        result.rollingScore = this.rolling
      }
    }

    for (const fn of this.listeners) fn(result)
    this.rafId = requestAnimationFrame(this.frame)
  }
}
