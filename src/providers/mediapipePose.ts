// MediaPipe Pose Landmarker (BlazePose) implementation of PoseProvider.
// 33 keypoints + true 3D world landmarks, GPU-accelerated, runs entirely in-browser.
// Two internal landmarkers: IMAGE mode for offline video extraction (each frame
// independent), VIDEO mode for the live webcam (needs monotonic timestamps).

import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'
import type { Landmark } from '../core/pose/types'
import type { PoseProvider, PoseResult } from './poseProvider'

const VERSION = '0.10.18'
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker'
export const POSE_MODELS = {
  lite: `${MODEL_BASE}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  full: `${MODEL_BASE}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  heavy: `${MODEL_BASE}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
} as const

function toLandmark(l: NormalizedLandmark): Landmark {
  return { x: l.x, y: l.y, z: l.z, visibility: l.visibility }
}

function mapResult(res: PoseLandmarkerResult | undefined): PoseResult | null {
  if (!res || !res.worldLandmarks || res.worldLandmarks.length === 0) return null
  const world = res.worldLandmarks[0]
  const image = res.landmarks[0]
  if (!world || !image) return null
  return { world: world.map(toLandmark), image: image.map(toLandmark) }
}

function mapAll(res: PoseLandmarkerResult | undefined): PoseResult[] {
  if (!res || !res.worldLandmarks) return []
  const out: PoseResult[] = []
  for (let i = 0; i < res.worldLandmarks.length; i++) {
    const world = res.worldLandmarks[i]
    const image = res.landmarks[i]
    if (world && image) out.push({ world: world.map(toLandmark), image: image.map(toLandmark) })
  }
  return out
}

export interface MediaPipePoseOptions {
  /** 'GPU' (default) falls back to 'CPU' automatically if GPU init fails. */
  delegate?: 'GPU' | 'CPU'
  /** Model for offline extraction (one-time). Defaults to the accurate 'full' model
   *  so complex tutorial movement is captured precisely. */
  imageModelUrl?: string
  /** Model for the live webcam loop. Defaults to fast 'lite' to hold real-time fps. */
  videoModelUrl?: string
  wasmBase?: string
}

export class MediaPipePoseProvider implements PoseProvider {
  private image: PoseLandmarker | null = null
  private video: PoseLandmarker | null = null
  private initPromise: Promise<void> | null = null
  private opts: Required<MediaPipePoseOptions>

  constructor(opts: MediaPipePoseOptions = {}) {
    this.opts = {
      delegate: opts.delegate ?? 'GPU',
      imageModelUrl: opts.imageModelUrl ?? POSE_MODELS.full,
      videoModelUrl: opts.videoModelUrl ?? POSE_MODELS.lite,
      wasmBase: opts.wasmBase ?? WASM_BASE,
    }
  }

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(this.opts.wasmBase)

    // Both modes detect several people: IMAGE so multi-dancer videos can offer a "which
    // dancer?" picker, VIDEO so a group can Test my skills together. MediaPipe only runs
    // its full pipeline per person actually present, so a solo dancer costs the same.
    const make = (runningMode: 'IMAGE' | 'VIDEO', delegate: 'GPU' | 'CPU', modelUrl: string) =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl, delegate },
        runningMode,
        numPoses: 4,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      })

    try {
      this.image = await make('IMAGE', this.opts.delegate, this.opts.imageModelUrl)
      this.video = await make('VIDEO', this.opts.delegate, this.opts.videoModelUrl)
    } catch (err) {
      // GPU delegate can fail on some machines/browsers — fall back to CPU once.
      if (this.opts.delegate === 'GPU') {
        console.warn('[pose] GPU delegate failed, falling back to CPU', err)
        this.opts.delegate = 'CPU'
        this.image = await make('IMAGE', 'CPU', this.opts.imageModelUrl)
        this.video = await make('VIDEO', 'CPU', this.opts.videoModelUrl)
      } else {
        throw err
      }
    }
  }

  async detectImage(
    input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  ): Promise<PoseResult | null> {
    await this.init()
    if (!this.image) return null
    return mapResult(this.image.detect(input))
  }

  async detectImageAll(
    input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  ): Promise<PoseResult[]> {
    await this.init()
    if (!this.image) return []
    return mapAll(this.image.detect(input))
  }

  detectLive(input: HTMLVideoElement, timestampMs: number): PoseResult | null {
    if (!this.video) return null
    // Several people (or a phantom detection) can be in frame — a solo flow wants the
    // most prominent body, so pick the largest by image-space torso length.
    const all = mapAll(this.video.detectForVideo(input, timestampMs))
    if (all.length === 0) return null
    let best = all[0]!
    let bestSize = -1
    for (const p of all) {
      const sh = p.image[11]
      const hip = p.image[23]
      const size = sh && hip ? Math.hypot(sh.x - hip.x, sh.y - hip.y) : 0
      if (size > bestSize) { bestSize = size; best = p }
    }
    return best
  }

  detectLiveAll(input: HTMLVideoElement, timestampMs: number): PoseResult[] {
    if (!this.video) return []
    return mapAll(this.video.detectForVideo(input, timestampMs))
  }

  get delegateInUse(): 'GPU' | 'CPU' {
    return this.opts.delegate
  }

  close(): void {
    this.image?.close()
    this.video?.close()
    this.image = null
    this.video = null
    this.initPromise = null
  }
}
