// The mix editor: stitch parts of several dances into one medley, DaVinci-style.
//
//   pick a dance → CUT it into blocks (exactly like the practice segment-creator: tap
//   "✂ Cut here" as each move ends, or ↻ Auto-detect) → DRAG the blocks you want straight
//   down onto the mix timeline → repeat with any dance, in any order → preview → save.
//
// The blocks you cut and the blocks in the mix are the SAME object (same look), so it reads
// as one gesture: cut a block, drag it onto the timeline. Blocks in the mix reorder by a
// middle-drag and trim by dragging their ends. No camera/scoring here — a mix is a routine.

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
import { buildMovesFromBounds, autoMoveBounds, type Move } from '../../core/reference/segment'

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

function uuid(): string {
  return crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.round(Math.random() * 1e6)}`
}

const btn =
  'rounded-xl border border-line bg-ink/[0.06] px-3 py-2 text-sm font-medium text-ink/80 transition hover:text-ink active:scale-95'

// Fixed time scale for the mix timeline: every second of a part is this many pixels wide, so a
// block's width IS its duration (DaVinci-style) and edge-trimming maps px→seconds linearly.
const PPS = 7

// One shared look for a "part" block, used for the cut blocks and for every block in the mix so
// they read as the same object. `partStyle` tints it by its source dance's color.
const partCls = 'relative flex shrink-0 select-none flex-col justify-between overflow-hidden rounded-lg text-left'
function partStyle(color: string): { background: string; border: string } {
  return { background: `${color}22`, border: `1px solid ${color}` }
}

// Alternating tints for the cut blocks on the source bar (so adjacent parts are easy to tell
// apart), matching the practice segment-creator.
const SEG_TINTS = ['bg-brand/25', 'bg-brand2/25'] as const
// Auto-detect aims for roughly this many seconds per block.
const TARGET_SEG = 7

interface DragState {
  kind: 'add' | 'reorder'
  /** For 'add': the block being dragged into the mix. */
  clip?: MixClip
  /** For 'add' from a source block: loop-preview this if the press turns out to be a tap. */
  previewMove?: Move
  /** For 'reorder': which mix block is moving. */
  clipId?: string
  startX: number
  startY: number
  x: number
  y: number
  /** Set once the pointer has moved enough to count as a drag (vs a tap). */
  moved: boolean
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

/** Per-source cut state: the trim range plus the internal cut times inside it. */
interface SourceCut {
  trimStart: number
  trimEnd: number
  bounds: number[]
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
  const [sourcePlaying, setSourcePlaying] = useState(false)
  const [srcRate, setSrcRate] = useState(1)
  /** When set, the source loops just this range (previewing a cut block); else the whole trim. */
  const [srcLoop, setSrcLoop] = useState<{ start: number; end: number } | null>(null)
  const sourceVideoRef = useRef<HTMLVideoElement>(null)
  const segBarRef = useRef<HTMLDivElement>(null)
  const sourceTrack = sources.find((t) => t.id === sourceId) ?? null

  // Each source keeps its own cut state so switching dances and coming back doesn't lose cuts.
  const [segBySource, setSegBySource] = useState<Record<string, SourceCut>>({})
  const sourceDurById = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of sources) m.set(t.id, t.source.durationSec)
    return m
  }, [sources])
  const cut: SourceCut = (sourceId && segBySource[sourceId]) || {
    trimStart: 0,
    trimEnd: sourceTrack?.source.durationSec ?? 0,
    bounds: [],
  }
  const { trimStart, trimEnd, bounds } = cut
  const moves = useMemo(() => buildMovesFromBounds(trimStart, trimEnd, bounds), [trimStart, trimEnd, bounds])

  function updateCut(id: string, fn: (c: SourceCut) => SourceCut) {
    setSegBySource((prev) => {
      const base = prev[id] ?? { trimStart: 0, trimEnd: sourceDurById.get(id) ?? 0, bounds: [] }
      return { ...prev, [id]: fn(base) }
    })
  }

  // ---- preview of the assembled mix ----
  const previewVideoRef = useRef<HTMLVideoElement>(null)
  const previewCtrlRef = useRef<MixPlaybackController | null>(null)
  const previewHeadRef = useRef<HTMLDivElement>(null)
  const [previewing, setPreviewing] = useState(false)

  // ---- drag and drop ----
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [trim, setTrim] = useState<TrimState | null>(null)
  const [boundDrag, setBoundDrag] = useState<number | null>(null) // move index whose start cut is dragging
  const movedRef = useRef(false)
  const trackRowRef = useRef<HTMLDivElement>(null)

  const total = mixDuration(clips)
  const sourceOrder = useMemo(() => [...new Set(clips.map((c) => c.sourceTrackId))], [clips])
  // Each uploaded dance keeps ONE color everywhere (cut blocks + mix blocks), keyed off a stable
  // order of all sources so it never shifts as the mix changes.
  const colorOrder = useMemo(() => sources.map((t) => t.id), [sources])
  const cutColor = sourceTrack ? colorFor(sourceTrack.id, colorOrder) : SOURCE_COLORS[0]!

  // Load the picked source's video URL and seed its cut state.
  useEffect(() => {
    if (!sourceId) { setSourceUrl(null); return }
    let cancelled = false
    void ensureSourceUrl(sourceId).then((url) => {
      if (cancelled) return
      setSourceUrl(url)
      setSourceTime(0)
      setSrcLoop(null)
      setSourcePlaying(false)
      setSegBySource((prev) =>
        prev[sourceId]
          ? prev
          : { ...prev, [sourceId]: { trimStart: 0, trimEnd: sourceDurById.get(sourceId) ?? 0, bounds: [] } },
      )
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId])

  // Keep the source playhead moving while it plays, looping either a previewed block or the trim.
  useEffect(() => {
    if (!sourcePlaying) return
    let raf = 0
    const tick = () => {
      const v = sourceVideoRef.current
      if (v) {
        setSourceTime(v.currentTime)
        const lo = srcLoop?.start ?? trimStart
        const hi = srcLoop?.end ?? trimEnd
        if (v.currentTime >= hi - 0.05 || v.currentTime < lo - 0.05) v.currentTime = lo
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [sourcePlaying, srcLoop, trimStart, trimEnd])

  // Apply the source playback speed (pitch-corrected).
  useEffect(() => {
    const v = sourceVideoRef.current
    if (!v) return
    v.playbackRate = srcRate
    v.preservesPitch = true
    ;(v as unknown as { mozPreservesPitch?: boolean }).mozPreservesPitch = true
    ;(v as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true
  }, [srcRate, sourceUrl, sourcePlaying])

  function toggleSourcePlay() {
    const v = sourceVideoRef.current
    if (!v) return
    if (v.paused) {
      setSrcLoop(null) // Play runs the whole trimmed range
      if (v.currentTime < trimStart || v.currentTime >= trimEnd) v.currentTime = trimStart
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

  // ---- cutting the source into blocks ----

  function cutHere() {
    if (!sourceId) return
    const t = sourceTime
    if (t <= trimStart + 0.3 || t >= trimEnd - 0.3) return
    updateCut(sourceId, (c) => {
      if (c.bounds.some((b) => Math.abs(b - t) < 0.3)) return c
      return { ...c, bounds: [...c.bounds, t].sort((a, b) => a - b) }
    })
  }
  function autoDetect() {
    if (!sourceId || !sourceTrack) return
    const b = autoMoveBounds(sourceTrack.frames ?? [], trimStart, trimEnd, TARGET_SEG, sourceTrack.tempo)
    updateCut(sourceId, (c) => ({ ...c, bounds: b }))
  }
  function clearCuts() {
    if (!sourceId) return
    updateCut(sourceId, (c) => ({ ...c, bounds: [] }))
  }
  function changeTrim(s: number, e: number) {
    if (!sourceId) return
    updateCut(sourceId, (c) => ({ trimStart: s, trimEnd: e, bounds: c.bounds.filter((b) => b > s + 0.05 && b < e - 0.05) }))
  }

  function previewSegment(m: Move) {
    const v = sourceVideoRef.current
    if (!v) return
    setSrcLoop({ start: m.startSec, end: m.endSec })
    v.currentTime = m.startSec
    setSourceTime(m.startSec)
    void v.play().then(() => setSourcePlaying(true)).catch(() => {})
  }

  function clipFromMove(m: Move): MixClip | null {
    if (!sourceTrack || m.endSec - m.startSec < 0.3) return null
    return { id: uuid(), sourceTrackId: sourceTrack.id, sourceName: sourceTrack.name, startSec: m.startSec, endSec: m.endSec }
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
    const pad = 56 // generous drop zone so you don't have to be pixel-perfect
    return clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top - pad && clientY <= r.bottom + pad
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      if (!movedRef.current && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) movedRef.current = true
      setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY, moved: movedRef.current } : d))
      setDropIndex(pointerOverTrack(e.clientX, e.clientY) ? computeDropIndex(e.clientX) : null)
    }
    const up = (e: PointerEvent) => {
      const over = pointerOverTrack(e.clientX, e.clientY)
      const idx = over ? computeDropIndex(e.clientX) : null
      if (over && idx !== null) {
        if (drag.kind === 'add' && drag.clip) {
          const clip = { ...drag.clip, id: uuid() }
          setClips((cs) => insertClip(cs, clip, idx))
        } else if (drag.kind === 'reorder' && drag.clipId) {
          setClips((cs) => {
            const from = cs.findIndex((c) => c.id === drag.clipId)
            if (from < 0) return cs
            const to = idx > from ? idx - 1 : idx
            return moveClip(cs, from, to)
          })
        }
      } else if (drag.kind === 'add' && !movedRef.current && drag.previewMove) {
        // A tap on a cut block (never dragged out): preview-loop that part.
        previewSegment(drag.previewMove)
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
  }, [drag, clips])

  function startBlockDrag(e: React.PointerEvent, m: Move) {
    const clip = clipFromMove(m)
    if (!clip) return
    movedRef.current = false
    setDrag({
      kind: 'add', clip, previewMove: m,
      startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false,
      label: `${sourceTrack?.name ?? 'Part'} · ${fmt(m.endSec - m.startSec)}`, color: cutColor,
    })
  }
  function startReorderDrag(e: React.PointerEvent, c: MixClip) {
    movedRef.current = false
    setDrag({
      kind: 'reorder', clipId: c.id,
      startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false,
      label: `${c.sourceName} · ${fmt(c.endSec - c.startSec)}`, color: colorFor(c.sourceTrackId, colorOrder),
    })
  }

  // ---- drag a cut divider on the source bar (move a boundary) ----
  useEffect(() => {
    if (boundDrag == null || !sourceId) return
    const span = Math.max(0.001, trimEnd - trimStart)
    const move = (e: PointerEvent) => {
      const barEl = segBarRef.current
      if (!barEl) return
      const r = barEl.getBoundingClientRect()
      const x = Math.min(Math.max(0, e.clientX - r.left), r.width)
      const t = trimStart + (x / r.width) * span
      const prev = moves[boundDrag - 1]
      const curM = moves[boundDrag]
      if (!prev || !curM) return
      const tc = Math.min(Math.max(t, prev.startSec + 0.2), curM.endSec - 0.2)
      updateCut(sourceId, (c) => ({ ...c, bounds: moves.slice(1).map((mm) => (mm.index === boundDrag ? tc : mm.startSec)) }))
    }
    const up = () => setBoundDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundDrag, moves, trimStart, trimEnd, sourceId])

  // ---- edit blocks already in the mix ----
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
  function startTrim(e: React.PointerEvent, c: MixClip, edge: 'start' | 'end') {
    e.stopPropagation() // don't let the block's reorder-drag also fire
    setTrim({
      clipId: c.id, edge, startX: e.clientX, origStart: c.startSec, origEnd: c.endSec,
      sourceDur: sourceDurById.get(c.sourceTrackId) ?? c.endSec,
    })
  }
  useEffect(() => {
    if (!trim) return
    const MIN = 0.3
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

  // ---- preview (plays the whole mix across sources) ----
  async function startPreview() {
    if (clips.length === 0) return
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
      id: activeMix?.id ?? uuid(),
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

  const span = Math.max(0.001, trimEnd - trimStart)
  const pctOf = (t: number) => Math.min(100, Math.max(0, ((t - trimStart) / span) * 100))

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <button onClick={back} className={btn + ' !py-2'}>‹ Exit</button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 max-w-xs flex-1 rounded-xl border border-line bg-ink/[0.06] px-3 py-1.5 text-center font-display text-base font-bold text-ink outline-none focus:border-brand"
        />
        <button
          onClick={save}
          disabled={clips.length === 0}
          className="rounded-xl bg-brand px-5 py-2 text-sm font-bold text-cream shadow-glow transition hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save mix
        </button>
      </header>

      {/* STEP 1 — SOURCE: pick a dance, cut it into blocks, drag the ones you want into the mix. */}
      <section className="rounded-2.5xl border border-line bg-panel/70 p-4 shadow-soft">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink/45">Step 1 · cut a dance into parts</p>
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
            <video ref={sourceVideoRef} src={sourceUrl} className="h-full w-full object-contain" playsInline preload="auto" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-ink/40">Loading…</div>
          )}
        </div>

        {/* Trim the part of the dance you'll cut up (skip intros/outros). */}
        <div className="mt-3">
          <Scrubber
            duration={sourceTrack?.source.durationSec ?? 0}
            currentTime={sourceTime}
            rangeStart={trimStart}
            rangeEnd={trimEnd}
            sections={[]}
            onSeek={seekSource}
            onRangeChange={changeTrim}
          />
        </div>

        {/* The cut blocks. Tap ✂ Cut here as each move ends; tap a block to preview it; drag a
            block straight down into the mix. */}
        <p className="mt-3 text-xs text-ink/50">
          Play it and tap <span className="font-semibold text-ink/70">✂ Cut here</span> wherever a move ends (or ↻ Auto-detect).
          Each part becomes a block · <span className="font-semibold text-ink/70">drag the ones you want down into the mix</span>, tap one to preview.
        </p>
        <div ref={segBarRef} className="relative mt-2 h-16 w-full overflow-hidden rounded-xl border border-line bg-ink/[0.04]">
          {moves.length === 1 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-ink/40">
              one part so far · tap ✂ Cut here as you watch to split it
            </div>
          )}
          {moves.map((m) => {
            const left = pctOf(m.startSec)
            const width = Math.max(0, pctOf(m.endSec) - left)
            return (
              <div
                key={m.index}
                onPointerDown={(e) => startBlockDrag(e, m)}
                title="Drag me down into the mix · tap to preview"
                className={`group absolute bottom-0 top-0 flex cursor-grab touch-none flex-col items-center justify-center gap-0.5 border-r border-paper/40 text-[11px] font-semibold text-ink/70 transition hover:text-ink ${SEG_TINTS[m.index % SEG_TINTS.length] ?? ''}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              >
                <span className="pointer-events-none">{m.index + 1}</span>
                <span className="pointer-events-none text-[9px] tabular-nums text-ink/45">{fmt(m.endSec - m.startSec)}</span>
              </div>
            )
          })}
          {/* Draggable cut dividers (move a boundary). */}
          {moves.slice(1).map((m) => (
            <div
              key={`d${m.index}`}
              onPointerDown={(e) => { e.stopPropagation(); setBoundDrag(m.index) }}
              title="Drag to move this cut"
              className="absolute bottom-0 top-0 z-10 -ml-1.5 flex w-3 cursor-ew-resize items-center justify-center"
              style={{ left: `${pctOf(m.startSec)}%` }}
            >
              <div className="h-full w-0.5 bg-brand shadow-glow" />
            </div>
          ))}
          <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-ink" style={{ left: `${pctOf(sourceTime)}%` }} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={toggleSourcePlay} className={btn}>{sourcePlaying ? '⏸ Pause' : '▶ Play'}</button>
          <div className="flex overflow-hidden rounded-xl border border-line">
            {[1, 0.75, 0.5].map((r) => (
              <button
                key={r}
                onClick={() => setSrcRate(r)}
                className={`px-3 py-2 text-sm transition ${srcRate === r ? 'bg-brand font-semibold text-cream' : 'text-ink/70 hover:text-ink'}`}
              >
                {r}×
              </button>
            ))}
          </div>
          <button
            onClick={cutHere}
            className="rounded-xl bg-brand2/90 px-4 py-2 text-sm font-bold text-cream shadow-soft transition hover:brightness-105 active:scale-95"
          >
            ✂ Cut here
          </button>
          <button onClick={autoDetect} className={btn}>↻ Auto-detect</button>
          <button onClick={clearCuts} disabled={bounds.length === 0} className={btn + ' disabled:opacity-40'}>↺ Clear</button>
        </div>
      </section>

      {/* STEP 2 — MIX TIMELINE: always visible, fills up as you drag parts in. */}
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
              Drag a cut block here to build the mix
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

      {/* Floating drag ghost — a mini version of the block, in its source's color (only once
          the press becomes a real drag, so a tap-to-preview doesn't flash a ghost). */}
      {drag && drag.moved && (
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
