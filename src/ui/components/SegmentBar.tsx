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
  /** Stretches deleted out of the routine, drawn as holes in the bar. */
  cuts?: Array<[number, number]>
  playheadRef?: React.Ref<HTMLDivElement>
  /** Tap a segment: jump to it. */
  onTap: (index: number) => void
  /** Drag the slider: seek to a time. */
  onSeek: (t: number) => void
}

export function SegmentBar({ trimStart, trimEnd, moves, activeIndex, completed, cuts = [], playheadRef, onTap, onSeek }: Props) {
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
        // No drag = a tap: jump to the segment under the pointer. A tap in a deleted hole
        // lands on no segment, so nothing happens — which is right, there is nothing there.
        const seg = segAt(timeAt(e.clientX))
        if (seg) onTap(seg.index)
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
          const active = m.index === activeIndex
          return (
            <div
              key={m.index}
              title={`Segment ${m.index + 1}${done ? ' (done · tap to review again)' : ''}`}
              className={`pointer-events-none absolute bottom-0 top-0 flex items-center justify-center border-r border-paper/40 text-[11px] font-bold tabular-nums ${
                done
                  ? 'bg-ink/[0.03] text-ink/25'
                  : active
                    ? 'bg-brand/30 text-ink ring-2 ring-inset ring-brand'
                    : 'bg-brand/10 text-ink/60'
              }`}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span>{done ? '✓' : m.index + 1}</span>
            </div>
          )
        })}
        {/* Deleted stretches: drawn as holes so the bar still reads as the real timeline. */}
        {cuts.map(([cs, ce], i) => (
          <div
            key={`cut${i}`}
            title="Deleted — playback jumps this"
            className="pointer-events-none absolute bottom-0 top-0 z-[5] border-x border-bad/25 bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.05),rgba(0,0,0,0.05)_3px,transparent_3px,transparent_7px)]"
            style={{ left: `${pct(cs)}%`, width: `${Math.max(0.4, pct(ce) - pct(cs))}%` }}
          />
        ))}
        {/* Playhead with a draggable knob (moved imperatively by the parent each frame) */}
        <div ref={playheadRef} className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-ink" style={{ left: '0%' }}>
          <div className="absolute -top-1 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-ink shadow-soft" />
        </div>
      </div>
      <div className="mt-1 flex justify-between px-0.5 text-[10px] uppercase tracking-wider text-ink/35">
        <span>{completed.length} of {moves.length} done</span>
        <span>tap a segment · drag to scrub</span>
      </div>
    </div>
  )
}
