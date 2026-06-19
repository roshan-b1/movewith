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

  constructor(durationSec: number) {
    this.durationSec = durationSec
  }

  /** Use a real video element as the time source. Pass null to go virtual (demo). */
  attachVideo(el: HTMLVideoElement | null) {
    this.video = el
    this.mode = el ? 'video' : 'virtual'
    if (el) {
      el.preservesPitch = true
      // Vendor-prefixed fallbacks for older engines.
      ;(el as unknown as { mozPreservesPitch?: boolean }).mozPreservesPitch = true
      ;(el as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
      el.playbackRate = this.rate
      this.durationSec = el.duration || this.durationSec
    }
  }

  onTick(fn: PlaybackTick): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
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

  setLoop(region: LoopRegion | null) {
    this.loop = region
    if (region) {
      const t = this.getTime()
      if (t < region.startSec || t >= region.endSec) this.seek(region.startSec)
    }
  }

  seek(t: number) {
    const clamped = Math.min(Math.max(0, t), this.durationSec)
    if (this.mode === 'video' && this.video) this.video.currentTime = clamped
    else this.virtualTime = clamped
    this.emit()
  }

  play() {
    if (this.playing) return
    this.playing = true
    this.lastTs = 0
    if (this.mode === 'video' && this.video) void this.video.play().catch(() => {})
    this.rafId = requestAnimationFrame(this.frame)
  }

  pause() {
    this.playing = false
    if (this.video) this.video.pause()
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
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

    // Section looping (both modes).
    if (this.loop) {
      const t = this.getTime()
      if (t >= this.loop.endSec || t < this.loop.startSec) this.seek(this.loop.startSec)
    } else if (this.getTime() >= this.durationSec) {
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
    this.listeners.clear()
    this.video = null
  }
}
