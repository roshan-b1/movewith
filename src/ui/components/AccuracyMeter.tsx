// Live accuracy readout. Big number + bar, colored by how well you're matching.

interface Props {
  score: number
  label?: string
  compact?: boolean
}

function colorFor(score: number): string {
  if (score >= 80) return '#3ddc97'
  if (score >= 55) return '#ffb84d'
  return '#ff6b6b'
}

export function AccuracyMeter({ score, label = 'Match', compact }: Props) {
  const clamped = Math.max(0, Math.min(100, score))
  const color = colorFor(clamped)
  return (
    <div
      className={
        compact
          ? 'w-full rounded-2xl border border-line bg-black/40 px-4 py-3 backdrop-blur-md'
          : 'w-full rounded-2xl border border-line bg-panel/70 p-4 backdrop-blur'
      }
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/45">{label}</span>
        <span className="font-display text-2xl font-bold tabular-nums leading-none" style={{ color }}>
          {Math.round(clamped)}
          <span className="ml-0.5 text-sm font-medium text-white/35">%</span>
        </span>
      </div>
      <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-150 ease-out"
          style={{ width: `${clamped}%`, backgroundColor: color, boxShadow: `0 0 12px ${color}66` }}
        />
      </div>
    </div>
  )
}
