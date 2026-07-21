// The seam between the app and whatever pose-tracking library we use. The whole
// engine depends only on this interface, so swapping MediaPipe for something else
// later is a single new file — nothing downstream changes.

import type { Landmark } from '../core/pose/types'

export interface PoseResult {
  /** 33 world landmarks (meters, hip-centred) — used for angle math. */
  world: Landmark[]
  /** 33 image-normalised landmarks (0..1) — used for drawing on the video/webcam. */
  image: Landmark[]
}

export interface PoseProvider {
  /** Load models/weights. Safe to call repeatedly; resolves once ready. */
  init(): Promise<void>
  /** Detect a pose from a still frame (video seeked to a time, or an image). */
  detectImage(input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement): Promise<PoseResult | null>
  /** Detect EVERY person in a still frame (multi-dancer videos). Order is arbitrary —
   *  association across frames is the caller's job (core/pose/people.ts). */
  detectImageAll(input: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement): Promise<PoseResult[]>
  /** Detect a pose from a live stream frame. `timestampMs` must increase monotonically.
   *  With several people in frame this returns the most prominent one. */
  detectLive(input: HTMLVideoElement, timestampMs: number): PoseResult | null
  /** Detect EVERY person in a live stream frame (group "Test my skills"). Order is
   *  arbitrary — slot assignment is the caller's job (core/pose/people.ts). */
  detectLiveAll(input: HTMLVideoElement, timestampMs: number): PoseResult[]
  /** Release GPU/wasm resources. */
  close(): void
}
