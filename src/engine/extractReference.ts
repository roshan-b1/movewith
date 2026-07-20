// One-time offline pass over an uploaded video: seek frame-by-frame, run pose
// detection on each, detect tempo from the audio, then assemble a ReferenceTrack.
// Kept free of storage/UI imports — it returns data; the caller persists it.

import { guess } from 'web-audio-beat-detector'
import { makeTempo } from '../core/audio/beats'
import { buildReferenceTrack, buildFrames, type RawFrame } from '../core/reference/build'
import { associatePeople, type DetectedFrame } from '../core/pose/people'
import type { ReferenceTrack } from '../core/reference/types'
import type { PoseProvider } from '../providers/poseProvider'

export interface ExtractProgress {
  phase: 'loading' | 'tempo' | 'pose' | 'building' | 'done'
  /** 0..1 within the current phase. */
  ratio: number
  message: string
}

export interface ExtractArgs {
  file: File | Blob
  name: string
  provider: PoseProvider
  /** Epoch millis stamped onto the track. */
  createdAt: number
  /** Frames per second to sample for pose extraction. Default 12. */
  sampleFps?: number
  /** Hard cap on sampled frames to keep long clips from hanging. Default 720. */
  maxFrames?: number
  /** Playback-only: skip pose extraction entirely (fast import, no coaching/scoring). */
  skipPose?: boolean
  onProgress?: (p: ExtractProgress) => void
}

export interface ExtractResult {
  track: ReferenceTrack
  videoBlob: Blob
}

/** Yield to the event loop WITHOUT rAF or setTimeout: rAF is suspended and timers are
 *  throttled to 1s+ in background tabs, which used to freeze extraction the moment the
 *  user switched away. MessageChannel messages are never throttled, so the upload keeps
 *  processing at full speed even with the tab hidden. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => {
      ch.port1.close()
      resolve()
    }
    ch.port2.postMessage(null)
  })
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'auto'
    v.muted = true
    v.playsInline = true
    v.crossOrigin = 'anonymous'
    v.src = url
    v.onloadedmetadata = () => resolve(v)
    v.onerror = () => reject(new Error('Could not load video metadata'))
  })
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  const target = Math.min(t, Math.max(0, (video.duration || 0) - 0.001))
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      video.removeEventListener('seeked', onSeeked)
      if (timer !== undefined) clearTimeout(timer)
      // Give the frame a tick to settle before detect(). Visible tab: one rAF (a real
      // paint). Hidden tab: rAF never fires — a MessageChannel tick (never throttled)
      // keeps the extraction running while the user is on another tab. The timer covers
      // the one frame where the tab goes hidden AFTER its rAF was scheduled.
      if (document.hidden) {
        void nextTick().then(resolve)
      } else {
        let done = false
        const go = () => { if (!done) { done = true; resolve() } }
        requestAnimationFrame(go)
        setTimeout(go, 350)
      }
    }
    const onSeeked = () => finish()

    // If we're already at the target (e.g. the very first frame at t=0), setting
    // currentTime fires no 'seeked' event — resolve directly instead of hanging.
    if (Math.abs(video.currentTime - target) < 1e-3 && video.readyState >= 2) {
      finish()
      return
    }
    video.addEventListener('seeked', onSeeked)
    // Safety net: never block the whole extraction on a single stubborn seek.
    timer = setTimeout(finish, 1500)
    video.currentTime = target
  })
}

async function detectTempo(file: Blob, onProgress?: (p: ExtractProgress) => void) {
  onProgress?.({ phase: 'tempo', ratio: 0.2, message: 'Listening for the beat…' })
  let ctx: AudioContext | null = null
  try {
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    const buf = await ctx.decodeAudioData(await file.arrayBuffer())
    const { bpm, offset } = await guess(buf)
    return makeTempo(bpm, offset)
  } catch (err) {
    // Many video containers won't decode through Web Audio; that's fine — fall back
    // to a sensible default so sectioning still works.
    console.warn('[extract] tempo detection failed, using default 120 bpm', err)
    return makeTempo(120, 0)
  } finally {
    await ctx?.close().catch(() => {})
  }
}

export async function extractReferenceFromVideo(args: ExtractArgs): Promise<ExtractResult> {
  const sampleFps = args.sampleFps ?? 12
  const maxFrames = args.maxFrames ?? 720
  const skipPose = args.skipPose ?? false
  const onProgress = args.onProgress

  if (!skipPose) await args.provider.init()

  onProgress?.({ phase: 'loading', ratio: 0, message: 'Loading video…' })
  const url = URL.createObjectURL(args.file)
  try {
    const video = await loadVideo(url)
    const durationSec = video.duration

    const tempo = await detectTempo(args.file, onProgress)

    // Sample frames (skipped entirely in playback-only mode). Every person in each
    // frame is detected; association into per-dancer tracks happens afterwards.
    let rawFrames: RawFrame[] = []
    let dancerTracks: RawFrame[][] = []
    if (!skipPose) {
      const detected: DetectedFrame[] = []
      const count = Math.min(maxFrames, Math.max(2, Math.floor(durationSec * sampleFps)))
      for (let i = 0; i < count; i++) {
        const t = (i / (count - 1)) * Math.max(0, durationSec - 0.05)
        await seekTo(video, t)
        const people = await args.provider.detectImageAll(video)
        if (people.length > 0) detected.push({ t, people })
        onProgress?.({
          phase: 'pose',
          ratio: (i + 1) / count,
          message: `Tracking movement… ${Math.round(((i + 1) / count) * 100)}%`,
        })
        // Yield to the event loop so the progress UI can paint. MessageChannel, not
        // setTimeout — background tabs clamp timers to 1s+, which made the upload crawl.
        if (i % 4 === 0) await nextTick()
      }
      // Stitch detections into stable per-person tracks; track 0 is the main dancer.
      dancerTracks = associatePeople(detected)
      rawFrames = dancerTracks[0] ?? []
      if (rawFrames.length < 2) {
        throw new Error('No body detected in this video. Try a clearer, well-lit clip with a full-body shot.')
      }
      if (dancerTracks.length > 1) {
        onProgress?.({ phase: 'building', ratio: 0.85, message: `Found ${dancerTracks.length} dancers…` })
      }
    }

    onProgress?.({ phase: 'building', ratio: 0.9, message: 'Building your lesson…' })

    const videoBlobKey = crypto.randomUUID()
    const track = buildReferenceTrack({
      id: crypto.randomUUID(),
      name: args.name,
      createdAt: args.createdAt,
      videoBlobKey,
      durationSec,
      fps: sampleFps,
      rawFrames,
      tempo,
      beatsPerSection: 8,
      sourceType: 'upload',
    })
    // Multi-dancer video: keep every dancer's timeline so "Test my skills" can offer
    // a picker. `frames` stays the active dancer (0 = most prominent, by default).
    if (dancerTracks.length > 1) {
      track.dancers = dancerTracks.map(buildFrames)
      track.activeDancer = 0
      track.frames = track.dancers[0]!
    }

    onProgress?.({ phase: 'done', ratio: 1, message: 'Ready!' })
    return { track, videoBlob: args.file }
  } finally {
    URL.revokeObjectURL(url)
  }
}
