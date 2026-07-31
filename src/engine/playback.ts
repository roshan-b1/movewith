// Drives the instructor timeline. Two backends behind one API:
//  - 'video': a real <video> element (slow-mo via playbackRate + preservesPitch).
//  - 'virtual': a clock for the synthetic demo (no video) that advances by rAF.
// Section looping, mirror, and rate live here so the UI and practice engine never
// touch the audio/video backend directly — that's the swap point for Signalsmith later.

export interface LoopRegion {
  startSec: number
  endSec: number
}

export type PlaybackTick = (timeSec: number) => void

// A small margin so a sub-range loop whose out-point sits at (or just past) the file's real
// decoded duration still wraps. The stored duration can read a hair longer than the actual
// decode, which would otherwise leave the last segment's out-point unreachable: the file
// 'ends' before the loop-back seek can fire, and the segment freezes on the final frame.
const END_EPS = 0.06

// How far BEFORE a loop's in-point the playhead must be to count as "outside the loop" and get
// snapped back. Seeking to an in-point can undershoot by a few ms on a real video (the decoder
// lands on the nearest frame, not the exact time). Without this tolerance a bare `t < startSec`
// re-seeks to the start every frame and never advances — the segment freezes on its first
// frame, especially at slow speed where the clock lingers just under the boundary.
const SEEK_TOL = 0.2

export class PlaybackController {
  private video: HTMLVideoElement | null = null
  private mode: 'video' | 'virtual' = 'virtual'
  private virtualTime = 0
  private durationSec: number
  private rate = 1
  private playing = false
  /** Whether we WANT the video playing right now. Lets a rejected play() retry itself without
   *  fighting a deliberate pause (a break between loops), and drives the stall watchdog. */
  private wantPlay = false
  private loop: LoopRegion | null = null
  private _mirror = false
  private rafId = 0
  private lastTs = 0
  private listeners = new Set<PlaybackTick>()
  private playStateListeners = new Set<(playing: boolean) => void>()
  private skipRanges: Array<[number, number]> = []

  constructor(durationSec: number) {
    this.durationSec = durationSec
  }

  // The <video> element drives its own playing/paused state via these events, so the UI
  // can never get stuck (e.g. button showing "Pause" while the video sits still). The rAF
  // tick loop is started/stopped to match.
  private onVideoPlay = () => {
    this.setPlayingState(true)
    if (!this.rafId) { this.lastTs = 0; this.rafId = requestAnimationFrame(this.frame) }
  }
  private onVideoPause = () => {
    this.setPlayingState(false)
    this.stopRaf()
  }
  private onVideoEnded = () => {
    // Looping a sub-range whose out-point is at/after the file's real duration: the file can
    // 'end' before the frame loop seeks back. Treat it as the loop wrap — jump to the loop
    // start and let the tick fire (the practice screen's onTick sees the jump-back and runs
    // its usual break/repeat, then resumes play). Without this the segment freezes on the end.
    if (this.loop && !this.nativeLooping) {
      this.seek(this.loop.startSec)
      this.emit()
      return
    }
    if (!this.loop) { this.setPlayingState(false); this.stopRaf(); this.emit() }
  }

