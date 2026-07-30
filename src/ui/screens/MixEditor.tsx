// The mix editor: stitch parts of several dances into one medley, DaVinci-style.
//
//   pick a dance  →  scrub + set an in/out on it  →  drop that part onto the mix track
//   → repeat with any dance, in any order  →  preview the whole thing  →  save.
//
// The mix track is always on screen so you watch it fill up. You cut a part on the source
// (in/out on the scrubber); that cut shows up as a block you grab and drag straight down
// into the mix — the cut block and the mix blocks are the SAME object, so it reads as one
// continuous "cut → drop" gesture. Reorder by dragging blocks (or ‹ › nudges), preview with
// the source-swapping MixPlayback engine. No camera/scoring here — a mix is a practice routine.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'
import { Scrubber } from '../components/Scrubber'
import { MixPlaybackController } from '../../engine/mixPlayback'
import {
  MIX_VERSION,
  mixDuration,
  insertClip,
  removeClip,
  moveClip,
  type Mix,
  type MixClip,
} from '../../core/mix/timeline'

// Color-code blocks by their source dance so the medley's structure reads at a glance.
const SOURCE_COLORS = ['#ff2e88', '#22d3ee', '#a3e635', '#ff9f1c', '#a855f7', '#f43f5e'] as const
function colorFor(trackId: string, order: string[]): string {
  const i = order.indexOf(trackId)
  return SOURCE_COLORS[(i < 0 ? 0 : i) % SOURCE_COLORS.length]!
}

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const btn =
  'rounded-xl border border-line bg-ink/[0.06] px-3 py-2 text-sm font-medium text-ink/80 transition hover:text-ink active:scale-95'

// Fixed time scale for the mix track: every second of a part is this many pixels wide, so a
// block's width IS its duration (DaVinci-style) and edge-trimming maps px→seconds linearly.
const PPS = 7

// One shared look for a "part" block, used for the cut and for every block in the mix so they
// read as the same object. `partStyle` tints it by its source dance's color.
const partCls = 'relative flex shrink-0 select-none flex-col justify-between overflow-hidden rounded-lg text-left'
function partStyle(color: string): { background: string; border: string } {
  return { background: `${color}22`, border: `1px solid ${color}` }
}

interface DragState {
  kind: 'add' | 'reorder'
  clipId?: string
  x: number
  y: number
  label: string
  color: string
}

/** An in-progress edge-trim of a block already in the mix (drag its left/right end). */
interface TrimState {
  clipId: string
  edge: 'start' | 'end'
  startX: number
  origStart: number
  origEnd: number
  sourceDur: number
}

