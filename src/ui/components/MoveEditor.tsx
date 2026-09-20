// Review and fix the segments before practicing. Each segment is a slice of the trimmed
// range, tinted by section (groups of 3). Tap a segment to LOOP-play it so you can see
// exactly where it ends; drag a divider to move a boundary, or ✕ to DELETE the part —
// which removes that stretch of the routine outright, leaving a visible hole you can tap
// to put back. The parent owns the boundary list, the deletions and playback — this
// renders and reports edits.

import { useEffect, useRef, useState } from 'react'
import type { Move } from '../../core/reference/segment'

interface Props {
  trimStart: number
  trimEnd: number
  moves: Move[]
  /** Index of the segment currently looping (highlighted), or -1. */
  activeIndex: number
  /** Ref to the playhead line so the parent can move it imperatively each frame. */
  playheadRef?: React.Ref<HTMLDivElement>
  /** In the segment-creator the single uncut range reads as "no segments yet". */
  creating?: boolean
  /** Tap a segment: loop-play it. */
  onPlaySegment: (m: Move) => void
  /** A boundary drag started — the parent records one undo step for the whole gesture. */
  onBoundDragStart?: () => void
  /** Move the divider that currently sits at `fromSec` to `toSec`. */
  onMoveBound: (fromSec: number, toSec: number) => void
  /** Remove the divider at `atSec`, joining the two segments. No time is lost. */
  onRemoveBound?: (atSec: number) => void
  /** Delete a segment: its stretch is cut out of the routine. */
  onDeleteSegment: (moveIndex: number) => void
  /** Stretches already deleted (normalized, in order). */
  cuts?: Array<[number, number]>
  /** Put a deleted stretch back. */
  onRestoreCut?: (cutIndex: number) => void
}

// Alternate tints so adjacent segments are easy to tell apart.
const SEGMENT_TINTS = ['bg-brand/20', 'bg-brand2/20']
// Two moves belong to the same unbroken stretch when they touch within this.
const TOUCH_EPS = 0.02

