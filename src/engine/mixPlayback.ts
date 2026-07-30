// Plays a mix (a medley stitched from parts of several dances) on a single <video>. Where
// the normal PlaybackController drives one video with one src, a mix spans several source
// videos, so this controller swaps the element's `src` at every clip boundary and seeks to
// that clip's in-point. It exposes ONE continuous "mix time" (0..mixDuration) built from
// the pure timeline math in core/mix/timeline.ts, so the UI never has to think about which
// underlying file is playing.
//
// Two modes, mirroring how practice works:
//  - whole-mix play: run every clip start to finish (used by preview and full run-through).
//  - single-clip loop: repeat one clip (used to drill one part of the medley).

import type { MixClip } from '../core/mix/timeline'
import { clipOffsets, mixDuration, mapMixTime, clipSpan } from '../core/mix/timeline'

export type MixTick = (mixTimeSec: number) => void
/** Resolve a source track id to a playable object URL (cached by the caller). */
export type SourceUrlResolver = (sourceTrackId: string) => string | null

/** A tiny margin so we treat "basically at the clip's out-point" as the end. */
const END_EPS = 0.06

export class MixPlaybackController {
  private video: HTMLVideoElement
  private clips: MixClip[]
  private resolve: SourceUrlResolver
  private offsets: number[]
  private total: number

  private rate = 1
  private _mirror = false
  private playing = false
  private rafId = 0
  /** Which clip's source is currently loaded into the <video>, or -1 if none. Committed
   *  ONLY after the new source is actually ready, so getMixTime never mixes a new index
   *  with the old source's currentTime. */
  private loadedIndex = -1
  /** In-flight load, so concurrent ensureLoaded() calls for the same clip share one load
   *  (and callers never seek/play before the source is ready). */
  private pendingLoad: { index: number; promise: Promise<boolean> } | null = null
  /** null = play the whole mix; a number = loop just that clip. */
  private loopClip: number | null = null
  /** Guards against overlapping source swaps while a seek/load is in flight. */
  private swapping = false

  private tickListeners = new Set<MixTick>()
  private playListeners = new Set<(playing: boolean) => void>()

