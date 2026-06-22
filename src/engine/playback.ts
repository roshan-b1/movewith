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

export class PlaybackController {
  private video: HTMLVideoElement | null = null
  private mode: 'video' | 'virtual' = 'virtual'
  private virtualTime = 0
  private durationSec: number
  private rate = 1
  private playing = false
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
      // Let the native 'play'/'pause' events own the state. A rejected promise can be a
      // transient interrupt (e.g. a seek) OR a real autoplay block — only treat it as
      // paused if the element is actually still paused a tick later.
      const v = this.video
      const p = v.play()
      if (p && typeof p.catch === 'function') {
        p.catch(() => { if (v.paused) this.setPlayingState(false) })
      }
      return
    }
    if (this.playing) return
    this.setPlayingState(true)
    this.lastTs = 0
    this.rafId = requestAnimationFrame(this.frame)
  }

  pause() {
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
      if (!seeking && (t >= this.loop.endSec || t < this.loop.startSec)) this.seek(this.loop.startSec)
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
