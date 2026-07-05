// Synthesized backing music for GENERATED routines (the bundled demo). Bundled
// recordings are a licensing problem, so instead a small WebAudio drum-and-bass groove
// is scheduled live against the PlaybackController's clock: latin percussion (kick,
// clap, shaker, woodblock) plus a two-chord bass vamp, at the routine's BPM. Follows
// play/pause/seek/rate exactly — it reads the controller's time every tick and schedules
// a short lookahead window, so section loops and slow-mo stay on the beat.

import type { PlaybackController } from './playback'

const LOOKAHEAD_SEC = 0.3

export class BeatMusic {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private live: OscillatorNode[] = []
  private liveSrc: AudioBufferSourceNode[] = []
  /** Next eighth-note index (in routine time) to schedule; -1 forces a resync. */
  private nextEighth = -1
  private enabled = true
  private unsubs: Array<() => void> = []

  constructor(
    private pb: PlaybackController,
    private bpm: number,
    private firstBeatSec = 0,
  ) {
    this.unsubs.push(pb.onTick(this.onTick))
    this.unsubs.push(
      pb.onPlayingChange((playing) => {
        if (!playing) this.flush()
      }),
    )
  }

  setEnabled(on: boolean) {
    this.enabled = on
    if (!on) this.flush()
  }

  dispose() {
    this.flush()
    for (const u of this.unsubs) u()
    this.unsubs = []
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }

  /** Stop everything scheduled and force a fresh sync on the next tick. */
  private flush() {
    for (const s of this.live) {
      try { s.stop() } catch { /* already stopped */ }
    }
    for (const s of this.liveSrc) {
      try { s.stop() } catch { /* already stopped */ }
    }
    this.live = []
    this.liveSrc = []
    this.nextEighth = -1
  }

  private ensureCtx(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
        this.master = this.ctx.createGain()
        this.master.gain.value = 0.55
        this.master.connect(this.ctx.destination)
        // One shared noise buffer for clap/shaker.
        const len = Math.floor(this.ctx.sampleRate * 0.3)
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
        const data = this.noiseBuf.getChannelData(0)
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
      } catch {
        return null
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
    return this.ctx
  }

  private onTick = (t: number) => {
    if (!this.enabled || !this.pb.isPlaying) return
    const ctx = this.ensureCtx()
    if (!ctx || !this.master) return

    const rate = this.pb.playbackRate || 1
    const eighthSec = 30 / this.bpm // routine-time length of an eighth note
    const cur = Math.floor((t - this.firstBeatSec) / eighthSec)
    // (Re)sync after seeks, loops, or a pause: jump the pointer next to the playhead.
    if (this.nextEighth < cur || this.nextEighth > cur + 8) this.nextEighth = cur + 1

    // Schedule every eighth note that falls inside the lookahead window.
    while (true) {
      const eighthTime = this.firstBeatSec + this.nextEighth * eighthSec
      const delay = (eighthTime - t) / rate
      if (delay > LOOKAHEAD_SEC) break
      if (delay >= -0.02 && this.nextEighth >= 0) this.playEighth(ctx, ctx.currentTime + Math.max(0, delay), this.nextEighth)
      this.nextEighth++
    }
  }

  /** Fire the instruments for eighth-note `e` at absolute AudioContext time `at`. */
  private playEighth(ctx: AudioContext, at: number, e: number) {
    const inBar = e % 8 // 4/4 bar = 8 eighths
    const bar = Math.floor(e / 8)
    if (inBar === 0 || inBar === 4) this.kick(ctx, at)
    if (inBar === 2 || inBar === 6) this.clap(ctx, at)
    this.shaker(ctx, at, inBar % 2 === 0 ? 0.12 : 0.07)
    if (inBar === 3 || inBar === 7) this.block(ctx, at, inBar === 3 ? 2100 : 1650)
    // Two-bar bass vamp: A — D (i–IV feel), root on the 1, fifth on the 3.
    const root = bar % 2 === 0 ? 110 : 146.83
    if (inBar === 0) this.bass(ctx, at, root, 0.5)
    if (inBar === 4) this.bass(ctx, at, root * 1.5, 0.35)
  }

  private env(ctx: AudioContext, at: number, peak: number, decay: number): GainNode {
    const g = ctx.createGain()
    g.gain.setValueAtTime(peak, at)
    g.gain.exponentialRampToValueAtTime(0.001, at + decay)
    g.connect(this.master!)
    return g
  }

  private kick(ctx: AudioContext, at: number) {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(150, at)
    o.frequency.exponentialRampToValueAtTime(45, at + 0.1)
    o.connect(this.env(ctx, at, 0.9, 0.14))
    o.start(at)
    o.stop(at + 0.16)
    this.live.push(o)
  }

  private clap(ctx: AudioContext, at: number) {
    if (!this.noiseBuf) return
    const s = ctx.createBufferSource()
    s.buffer = this.noiseBuf
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = 1800
    f.Q.value = 1.2
    s.connect(f)
    f.connect(this.env(ctx, at, 0.5, 0.1))
    s.start(at)
    s.stop(at + 0.12)
    this.liveSrc.push(s)
  }

  private shaker(ctx: AudioContext, at: number, level: number) {
    if (!this.noiseBuf) return
    const s = ctx.createBufferSource()
    s.buffer = this.noiseBuf
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = 6500
    s.connect(f)
    f.connect(this.env(ctx, at, level, 0.05))
    s.start(at)
    s.stop(at + 0.06)
    this.liveSrc.push(s)
  }

  private block(ctx: AudioContext, at: number, freq: number) {
    const o = ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = freq
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = freq
    f.Q.value = 6
    o.connect(f)
    f.connect(this.env(ctx, at, 0.25, 0.07))
    o.start(at)
    o.stop(at + 0.08)
    this.live.push(o)
  }

  private bass(ctx: AudioContext, at: number, freq: number, dur: number) {
    const o = ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(0.32, at + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, at + dur)
    o.connect(g)
    g.connect(this.master!)
    o.start(at)
    o.stop(at + dur + 0.05)
    this.live.push(o)
  }
}