export function MixEditor() {
  const tracks = useSession((s) => s.tracks)
  const activeMix = useSession((s) => s.activeMix)
  const ensureSourceUrl = useSession((s) => s.ensureSourceUrl)
  const saveMix = useSession((s) => s.saveMix)
  const openMix = useSession((s) => s.openMix)
  const back = useSession((s) => s.back)

  // Only dances with a stored video can be sliced into a mix.
  const sources = useMemo(() => tracks.filter((t) => t.videoBlobKey), [tracks])

  const [clips, setClips] = useState<MixClip[]>(activeMix?.clips ?? [])
  const [name, setName] = useState(activeMix?.name ?? 'My mix')

  // ---- source being cut ----
  const [sourceId, setSourceId] = useState<string | null>(sources[0]?.id ?? null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [sourceTime, setSourceTime] = useState(0)
  const [selStart, setSelStart] = useState(0)
  const [selEnd, setSelEnd] = useState(0)
  const [sourcePlaying, setSourcePlaying] = useState(false)
  const sourceVideoRef = useRef<HTMLVideoElement>(null)
  const sourceTrack = sources.find((t) => t.id === sourceId) ?? null
  const sourceDur = sourceTrack?.source.durationSec ?? 0

  // ---- preview of the assembled mix ----
  const previewVideoRef = useRef<HTMLVideoElement>(null)
  const previewCtrlRef = useRef<MixPlaybackController | null>(null)
  const previewHeadRef = useRef<HTMLDivElement>(null)
  const [previewing, setPreviewing] = useState(false)

  // ---- drag and drop ----
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [trim, setTrim] = useState<TrimState | null>(null)
  const trackRowRef = useRef<HTMLDivElement>(null)

  const total = mixDuration(clips)
  const sourceOrder = useMemo(() => [...new Set(clips.map((c) => c.sourceTrackId))], [clips])
  // Each uploaded dance keeps ONE color everywhere (cut block + mix blocks), keyed off a stable
  // order of all sources so it never shifts as the mix changes.
  const colorOrder = useMemo(() => sources.map((t) => t.id), [sources])
  const sourceDurById = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of sources) m.set(t.id, t.source.durationSec)
    return m
  }, [sources])
  const cutColor = sourceTrack ? colorFor(sourceTrack.id, colorOrder) : SOURCE_COLORS[0]!

  // Load the picked source's video URL and reset the selection to the whole clip.
  useEffect(() => {
    if (!sourceId) { setSourceUrl(null); return }
    let cancelled = false
    void ensureSourceUrl(sourceId).then((url) => {
      if (cancelled) return
      setSourceUrl(url)
      const d = sources.find((t) => t.id === sourceId)?.source.durationSec ?? 0
      setSelStart(0)
      setSelEnd(d)
      setSourceTime(0)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId])

  // Keep the source playhead moving while it plays (imperative-free: editor can re-render).
  useEffect(() => {
    if (!sourcePlaying) return
    let raf = 0
    const tick = () => {
      const v = sourceVideoRef.current
      if (v) {
        setSourceTime(v.currentTime)
        // Preview-loop the selection so you hear/see exactly the part you're cutting.
        if (v.currentTime >= selEnd - 0.05 || v.currentTime < selStart - 0.05) {
          v.currentTime = selStart
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [sourcePlaying, selStart, selEnd])

  function toggleSourcePlay() {
    const v = sourceVideoRef.current
    if (!v) return
    if (v.paused) {
      if (v.currentTime < selStart || v.currentTime >= selEnd) v.currentTime = selStart
      void v.play().then(() => setSourcePlaying(true)).catch(() => {})
    } else {
      v.pause()
      setSourcePlaying(false)
    }
  }

  function seekSource(t: number) {
    const v = sourceVideoRef.current
    if (v) v.currentTime = t
    setSourceTime(t)
  }

  function makeSelectionClip(): MixClip | null {
    if (!sourceTrack) return null
    const s = Math.max(0, Math.min(selStart, selEnd))
    const e = Math.max(selStart, selEnd)
    if (e - s < 0.3) return null // too short to be a real part
    return {
      id: (crypto.randomUUID?.() ?? `clip-${Date.now()}-${Math.round(Math.random() * 1e6)}`),
      sourceTrackId: sourceTrack.id,
      sourceName: sourceTrack.name,
      startSec: s,
      endSec: e,
    }
  }

  function addSelectionToEnd() {
    const clip = makeSelectionClip()
    if (clip) setClips((cs) => [...cs, clip])
  }

  // ---- drag/drop plumbing (pointer-based → works on touch and mouse) ----

  function computeDropIndex(clientX: number): number {
    const row = trackRowRef.current
    if (!row) return clips.length
    const blocks = [...row.querySelectorAll<HTMLElement>('[data-clip-index]')]
    for (const b of blocks) {
      const r = b.getBoundingClientRect()
      if (clientX < r.left + r.width / 2) return Number(b.dataset.clipIndex)
    }
    return clips.length
  }

  function pointerOverTrack(clientX: number, clientY: number): boolean {
    const row = trackRowRef.current
    if (!row) return false
    const r = row.getBoundingClientRect()
    const pad = 48 // generous drop zone so you don't have to be pixel-perfect
    return clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top - pad && clientY <= r.bottom + pad
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d))
      setDropIndex(pointerOverTrack(e.clientX, e.clientY) ? computeDropIndex(e.clientX) : null)
    }
    const up = (e: PointerEvent) => {
      const over = pointerOverTrack(e.clientX, e.clientY)
      const idx = over ? computeDropIndex(e.clientX) : null
      if (over && idx !== null) {
        if (drag.kind === 'add') {
          const clip = makeSelectionClip()
          if (clip) setClips((cs) => insertClip(cs, clip, idx))
        } else if (drag.kind === 'reorder' && drag.clipId) {
          setClips((cs) => {
            const from = cs.findIndex((c) => c.id === drag.clipId)
            if (from < 0) return cs
            const to = idx > from ? idx - 1 : idx
            return moveClip(cs, from, to)
          })
        }
      }
      setDrag(null)
      setDropIndex(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, clips, selStart, selEnd, sourceId])

  function startAddDrag(e: React.PointerEvent) {
    const clip = makeSelectionClip()
    if (!clip) return
    setDrag({ kind: 'add', x: e.clientX, y: e.clientY, label: `${sourceTrack?.name ?? 'Part'} · ${fmt(selEnd - selStart)}`, color: cutColor })
  }
  function startReorderDrag(e: React.PointerEvent, c: MixClip) {
    setDrag({ kind: 'reorder', clipId: c.id, x: e.clientX, y: e.clientY, label: `${c.sourceName} · ${fmt(c.endSec - c.startSec)}`, color: colorFor(c.sourceTrackId, colorOrder) })
  }

  // ---- edge-trim a block already in the mix (drag its ends, DaVinci-style) ----
  function startTrim(e: React.PointerEvent, c: MixClip, edge: 'start' | 'end') {
    e.stopPropagation() // don't let the block's reorder-drag also fire
    setTrim({
      clipId: c.id,
      edge,
      startX: e.clientX,
      origStart: c.startSec,
      origEnd: c.endSec,
      sourceDur: sourceDurById.get(c.sourceTrackId) ?? c.endSec,
    })
  }

  useEffect(() => {
    if (!trim) return
    const MIN = 0.3 // a part can't be trimmed shorter than this
    const move = (e: PointerEvent) => {
      const deltaSec = (e.clientX - trim.startX) / PPS
      setClips((cs) =>
        cs.map((c) => {
          if (c.id !== trim.clipId) return c
          if (trim.edge === 'start') {
            return { ...c, startSec: Math.max(0, Math.min(trim.origStart + deltaSec, trim.origEnd - MIN)) }
          }
          return { ...c, endSec: Math.min(trim.sourceDur, Math.max(trim.origEnd + deltaSec, trim.origStart + MIN)) }
        }),
      )
    }
    const up = () => setTrim(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [trim])

  function deleteClip(id: string) {
    setClips((cs) => removeClip(cs, id))
  }
  function nudge(id: string, dir: -1 | 1) {
    setClips((cs) => {
      const from = cs.findIndex((c) => c.id === id)
      if (from < 0) return cs
      return moveClip(cs, from, from + dir)
    })
  }

  // ---- preview (plays the whole mix across sources) ----
  async function startPreview() {
    if (clips.length === 0) return
    // Make sure every source's URL is loaded before the engine asks for it.
    for (const id of sourceOrder) await ensureSourceUrl(id)
    const v = previewVideoRef.current
    if (!v) return
    const ctrl = new MixPlaybackController(v, clips, (id) => useSession.getState().sourceUrls[id] ?? null)
    previewCtrlRef.current = ctrl
    ctrl.onTick((t) => {
      const head = previewHeadRef.current
      // Same fixed scale as the blocks (+8px for the track's padding) so the head tracks them.
      if (head) head.style.left = `${8 + t * PPS}px`
    })
    // When the medley reaches its end (or otherwise stops), tear the controller down too,
    // not just the visible flag, so it doesn't linger holding a detached <video>.
    ctrl.onPlayingChange((p) => {
      if (!p) { previewCtrlRef.current?.dispose(); previewCtrlRef.current = null; setPreviewing(false) }
    })
    setPreviewing(true)
    await ctrl.seek(0)
    await ctrl.play()
  }
  function stopPreview() {
    previewCtrlRef.current?.dispose()
    previewCtrlRef.current = null
    setPreviewing(false)
  }
  useEffect(() => () => previewCtrlRef.current?.dispose(), [])

  async function save() {
    if (clips.length === 0) return
    const mix: Mix = {
      version: MIX_VERSION,
      id: activeMix?.id ?? (crypto.randomUUID?.() ?? `mix-${Date.now()}`),
      name: name.trim() || 'My mix',
      createdAt: activeMix?.createdAt ?? Date.now(),
      clips,
    }
    await saveMix(mix)
    await openMix(mix.id) // straight into practicing the medley
  }

  if (sources.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center">
        <button onClick={back} className={btn + ' mb-8 !px-4'}>‹ Back</button>
        <p className="font-display text-xl font-bold">Upload a dance or two first</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink/55">
          A mix is stitched from parts of dances you've uploaded. Add at least one, then come
          back and cut it up.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <button onClick={back} className={btn + ' !py-2'}>‹ Exit</button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 max-w-xs rounded-xl border border-line bg-ink/[0.06] px-3 py-1.5 text-center font-display text-base font-bold text-ink outline-none focus:border-brand"
        />
        <button
          onClick={save}
          disabled={clips.length === 0}
          className="rounded-xl bg-brand px-5 py-2 text-sm font-bold text-cream shadow-glow transition hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save mix
        </button>
      </header>

      {/* SOURCE: pick a dance, scrub, set the in/out, then drop it onto the mix. */}
      <section className="rounded-2.5xl border border-line bg-panel/70 p-4 shadow-soft">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink/45">Pick a dance to cut from</p>
        <div className="mb-3 flex flex-wrap gap-2">
          {sources.map((t) => (
            <button
              key={t.id}
              onClick={() => { stopPreview(); setSourceId(t.id) }}
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-semibold transition active:scale-95 ${sourceId === t.id ? 'border-brand bg-brand/15 text-ink' : 'border-line text-ink/70 hover:text-ink'}`}
            >
              💃 {t.name}
            </button>
          ))}
        </div>

        <div className="relative aspect-video overflow-hidden rounded-xl border border-line bg-black">
          {sourceUrl ? (
            <video ref={sourceVideoRef} src={sourceUrl} className="h-full w-full object-contain" playsInline muted preload="auto" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-ink/40">Loading…</div>
          )}
        </div>

        <div className="mt-3">
          <Scrubber
            duration={sourceDur}
            currentTime={sourceTime}
            rangeStart={selStart}
            rangeEnd={selEnd}
            sections={[]}
            onSeek={seekSource}
            onRangeChange={(s, e) => { setSelStart(s); setSelEnd(e) }}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <button onClick={toggleSourcePlay} className={btn + ' mb-1'}>{sourcePlaying ? '⏸ Pause' : '▶ Play part'}</button>
          <div className="min-w-0">
            <p className="mb-1.5 text-xs font-medium text-ink/45">Your cut · grab it and drag down into the mix</p>
            {sourceTrack && selEnd - selStart >= 0.3 ? (
              <div
                onPointerDown={startAddDrag}
                className={partCls + ' w-44 cursor-grab touch-none p-2 shadow-soft transition hover:brightness-110 active:scale-95'}
                style={partStyle(cutColor)}
                title="Drag me down into the mix"
              >
                <div className="truncate text-[11px] font-bold leading-tight text-ink">{sourceTrack.name}</div>
                <div className="text-[10px] tabular-nums text-ink/55">{fmt(selEnd - selStart)}</div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-[10px] font-medium text-ink/45">⇩ drag to mix</span>
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={addSelectionToEnd}
                    className="rounded px-1.5 text-sm leading-none text-ink/50 transition hover:text-ink"
                    title="Add to the end of the mix"
                  >
                    ＋
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex w-44 items-center justify-center rounded-lg border border-dashed border-line/60 p-3 text-center text-[11px] text-ink/40">
                Trim a part above first
              </div>
            )}
          </div>
        </div>
      </section>

      {/* MIX TRACK: always visible, fills up as you add parts. */}
      <section className="rounded-2.5xl border border-brand/30 bg-brand/[0.06] p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-ink/45">
            Your mix · {clips.length} {clips.length === 1 ? 'part' : 'parts'} · {fmt(total)}
          </p>
          <div className="flex gap-2">
            {previewing ? (
              <button onClick={stopPreview} className={btn}>■ Stop</button>
            ) : (
              <button onClick={startPreview} disabled={clips.length === 0} className={btn + ' disabled:opacity-40'}>▶ Preview</button>
            )}
          </div>
        </div>

        {/* Preview stage. The <video> is always mounted (just hidden when idle) so its ref
            exists the instant Preview is tapped — otherwise startPreview finds null and bails. */}
        <div className={previewing ? 'mb-3 aspect-video overflow-hidden rounded-xl border border-line bg-black' : 'hidden'}>
          <video ref={previewVideoRef} className="h-full w-full object-contain" playsInline muted />
        </div>

        <div
          ref={trackRowRef}
          className={`relative flex min-h-[92px] items-stretch gap-1 overflow-x-auto rounded-xl border-2 border-dashed p-2 transition ${dropIndex !== null ? 'border-brand bg-brand/10' : 'border-line/60'}`}
        >
          {clips.length === 0 && (
            <div className="flex w-full items-center justify-center text-sm text-ink/40">
              Drag your cut here to build the mix
            </div>
          )}
          {clips.map((c, i) => {
            const color = colorFor(c.sourceTrackId, colorOrder)
            const dur = c.endSec - c.startSec
            const width = Math.max(72, Math.round(dur * PPS))
            const trimming = trim?.clipId === c.id
            return (
              <div key={c.id} className="flex items-stretch">
                {dropIndex === i && <div className="mx-0.5 w-1 rounded bg-brand" />}
                <div
                  data-clip-index={i}
                  onPointerDown={(e) => startReorderDrag(e, c)}
                  className={partCls + ` group cursor-grab touch-none py-2 ${trimming ? 'ring-2 ring-ink/40' : ''}`}
                  style={{ width, ...partStyle(color) }}
                  title="Drag the middle to reorder · drag an end to trim"
                >
                  {/* Trim grips — drag an end to change this part's in/out (DaVinci-style). */}
                  <div
                    onPointerDown={(e) => startTrim(e, c, 'start')}
                    className="absolute inset-y-0 left-0 z-10 w-2.5 cursor-ew-resize touch-none transition hover:bg-white/10"
                    title="Trim the start"
                  >
                    <div className="absolute inset-y-1.5 left-1 w-0.5 rounded bg-ink/45" />
                  </div>
                  <div
                    onPointerDown={(e) => startTrim(e, c, 'end')}
                    className="absolute inset-y-0 right-0 z-10 w-2.5 cursor-ew-resize touch-none transition hover:bg-white/10"
                    title="Trim the end"
                  >
                    <div className="absolute inset-y-1.5 right-1 w-0.5 rounded bg-ink/45" />
                  </div>
                  <div className="px-3">
                    <div className="truncate text-[11px] font-bold leading-tight text-ink">{c.sourceName}</div>
                    <div className="text-[10px] tabular-nums text-ink/55">{fmt(dur)}</div>
                  </div>
                  <div className="mt-1 flex items-center gap-1 px-2">
                    <button onPointerDown={(e) => e.stopPropagation()} onClick={() => nudge(c.id, -1)} disabled={i === 0} className="rounded px-1 text-xs text-ink/50 hover:text-ink disabled:opacity-30" title="Move left">‹</button>
                    <button onPointerDown={(e) => e.stopPropagation()} onClick={() => nudge(c.id, 1)} disabled={i === clips.length - 1} className="rounded px-1 text-xs text-ink/50 hover:text-ink disabled:opacity-30" title="Move right">›</button>
                    <button onPointerDown={(e) => e.stopPropagation()} onClick={() => deleteClip(c.id)} className="ml-auto rounded px-1 text-xs text-ink/40 hover:text-bad" title="Remove">✕</button>
                  </div>
                </div>
              </div>
            )
          })}
          {dropIndex === clips.length && clips.length > 0 && <div className="mx-0.5 w-1 self-stretch rounded bg-brand" />}
          {/* Preview playhead across the whole track. */}
          {previewing && <div ref={previewHeadRef} className="pointer-events-none absolute inset-y-1 w-0.5 bg-ink" style={{ left: '0%' }} />}
        </div>
        <p className="mt-2 text-xs text-ink/40">Drag a block's middle to reorder, its ends to trim. ‹ › nudge · ✕ removes. Preview plays the whole medley.</p>
      </section>

      {/* Floating drag ghost — a mini version of the block, in its source's color. */}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg px-3 py-1.5 text-xs font-bold text-ink shadow-glow"
          style={{ left: drag.x, top: drag.y, background: `${drag.color}33`, border: `1px solid ${drag.color}` }}
        >
          {drag.label}
        </div>
      )}
    </div>
  )
}
