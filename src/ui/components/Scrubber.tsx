// The video timeline with a draggable trim range. Drag the two handles to pick exactly
// the slice of the tutorial you want to learn (skip intros/outros). Tick marks show the
// move boundaries; the white line is the playhead. Tapping the bar seeks.

import { useEffect, useRef, useState } from 'react'
import type { Section } from '../../core/audio/beats'

interface Props {
  duration: number
  currentTime: number
  rangeStart: number
  rangeEnd: number
  sections: Section[]
  onSeek: (t: number) => void
  onRangeChange: (start: number, end: number) => void
  /** Optional ref to the playhead element so the parent can move it imperatively each
   *  frame (avoids re-rendering on every tick). */
  playheadRef?: React.Ref<HTMLDivElement>
}

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function Scrubber({ duration, currentTime, rangeStart, rangeEnd, sections, onSeek, onRangeChange, playheadRef }: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<null | 'start' | 'end' | 'seek'>(null)

  const pct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0)
  const timeAt = (clientX: number) => {
    const el = barRef.current
    if (!el || duration <= 0) return 0
    const r = el.getBoundingClientRect()
    const x = Math.min(Math.max(0, clientX - r.left), r.width)
    return (x / r.width) * duration
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const t = timeAt(e.clientX)
      if (drag === 'start') onRangeChange(Math.min(t, rangeEnd - 0.3), rangeEnd)
      else if (drag === 'end') onRangeChange(rangeStart, Math.max(t, rangeStart + 0.3))
      else onSeek(t)
    }
    const up = () => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, rangeStart, rangeEnd, duration])

  return (
    <div className="select-none">
      <div
        ref={barRef}
        onPointerDown={(e) => {
          setDrag('seek')
          onSeek(timeAt(e.clientX))
        }}
        className="relative h-11 cursor-pointer rounded-xl border border-line bg-ink/[0.06]"
      >
        {/* selected learn range */}
        <div
          className="absolute bottom-0 top-0 rounded-lg bg-brand/30"
          style={{ left: `${pct(rangeStart)}%`, width: `${Math.max(0, pct(rangeEnd) - pct(rangeStart))}%` }}
        />
        {/* move-boundary ticks */}
        {sections.map((s) => (
          <div key={s.index} className="absolute bottom-2 top-2 w-px bg-ink/20" style={{ left: `${pct(s.startSec)}%` }} />
        ))}
        {/* playhead (moved imperatively by the parent each frame) */}
        <div ref={playheadRef} className="pointer-events-none absolute bottom-0 top-0 w-0.5 bg-ink" style={{ left: `${pct(currentTime)}%` }} />
        {/* trim handles */}
        {(['start', 'end'] as const).map((which) => (
          <div
            key={which}
            onPointerDown={(e) => {
              e.stopPropagation()
              setDrag(which)
            }}
            title={which === 'start' ? 'Trim start' : 'Trim end'}
            className="absolute top-1/2 flex h-[140%] w-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-md bg-brand shadow-glow"
            style={{ left: `${pct(which === 'start' ? rangeStart : rangeEnd)}%` }}
          >
            <div className="h-5 w-0.5 rounded bg-white/80" />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs tabular-nums text-ink/45">
        <span>{fmt(rangeStart)}</span>
        <span className="text-ink/60">learning {fmt(Math.max(0, rangeEnd - rangeStart))}</span>
        <span>{fmt(rangeEnd)}</span>
      </div>
    </div>
  )
}