export function MoveEditor({
  trimStart, trimEnd, moves, activeIndex, playheadRef, creating,
  cuts = [], onPlaySegment, onBoundDragStart, onMoveBound, onRemoveBound, onDeleteSegment, onRestoreCut,
}: Props) {
  const noCutsYet = creating === true && moves.length <= 1 && cuts.length === 0
  const barRef = useRef<HTMLDivElement>(null)
  // The divider being dragged: where it sits RIGHT NOW, plus how far it may travel. The
  // live position is a ref because each pointermove reports "move the one at X to Y".
  const [drag, setDrag] = useState<{ min: number; max: number } | null>(null)
  const dragAtRef = useRef(0)
  const span = Math.max(0.001, trimEnd - trimStart)
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - trimStart) / span) * 100))
  const timeAt = (clientX: number) => {
    const el = barRef.current
    if (!el) return trimStart
    const r = el.getBoundingClientRect()
    const x = Math.min(Math.max(0, clientX - r.left), r.width)
    return trimStart + (x / r.width) * span
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const t = Math.min(Math.max(timeAt(e.clientX), drag.min), drag.max)
      if (Math.abs(t - dragAtRef.current) < 1e-4) return
      onMoveBound(dragAtRef.current, t)
      dragAtRef.current = t
    }
    const up = () => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, trimStart, trimEnd])

  // A divider is only draggable where two segments actually TOUCH. Either side of a deleted
  // hole there is no shared boundary to drag — the hole's own edges are not cut points.
  const dividers = moves
    .map((m, i) => ({ m, prev: moves[i - 1] }))
    .filter((d) => d.prev != null && Math.abs(d.m.startSec - d.prev.endSec) < TOUCH_EPS)
    .map((d) => ({ at: d.m.startSec, min: d.prev!.startSec + 0.2, max: d.m.endSec - 0.2 }))

  const deletedSec = cuts.reduce((n, [s, e]) => n + (e - s), 0)

  return (
    <div className="select-none">
      <div ref={barRef} className="relative h-14 w-full overflow-hidden rounded-xl border border-line bg-ink/[0.04]">
        {/* Creator with nothing placed yet: empty bar with a hint instead of one block. */}
        {noCutsYet && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-ink/45">
            no segments yet · tap ✂ Cut here as you watch
          </div>
        )}

        {/* Deleted stretches. They keep their real width, so you can see how much you took
            out and exactly where the hole is. Tap to put it back. */}
        {cuts.map(([s, e], i) => {
          const left = pct(s)
          const width = Math.max(0.4, pct(e) - left)
          return (
            <button
              key={`cut${i}`}
              onClick={() => onRestoreCut?.(i)}
              disabled={!onRestoreCut}
              title={`Deleted ${(e - s).toFixed(1)}s · tap to put it back`}
              className="group absolute bottom-0 top-0 z-[5] flex items-center justify-center border-x border-bad/40 bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.05),rgba(0,0,0,0.05)_3px,transparent_3px,transparent_7px)] text-[10px] text-ink/30 transition hover:bg-bad/10 hover:text-ink/70 disabled:cursor-default"
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span className="pointer-events-none whitespace-nowrap">{width > 6 ? '↺ deleted' : '↺'}</span>
            </button>
          )
        })}

        {/* Segments. Tap to loop-play; ✕ to delete the part outright. */}
        {!noCutsYet && moves.map((m) => {
          const left = pct(m.startSec)
          const width = Math.max(0, pct(m.endSec) - left)
          const active = m.index === activeIndex
          return (
            <button
              key={m.index}
              onClick={() => onPlaySegment(m)}
              title={`Segment ${m.index + 1} · tap to play it`}
              className={`group absolute bottom-0 top-0 flex items-center justify-center border-r border-paper/40 text-[11px] font-semibold transition ${
                SEGMENT_TINTS[m.index % SEGMENT_TINTS.length]
              }${active ? ' ring-2 ring-inset ring-brand text-ink' : ' text-ink/55 hover:text-ink'}`}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span className="pointer-events-none">{active ? '▶' : m.index + 1}</span>
              {moves.length > 1 && width > 5 && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onDeleteSegment(m.index) }}
                  title="Delete this part — cut it out of the routine (⌘Z undoes)"
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-paper/70 text-[10px] text-ink/55 opacity-0 transition hover:bg-bad hover:text-cream group-hover:opacity-100"
                >
                  ✕
                </span>
              )}
            </button>
          )
        })}

        {/* Draggable dividers between segments that touch (drag to move the boundary). */}
        {dividers.map((d) => (
          <div
            key={`d${d.at}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              dragAtRef.current = d.at
              onBoundDragStart?.()
              setDrag({ min: d.min, max: d.max })
            }}
            onDoubleClick={(e) => { e.stopPropagation(); setDrag(null); onRemoveBound?.(d.at) }}
            title="Drag to move this boundary · double-click to join the two segments"
            className="absolute -ml-1.5 bottom-0 top-0 z-10 flex w-3 cursor-ew-resize items-center justify-center"
            style={{ left: `${pct(d.at)}%` }}
          >
            <div className="h-full w-0.5 bg-brand shadow-glow" />
          </div>
        ))}

        {/* Playhead (moved imperatively by the parent each frame) */}
        <div ref={playheadRef} className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-ink" style={{ left: '0%' }} />
      </div>
      <div className="mt-1 flex justify-between px-0.5 text-[10px] uppercase tracking-wider text-ink/35">
        <span>
          {noCutsYet ? '0 segments' : `${moves.length} segments`}
          {deletedSec > 0.05 && ` · ${deletedSec.toFixed(1)}s deleted`}
        </span>
        <span>{creating ? 'tap ✂ Cut to place each one' : 'tap to play · ✕ delete · drag dividers · ↺ restore'}</span>
      </div>
    </div>
  )
}