  /** Use a real video element as the time source. Pass null to go virtual (demo). */
  attachVideo(el: HTMLVideoElement | null) {
    if (this.video) {
      this.video.removeEventListener('play', this.onVideoPlay)
      this.video.removeEventListener('playing', this.onVideoPlay)
      this.video.removeEventListener('pause', this.onVideoPause)
      this.video.removeEventListener('ended', this.onVideoEnded)
    }
    this.video = el
    this.mode = el ? 'video' : 'virtual'
    if (el) {
      el.preservesPitch = true
      // Vendor-prefixed fallbacks for older engines.
      ;(el as unknown as { mozPreservesPitch?: boolean }).mozPreservesPitch = true
      ;(el as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
      el.playbackRate = this.rate
      this.durationSec = el.duration || this.durationSec
      el.addEventListener('play', this.onVideoPlay)
      el.addEventListener('playing', this.onVideoPlay)
      el.addEventListener('pause', this.onVideoPause)
      el.addEventListener('ended', this.onVideoEnded)
      // Reconcile in case it's already playing/paused when attached.
      this.setPlayingState(!el.paused)
    }
  }

  private stopRaf() {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  onTick(fn: PlaybackTick): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Fires whenever playback actually starts or stops — including when the browser
   *  blocks autoplay, so the UI's play/pause button always reflects reality. */
  onPlayingChange(fn: (playing: boolean) => void): () => void {
    this.playStateListeners.add(fn)
    return () => this.playStateListeners.delete(fn)
  }

  private setPlayingState(p: boolean) {
    if (this.playing === p) return
    this.playing = p
    for (const fn of this.playStateListeners) fn(p)
  }

  get duration() {
    return this.durationSec
  }
  get isPlaying() {
    return this.playing
  }
  get playbackRate() {
    return this.rate
  }
  get mirror() {
    return this._mirror
  }

  getTime(): number {
    return this.mode === 'video' && this.video ? this.video.currentTime : this.virtualTime
  }

  setMirror(on: boolean) {
    this._mirror = on
  }

  setRate(rate: number) {
    this.rate = rate
    if (this.video) this.video.playbackRate = rate
  }

  /** Time ranges to jump over during continuous playback (skipped/cut segments). */
  setSkipRanges(ranges: Array<[number, number]>) {
    this.skipRanges = ranges
  }

  setLoop(region: LoopRegion | null) {
    this.loop = region
    // If the loop covers (basically) the whole video, let the browser loop it natively —
    // that's seamless, no seek-back decode stall. Sub-range loops still JS-seek at the edge.
    if (this.video) {
      this.video.loop = !!(region && region.startSec <= 0.15 && region.endSec >= this.durationSec - 0.15)
    }
    if (region) {
      const t = this.getTime()
      if (t < region.startSec || t >= region.endSec) this.seek(region.startSec)
    }
  }

  /** True when the browser is handling the loop natively (whole-video loop). */
  private get nativeLooping() {
    return this.mode === 'video' && this.video ? this.video.loop : false
  }

  seek(t: number) {
    const clamped = Math.min(Math.max(0, t), this.durationSec)
    if (this.mode === 'video' && this.video) this.video.currentTime = clamped
    else this.virtualTime = clamped
    this.emit()
  }

  play() {
    if (this.mode === 'video' && this.video) {
      this.wantPlay = true
      const v = this.video
      // A play() issued right after a seek (segment switch, loop wrap, break resume) is often
      // rejected by the browser as "interrupted by a seek/new load" — on real videos with sparse
      // keyframes the seek is still settling. That used to leave the segment frozen while the UI
      // showed "playing". Retry when the element can next play (and after a short fallback), but
      // only while we still want to play — so a deliberate pause (a break) is never overridden.
      const attempt = () => { if (this.wantPlay && v.paused) v.play().catch(() => {}) }
      const p = v.play()
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (!(this.wantPlay && v.paused)) return
          v.addEventListener('seeked', attempt, { once: true })
          v.addEventListener('canplay', attempt, { once: true })
          window.setTimeout(attempt, 300)
        })
      }
      return
    }
    if (this.playing) return
    this.setPlayingState(true)
    this.lastTs = 0
    this.rafId = requestAnimationFrame(this.frame)
  }

  pause() {
    this.wantPlay = false
    if (this.mode === 'video' && this.video) {
      this.video.pause() // 'pause' event flips state + stops the rAF loop
      return
    }
    this.setPlayingState(false)
    this.stopRaf()
  }

  toggle() {
    this.playing ? this.pause() : this.play()
  }

  private frame = (ts: number) => {
    if (!this.playing) return

    // Stall watchdog: we intend to play and the element isn't mid-seek, yet it sits paused —
    // nudge it back to life so a segment never stays frozen. wantPlay is cleared synchronously
    // by pause(), so this never overrides a deliberate break-pause.
    if (this.mode === 'video' && this.video && this.wantPlay && this.video.paused && !this.video.seeking) {
      void this.video.play().catch(() => {})
    }

    if (this.mode === 'virtual') {
      if (this.lastTs === 0) this.lastTs = ts
      const dt = (ts - this.lastTs) / 1000
      this.lastTs = ts
      this.virtualTime += dt * this.rate
      if (this.virtualTime >= this.durationSec) this.virtualTime = this.loop ? this.virtualTime : this.durationSec
    }

    // Section looping (both modes). For a real video the seek-back is async, so skip the
    // check while a seek is already in flight — otherwise getTime() still reads past the
    // end for a few frames and we stack seeks until the video stalls (frozen but not
    // 'paused', which left the play button stuck).
    const seeking = this.mode === 'video' && this.video ? this.video.seeking : false
    // Jump over skipped/cut ranges (only matters during continuous full-song playback;
    // single-segment loops never sit inside a cut range).
    if (!seeking && this.skipRanges.length) {
      const t = this.getTime()
      for (const [s, e] of this.skipRanges) {
        if (t >= s && t < e - 0.05) { this.seek(e); break }
      }
    }
    if (this.loop && !this.nativeLooping) {
      const t = this.getTime()
      const v = this.mode === 'video' ? this.video : null
      // Wrap at the out-point, or at the file's real end (ended / within END_EPS of the real
      // decoded duration) when the out-point sits at/beyond it — so the last segment loops
      // instead of freezing on the final frame.
      const hitEnd =
        t >= this.loop.endSec || (v !== null && (v.ended || (v.duration > 0 && t >= v.duration - END_EPS)))
      // Only snap back when MEANINGFULLY before the in-point (SEEK_TOL), so a few-ms seek
      // undershoot doesn't re-seek every frame and freeze the segment on its first frame.
      if (!seeking && (hitEnd || t < this.loop.startSec - SEEK_TOL)) this.seek(this.loop.startSec)
    } else if (!this.loop && !seeking && this.getTime() >= this.durationSec) {
      this.pause()
      this.seek(this.durationSec)
      this.emit()
      return
    }

    this.emit()
    this.rafId = requestAnimationFrame(this.frame)
  }

  private emit() {
    const t = this.getTime()
    for (const fn of this.listeners) fn(t)
  }

  dispose() {
    this.pause()
    this.stopRaf()
    this.attachVideo(null) // detaches the video event listeners
    this.listeners.clear()
    this.playStateListeners.clear()
  }
}
