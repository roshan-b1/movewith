// The live loop. Each animation frame: read the webcam pose, ask what the instructor
// looks like right now, compare them, and emit feedback (overall score + per-limb
// good/bad for the overlay). While "recording" a section take, it buffers the dancer's
// angle vectors so a whole 8-count can be DTW-scored when the take ends.

import { jointAngles, jointVisibility, mirrorAngles } from '../core/pose/angles'
import { compareAngles, type FrameComparison, type ScoreConfig, STRICT } from '../core/compare/similarity'
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
}

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
    }

    if (this.webcam.readyState >= 2) {
      const pose = this.provider.detectLive(this.webcam, tsMs)
      if (pose) {
        const liveAngles = jointAngles(pose.world)
        const vis = jointVisibility(pose.world)
        const ref = this.getReference()

        if (ref.angles) {
          const refAngles = ref.mirror ? mirrorAngles(ref.angles) : ref.angles
          const cmp = compareAngles(refAngles, liveAngles, this.cfg, vis)
          // Exponential moving average smooths the meter without lagging too far.
          this.rolling = this.rolling * 0.8 + cmp.score * 0.2
          result = {
            liveImage: pose.image,
            frame: cmp,
            rollingScore: this.rolling,
            recording: this.recording,
            bodyPresent: true,
          }
          if (this.recording) {
            this.takeAngles.push(liveAngles)
            if (this.takeAngles.length > MAX_TAKE_FRAMES) this.takeAngles.shift()
          }
        } else {
          result = { ...result, liveImage: pose.image, bodyPresent: true }
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