  constructor(video: HTMLVideoElement, clips: MixClip[], resolve: SourceUrlResolver) {
    this.video = video
    this.clips = clips
    this.resolve = resolve
    this.offsets = clipOffsets(clips)
    this.total = mixDuration(clips)
    video.preservesPitch = true
    ;(video as unknown as { mozPreservesPitch?: boolean }).mozPreservesPitch = true
    ;(video as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
    video.playsInline = true
  }

  get duration(): number {
    return this.total
  }
  get isPlaying(): boolean {
    return this.playing
  }
  get mirror(): boolean {
    return this._mirror
  }

  onTick(fn: MixTick): () => void {
    this.tickListeners.add(fn)
    return () => this.tickListeners.delete(fn)
  }
  onPlayingChange(fn: (playing: boolean) => void): () => void {
    this.playListeners.add(fn)
    return () => this.playListeners.delete(fn)
  }

  setMirror(on: boolean): void {
    this._mirror = on
  }

  setRate(rate: number): void {
    this.rate = rate
    this.video.playbackRate = rate
  }

  /** Loop just one clip (drill a part), or pass null to play the whole mix through. The
   *  caller seeks (seekToClip / seek) — this only sets the mode. */
  setLoopClip(index: number | null): void {
    this.loopClip = index
  }

  /** Current position on the mix timeline (0..duration). */
  getMixTime(): number {
    if (this.loadedIndex < 0) return 0
    const clip = this.clips[this.loadedIndex]
    if (!clip) return 0
    const into = Math.max(0, this.video.currentTime - clip.startSec)
    return (this.offsets[this.loadedIndex] ?? 0) + into
  }

  /** Load the right source for mix-time `t` and seek to it (does not start playing). */
  async seek(t: number): Promise<void> {
    const clamped = Math.max(0, Math.min(t, this.total))
    const loc = mapMixTime(this.clips, clamped)
    if (!loc) return
    // Only seek once the source is actually ready — otherwise the seek is discarded by the
    // media load and the clip plays from its source's start instead of the in-point.
    if (!(await this.ensureLoaded(loc.index))) return
    this.video.currentTime = loc.sourceSec
    this.emitTick()
  }

  /** Seek to the very start of clip `index`. */
  async seekToClip(index: number): Promise<void> {
    const clip = this.clips[index]
    if (!clip) return
    if (!(await this.ensureLoaded(index))) return
    this.video.currentTime = clip.startSec
    this.emitTick()
  }

  async play(): Promise<void> {
    if (this.loadedIndex < 0) {
      await this.seekToClip(this.loopClip ?? 0)
    }
    this.video.playbackRate = this.rate
    try {
      await this.video.play()
    } catch {
      /* autoplay can be blocked; the caller reflects state via onPlayingChange */
    }
    this.setPlaying(true)
    if (!this.rafId) this.rafId = requestAnimationFrame(this.frame)
  }

  pause(): void {
    this.video.pause()
    this.setPlaying(false)
    this.stopRaf()
  }

  toggle(): void {
    this.playing ? this.pause() : void this.play()
  }

  dispose(): void {
    this.pause()
    this.tickListeners.clear()
    this.playListeners.clear()
    try {
      this.video.removeAttribute('src')
      this.video.load()
    } catch {
      /* element may already be gone */
    }
  }

  // ---- internals ----

  private setPlaying(p: boolean): void {
    if (this.playing === p) return
    this.playing = p
    for (const fn of this.playListeners) fn(p)
  }

  private stopRaf(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  /** Point the <video> at clip `index`'s source and resolve TRUE once it's ready to seek.
   *  Returns FALSE if the clip's source can't be resolved (e.g. its dance was deleted), so
   *  callers stop instead of seeking a stale element. loadedIndex is committed only after
   *  the source is ready, and concurrent calls for the same clip share one load. */
  private async ensureLoaded(index: number): Promise<boolean> {
    if (index === this.loadedIndex) return true
    if (this.pendingLoad && this.pendingLoad.index === index) return this.pendingLoad.promise
    const clip = this.clips[index]
    if (!clip) return false
    const url = this.resolve(clip.sourceTrackId)
    if (!url) return false // missing source — leave loadedIndex where it is
    const promise = (async () => {
      if (this.video.getAttribute('src') !== url) {
        this.video.src = url
        // load() synchronously resets readyState to HAVE_NOTHING, so waitReady() actually
        // waits for THIS source's metadata rather than reading the previous source's stale
        // readyState and returning immediately.
        this.video.load()
        await this.waitReady()
      }
      this.loadedIndex = index
      return true
    })()
    this.pendingLoad = { index, promise }
    try {
      return await promise
    } finally {
      if (this.pendingLoad?.index === index) this.pendingLoad = null
    }
  }

  /** Resolve when the freshly-loaded source has metadata (so seeking works), with a timeout
   *  so a decode stall never hangs the whole controller. */
  private waitReady(): Promise<void> {
    if (this.video.readyState >= 1) return Promise.resolve()
    return new Promise((res) => {
      const done = () => {
        this.video.removeEventListener('loadedmetadata', done)
        window.clearTimeout(timer)
        res()
      }
      const timer = window.setTimeout(done, 4000)
      this.video.addEventListener('loadedmetadata', done)
    })
  }

  private frame = () => {
    if (!this.playing) return
    void this.advance()
    this.emitTick()
    this.rafId = requestAnimationFrame(this.frame)
  }

  /** Enforce clip out-points: loop the current clip, or roll onto the next one. */
  private async advance(): Promise<void> {
    if (this.swapping || this.video.seeking) return
    const clip = this.clips[this.loadedIndex]
    if (!clip) return
    // Reaching the source's real decoded end also counts as the clip end — the stored
    // duration used at cut time can be slightly short of the actual decode on another load,
    // which would otherwise leave currentTime below endSec forever and stall the medley.
    const atClipEnd =
      this.video.currentTime >= clip.endSec - END_EPS ||
      this.video.ended ||
      (this.video.duration > 0 && this.video.currentTime >= this.video.duration - END_EPS)

    if (this.loopClip !== null) {
      // Drilling one clip: snap back to its in-point at the out-point.
      if (atClipEnd) {
        this.swapping = true
        try {
          if (this.video.ended) await this.video.play().catch(() => {})
          this.video.currentTime = clip.startSec
        } finally {
          this.swapping = false
        }
      }
      return
    }

    if (!atClipEnd) return
    // Whole-mix play: roll onto the next clip that has a resolvable source, skipping any
    // whose dance was deleted; if none remain, stop at the end of the medley.
    this.swapping = true
    const wasPlaying = this.playing
    try {
      let next = this.loadedIndex + 1
      let loaded = false
      while (next < this.clips.length) {
        if (await this.ensureLoaded(next)) { loaded = true; break }
        next++
      }
      if (!loaded) {
        this.pause()
        this.video.currentTime = clip.endSec // park on the last playable frame
        this.emitTick()
        return
      }
      const nextClip = this.clips[next]!
      this.video.currentTime = nextClip.startSec
      this.video.playbackRate = this.rate
      if (wasPlaying) await this.video.play().catch(() => {})
    } finally {
      this.swapping = false
    }
  }

  private emitTick(): void {
    const t = this.getMixTime()
    for (const fn of this.tickListeners) fn(t)
  }

  /** The timeline span of a clip (for playheads/labels). */
  spanOf(index: number) {
    return clipSpan(this.clips, index)
  }
}
