// Review and fix the auto-detected segments before practicing. Each segment is a slice of
// the trimmed range, tinted by section (groups of 3). Tap a segment to LOOP-play it so you
// can see exactly where it ends; drag a divider to move a boundary, or ✕ to merge two.
// The parent owns the boundary list and playback — this renders and reports edits.

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
  /** Drag the start of segment `i` (i >= 1) to time `t`. */
  onMoveBound: (moveIndex: number, t: number) => void
  /** Delete a segment (its time merges into a neighbour). */
  onDeleteSegment: (moveIndex: number) => void
  /** Segment indices skipped/cut from practice (e.g. explanations). */
  skip?: number[]
  /** Toggle a segment's skipped state. */
  onToggleSkip?: (moveIndex: number) => void
}

// Alternate tints so adjacent segments are easy to tell apart.
const SEGMENT_TINTS = ['bg-brand/20', 'bg-brand2/20']

export function MoveEditor({ trimStart, trimEnd, moves, activeIndex, playheadRef, creating, skip = [], onPlaySegment, onMoveBound, onDeleteSegment, onToggleSkip }: Props) {
  const noCutsYet = creating === true && moves.length <= 1
  const barRef = useRef<HTMLDivElement>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
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
    if (dragIdx == null) return
    const move = (e: PointerEvent) => {
      const prev = moves[dragIdx - 1]
      const cur = moves[dragIdx]
      if (!prev || !cur) return
      const t = Math.min(Math.max(timeAt(e.clientX), prev.startSec + 0.2), cur.endSec - 0.2)
      onMoveBound(dragIdx, t)
    }
    const up = () => setDragIdx(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragIdx, moves, trimStart, trimEnd])

  return (
    <div className="select-none">
      <div ref={barRef} className="relative h-14 w-full overflow-hidden rounded-xl border border-line bg-ink/[0.04]">
        {/* Creator with nothing placed yet: empty bar with a hint instead of one block. */}
        {noCutsYet && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-ink/45">
            no segments yet · tap ✂ Cut here as you watch
          </div>
        )}
        {/* Segments. Tap to loop-play; ⊘ to skip (cut from practice); ✕ to delete. */}
        {!noCutsYet && moves.map((m) => {
          const left = pct(m.startSec)
          const width = Math.max(0, pct(m.endSec) - left)
          const active = m.index === activeIndex
          const skipped = skip.includes(m.index)
          return (
            <button
              key={m.index}
              onClick={() => onPlaySegment(m)}
              title={`Segment ${m.index + 1}${skipped ? ' (skipped)' : ''} · tap to play it`}
              className={`group absolute bottom-0 top-0 flex items-center justify-center border-r border-paper/40 text-[11px] font-semibold transition ${
                skipped
                  ? 'bg-ink/[0.03] text-ink/25 line-through'
                  : SEGMENT_TINTS[m.index % SEGMENT_TINTS.length] + (active ? ' ring-2 ring-inset ring-brand text-ink' : ' text-ink/55 hover:text-ink')
              }`}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span className="pointer-events-none">{skipped ? '⊘' : active ? '▶' : m.index + 1}</span>
              {width > 5 && onToggleSkip && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onToggleSkip(m.index) }}
                  title={skipped ? 'Un-skip (include in practice)' : 'Skip this part in practice (e.g. an explanation)'}
                  className={`absolute left-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-paper/70 text-[10px] transition group-hover:opacity-100 ${skipped ? 'text-warn opacity-100' : 'text-ink/55 opacity-0 hover:text-warn'}`}
                >
                  ⊘
                </span>
              )}
              {moves.length > 1 && width > 5 && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onDeleteSegment(m.index) }}
                  title="Delete this segment"
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-paper/70 text-[10px] text-ink/55 opacity-0 transition hover:bg-bad hover:text-cream group-hover:opacity-100"
                >
                  ✕
                </span>
              )}
            </button>
          )
        })}

        {/* Draggable dividers between segments (drag to move the boundary). */}
        {moves.slice(1).map((m) => (
          <div
            key={`d${m.index}`}
            onPointerDown={(e) => { e.stopPropagation(); setDragIdx(m.index) }}
            title="Drag to move this boundary"
            className="absolute -ml-1.5 bottom-0 top-0 z-10 flex w-3 cursor-ew-resize items-center justify-center"
            style={{ left: `${pct(m.startSec)}%` }}
          >
            <div className="h-full w-0.5 bg-brand shadow-glow" />
          </div>
        ))}

        {/* Playhead (moved imperatively by the parent each frame) */}
        <div ref={playheadRef} className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-ink" style={{ left: '0%' }} />
      </div>
      <div className="mt-1 flex justify-between px-0.5 text-[10px] uppercase tracking-wider text-ink/35">
        <span>{noCutsYet ? '0 segments' : `${moves.length} segments`}</span>
        <span>{creating ? 'tap ✂ Cut to place each one' : 'tap to play · ⊘ to skip · ✕ to delete · drag dividers'}</span>
      </div>
    </div>
  )
}
