// Practice a saved mix (medley). Same feel as drilling a normal dance, but the parts come
// from different source videos: the MixPlayback engine swaps the underlying <video> as you
// move between parts. Drill one part on a loop (slowed / mirrored), or run the whole medley
// top to bottom. No camera or scoring here — a mix is a learning routine.

import { useEffect, useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'
import { MixPlaybackController } from '../../engine/mixPlayback'
import { mixDuration, type MixClip } from '../../core/mix/timeline'

const RATE_STEPS = [0.5, 0.75, 1]
const SOURCE_COLORS = ['#ff2e88', '#22d3ee', '#a3e635', '#ff9f1c', '#a855f7', '#f43f5e'] as const

const btn =
  'rounded-xl border border-line bg-ink/[0.06] px-3 py-2 text-sm font-medium text-ink/80 transition hover:text-ink active:scale-95'

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function MixPractice() {
  const mix = useSession((s) => s.activeMix)!
  const back = useSession((s) => s.back)
  const openMixEditor = useSession((s) => s.openMixEditor)

  const clips: MixClip[] = mix.clips
  const total = mixDuration(clips)
  const sourceOrder = [...new Set(clips.map((c) => c.sourceTrackId))]

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const ctrlRef = useRef<MixPlaybackController | null>(null)

  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [mirror, setMirror] = useState(false)
  const [part, setPart] = useState(0) // which clip is being drilled
  const [fullRun, setFullRun] = useState(false)
  const [done, setDone] = useState<number[]>([]) // parts marked "got it"
  const mirrorRef = useRef(false)
  const fullRunRef = useRef(false)
  const allGot = clips.length > 0 && done.length >= clips.length

  // Build the controller once. Sources were pre-loaded by openMix, so the resolver is sync.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const ctrl = new MixPlaybackController(v, clips, (id) => useSession.getState().sourceUrls[id] ?? null)
    ctrlRef.current = ctrl
    ctrl.onPlayingChange(setPlaying)
    ctrl.onTick((t) => {
      const head = headRef.current
      if (head) head.style.left = `${total > 0 ? Math.min(100, (t / total) * 100) : 0}%`
    })
    void ctrl.seekToClip(0).then(() => setReady(true))
    return () => { ctrl.dispose(); ctrlRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mix.id])

  // Mirror by drawing the flipped frame to a canvas (a CSS flip on the <video> tears on
  // some browsers). When mirror is off the plain <video> shows through.
  useEffect(() => {
    mirrorRef.current = mirror
    if (!mirror) return
    let raf = 0
    const draw = () => {
      const v = videoRef.current
      const c = canvasRef.current
      if (v && c && v.videoWidth) {
        const r = c.getBoundingClientRect()
        if (c.width !== Math.round(r.width)) c.width = Math.round(r.width)
        if (c.height !== Math.round(r.height)) c.height = Math.round(r.height)
        const ctx = c.getContext('2d')
        if (ctx) {
          const va = v.videoWidth / v.videoHeight
          const ba = c.width / c.height
          let dw = c.width, dh = c.height, ox = 0, oy = 0
          if (va > ba) { dh = c.width / va; oy = (c.height - dh) / 2 } else { dw = c.height * va; ox = (c.width - dw) / 2 }
          ctx.clearRect(0, 0, c.width, c.height)
          ctx.save()
          ctx.translate(c.width, 0)
          ctx.scale(-1, 1)
          try { ctx.drawImage(v, c.width - ox - dw, oy, dw, dh) } catch { /* not ready */ }
          ctx.restore()
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [mirror])

  function drillPart(i: number) {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    const idx = Math.max(0, Math.min(i, clips.length - 1))
    setPart(idx)
    setFullRun(false); fullRunRef.current = false
    ctrl.setLoopClip(idx)
    void ctrl.seekToClip(idx).then(() => ctrl.play())
  }

  function gotIt() {
    setDone((d) => (d.includes(part) ? d : [...d, part]))
    // Advance to the next part you haven't got yet, else stop (the completion nudge shows).
    let next = -1
    for (let k = 1; k <= clips.length; k++) {
      const j = (part + k) % clips.length
      if (!done.includes(j) && j !== part) { next = j; break }
    }
    if (next === -1) { ctrlRef.current?.pause(); return }
    drillPart(next)
  }

  function runWhole() {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    setFullRun(true); fullRunRef.current = true
    ctrl.setLoopClip(null)
    void ctrl.seek(0).then(() => ctrl.play())
  }

  function togglePlay() {
    ctrlRef.current?.toggle()
  }

  function changeRate(r: number) {
    setRate(r)
    ctrlRef.current?.setRate(r)
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-3 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <button onClick={back} className={btn + ' !py-2'}>‹ Exit</button>
        <div className="min-w-0 text-center">
          <h1 className="truncate font-display text-base font-semibold tracking-tightish">{mix.name}</h1>
          <p className="text-xs text-ink/45">{fullRun ? 'Full run-through' : `Part ${part + 1} of ${clips.length}`} · mix</p>
        </div>
        <button onClick={() => void openMixEditor(mix)} className={btn + ' !py-2'} title="Edit this mix">✎ Edit</button>
      </header>

      {/* Stage */}
      <section className="relative aspect-video overflow-hidden rounded-2.5xl border border-line bg-black/60 shadow-soft">
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-contain"
          style={{ opacity: mirror ? 0 : 1 }}
          playsInline
          muted={false}
        />
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ display: mirror ? 'block' : 'none' }} />
        <span className="absolute left-3 top-3 z-10 rounded-2xl bg-brand px-3 py-2 font-display text-sm font-bold text-cream shadow-glow">
          {fullRun ? 'Full run-through' : `Part ${part + 1} of ${clips.length}`}
        </span>
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-cream/25 border-t-cream" />
          </div>
        )}
      </section>

      {/* Parts timeline */}
      <div className="relative flex gap-1 overflow-x-auto rounded-xl border border-line bg-ink/[0.04] p-1.5">
        {clips.map((c, i) => {
          const color = SOURCE_COLORS[(sourceOrder.indexOf(c.sourceTrackId)) % SOURCE_COLORS.length]!
          const dur = c.endSec - c.startSec
          const width = total > 0 ? Math.max(56, Math.round((dur / total) * 520)) : 100
          const active = !fullRun && i === part
          return (
            <button
              key={c.id}
              onClick={() => drillPart(i)}
              className={`shrink-0 rounded-lg p-2 text-left transition ${active ? 'ring-2 ring-brand' : 'opacity-80 hover:opacity-100'}`}
              style={{ width, background: `${color}22`, border: `1px solid ${color}` }}
              title={`${c.sourceName} · ${fmt(dur)}`}
            >
              <span className="block truncate text-[11px] font-bold text-ink">
                {done.includes(i) ? '✓ ' : ''}{i + 1}. {c.sourceName}
              </span>
              <span className="text-[10px] tabular-nums text-ink/55">{fmt(dur)}</span>
            </button>
          )
        })}
        <div ref={headRef} className="pointer-events-none absolute inset-y-1 w-0.5 bg-ink" style={{ left: '0%' }} />
      </div>

      {/* Transport */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button onClick={togglePlay} className="rounded-xl bg-brand px-6 py-2.5 text-sm font-semibold text-cream shadow-glow transition hover:brightness-105 active:scale-95">
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <div className="flex items-center gap-1 rounded-xl border border-line bg-ink/[0.06] p-1">
          {RATE_STEPS.slice().reverse().map((r) => (
            <button key={r} onClick={() => changeRate(r)} className={`rounded-lg px-3 py-1.5 text-sm font-medium tabular-nums transition ${rate === r ? 'bg-brand text-cream' : 'text-ink/55 hover:text-ink'}`}>
              {r === 1 ? '1×' : `${r}×`}
            </button>
          ))}
        </div>
        <button onClick={() => setMirror((m) => !m)} className={mirror ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn}>🪞 Mirror</button>
        <button onClick={runWhole} className={fullRun ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn} title="Play the whole medley start to finish">▶ Full run-through</button>
      </div>

      {/* Drill controls */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button onClick={() => drillPart(part - 1)} disabled={part === 0} className={btn + ' !px-3 disabled:opacity-40'}>‹ prev</button>
        <button onClick={() => drillPart(part)} className={btn}>↻ Repeat part</button>
        <button onClick={gotIt} className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95">✓ Got it</button>
        <button onClick={() => drillPart(part + 1)} disabled={part >= clips.length - 1} className={btn + ' !px-3 disabled:opacity-40'}>next ›</button>
      </div>

      {/* Got every part → put the medley together, same as finishing a normal dance. */}
      {allGot && !fullRun && (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-brand2/40 bg-brand2/[0.08] px-4 py-3 text-center">
          <p className="text-sm font-semibold text-ink">You've got every part 🎉</p>
          <p className="text-xs text-ink/55">Now run the whole medley top to bottom.</p>
          <button onClick={runWhole} className="rounded-xl bg-brand2 px-5 py-2.5 text-sm font-bold text-[#06222a] shadow-soft transition hover:brightness-105 active:scale-95">
            ▶ Full run-through
          </button>
        </div>
      )}

      <div className="flex min-h-[24px] items-center justify-center text-sm">
        <span className="text-ink/40">
          {fullRun ? 'Playing the whole medley.' : 'Drill this part on a loop, then ✓ Got it for the next one.'}
        </span>
      </div>
    </div>
  )
}
