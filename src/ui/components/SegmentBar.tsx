// The practice-screen timeline: shows the SEGMENTS across the trimmed range (not a trimmer).
// Completed ones grey out, the current one is highlighted, the playhead moves imperatively.
// TAP a segment to jump to it (with a get-ready countdown); DRAG anywhere to scrub/seek
// freely (like a video slider) — handy for rewinding in Full song.

import { useEffect, useRef, useState } from 'react'
import type { Move } from '../../core/reference/segment'

interface Props {
  trimStart: number
  trimEnd: number
  moves: Move[]
  activeIndex: number
  completed: number[]
  skip?: number[]
  playheadRef?: React.Ref<HTMLDivElement>
  /** Tap a segment: jump to it. */
  onTap: (index: number) => void
  /** Drag the slider: seek to a time. */
  onSeek: (t: number) => void
}

export function SegmentBar({ trimStart, trimEnd, moves, activeIndex, completed, skip = [], playheadRef, onTap, onSeek }: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const downXRef = useRef(0)
  const movedRef = useRef(false)
  const [scrubbing, setScrubbing] = useState(false)
  const span = Math.max(0.001, trimEnd - trimStart)
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - trimStart) / span) * 100))
  const timeAt = (clientX: number) => {
    const el = barRef.current
    if (!el) return trimStart
    const r = el.getBoundingClientRect()
    const x = Math.min(Math.max(0, clientX - r.left), r.width)
    return trimStart + (x / r.width) * span
  }
  const segAt = (t: number) => {
    for (const m of moves) if (t >= m.startSec && t < m.endSec) return m
    return moves[moves.length - 1]
  }

  useEffect(() => {
    if (!scrubbing) return
    const move = (e: PointerEvent) => {
      if (Math.abs(e.clientX - downXRef.current) > 4) movedRef.current = true
      if (movedRef.current) onSeek(timeAt(e.clientX)) // a real drag → scrub
    }
    const up = (e: PointerEvent) => {
      setScrubbing(false)
      if (!movedRef.current) {
        // No drag = a tap: jump to the segment under the pointer (skip the skipped ones).
        const seg = segAt(timeAt(e.clientX))
        if (seg && !skip.includes(seg.index)) onTap(seg.index)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing])

  return (
    <div className="select-none">
      <div
        ref={barRef}
        onPointerDown={(e) => { downXRef.current = e.clientX; movedRef.current = false; setScrubbing(true) }}
        className="relative h-11 w-full cursor-pointer overflow-hidden rounded-xl border border-line bg-ink/[0.04]"
      >
        {moves.map((m) => {
          const left = pct(m.startSec)
          const width = Math.max(0, pct(m.endSec) - left)
          const done = completed.includes(m.index)
          const skipped = skip.includes(m.index)
          const active = m.index === activeIndex
          return (
            <div
              key={m.index}
              title={`Segment ${m.index + 1}${skipped ? ' (skipped)' : done ? ' (done · tap to review again)' : ''}`}
              className={`pointer-events-none absolute bottom-0 top-0 flex items-center justify-center border-r border-paper/40 text-[11px] font-bold tabular-nums ${
                skipped
                  ? 'bg-ink/[0.02] text-ink/20 line-through'
                  : done
                    ? 'bg-ink/[0.03] text-ink/25'
                    : active
                      ? 'bg-brand/30 text-ink ring-2 ring-inset ring-brand'
                      : 'bg-brand/10 text-ink/60'
              }`}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span>{skipped ? '⊘' : done ? '✓' : m.index + 1}</span>
            </div>
          )
        })}
        {/* Playhead with a draggable knob (moved imperatively by the parent each frame) */}
        <div ref={playheadRef} className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-ink" style={{ left: '0%' }}>
          <div className="absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-ink shadow-soft" />
        </div>
      </div>
      <div className="mt-1 flex justify-between px-0.5 text-[10px] uppercase tracking-wider text-ink/35">
        <span>{completed.length} of {Math.max(0, moves.length - skip.length)} done{skip.length ? ` · ${skip.length} skipped` : ''}</span>
        <span>tap a segment · drag to scrub</span>
      </div>
    </div>
  )
}
