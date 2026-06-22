// The 8-counts as a row of chips. Locked sections are disabled; completed ones show a
// check and are dimmed; each can be checked to add to a custom practice set.

import type { Section } from '../../core/audio/beats'

interface Props {
  sections: Section[]
  activeIndex: number
  unlockedThrough: number
  bestScores: Record<number, number>
  passThreshold: number
  completed: number[]
  selected: number[]
  onSelect: (index: number) => void
  onToggleSelect: (index: number) => void
}

export function SectionTimeline({
  sections,
  activeIndex,
  unlockedThrough,
  bestScores,
  passThreshold,
  completed,
  selected,
  onSelect,
  onToggleSelect,
}: Props) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {sections.map((s) => {
        const locked = s.index > unlockedThrough
        const best = bestScores[s.index]
        const isDone = completed.includes(s.index)
        const passed = isDone || (best ?? 0) >= passThreshold
        const active = s.index === activeIndex
        const isSelected = selected.includes(s.index)
        return (
          <div
            key={s.index}
            className={[
              'group relative flex min-w-[112px] flex-col rounded-xl border px-3 py-2.5 transition-all duration-150',
              active
                ? 'border-brand/60 bg-brand/15 shadow-glow'
                : isDone
                  ? 'border-good/40 bg-good/[0.06]'
                  : 'border-line bg-white/[0.03] hover:border-white/25',
              locked ? 'opacity-35' : '',
            ].join(' ')}
          >
            <div className="flex items-center justify-between gap-2">
              <button
                disabled={locked}
                onClick={() => onSelect(s.index)}
                className={`flex items-center gap-1.5 font-display text-sm font-semibold ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {locked && <span aria-hidden className="text-white/50">🔒</span>}
                {passed && !locked && <span aria-hidden>✅</span>}
                {s.label}
              </button>
              {!locked && (
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleSelect(s.index)}
                  title="Add to practice set"
                  className="h-3.5 w-3.5 cursor-pointer accent-brand"
                />
              )}
            </div>
            <button
              disabled={locked}
              onClick={() => onSelect(s.index)}
              className="mt-0.5 text-left text-xs tabular-nums text-white/45"
            >
              {isDone ? 'completed' : best != null ? `best ${Math.round(best)}%` : locked ? 'locked' : 'not tried'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
