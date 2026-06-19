// The 8-counts as a row of chips. Locked sections (not yet unlocked) are disabled;
// each shows its best score so you can see what you've nailed.

import type { Section } from '../../core/audio/beats'

interface Props {
  sections: Section[]
  activeIndex: number
  unlockedThrough: number
  bestScores: Record<number, number>
  passThreshold: number
  onSelect: (index: number) => void
}

export function SectionTimeline({
  sections,
  activeIndex,
  unlockedThrough,
  bestScores,
  passThreshold,
  onSelect,
}: Props) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {sections.map((s) => {
        const locked = s.index > unlockedThrough
        const best = bestScores[s.index]
        const passed = (best ?? 0) >= passThreshold
        const active = s.index === activeIndex
        return (
          <button
            key={s.index}
            disabled={locked}
            onClick={() => onSelect(s.index)}
            className={[
              'group relative flex min-w-[104px] flex-col rounded-xl border px-3.5 py-2.5 text-left transition-all duration-150',
              active
                ? 'border-brand/60 bg-brand/15 shadow-glow'
                : passed
                  ? 'border-good/40 bg-good/[0.07] hover:border-good/60'
                  : 'border-line bg-white/[0.03] hover:border-white/25',
              locked ? 'cursor-not-allowed opacity-35' : 'cursor-pointer active:scale-95',
            ].join(' ')}
          >
            <span className="flex items-center gap-1.5 font-display text-sm font-semibold">
              {locked && <span aria-hidden className="text-white/50">🔒</span>}
              {passed && !locked && <span aria-hidden>✅</span>}
              {s.label}
            </span>
            <span className="mt-0.5 text-xs tabular-nums text-white/45">
              {best != null ? `best ${Math.round(best)}%` : locked ? 'locked' : 'not tried'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
