// Transport + practice controls: play/pause, slow-mo speeds, mirror, loop-section.

interface Props {
  playing: boolean
  rate: number
  mirror: boolean
  looping: boolean
  onTogglePlay: () => void
  onRate: (rate: number) => void
  onToggleMirror: () => void
  onToggleLoop: () => void
  onRestart: () => void
}

const RATES = [1, 0.75, 0.5]

function Toggle({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  title: string
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={[
        'rounded-xl border px-3.5 py-2.5 text-sm font-medium transition-all duration-150 active:scale-95',
        active
          ? 'border-brand/60 bg-brand/20 text-white shadow-glow'
          : 'border-line bg-white/5 text-white/65 hover:border-white/25 hover:text-white',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function Controls({
  playing,
  rate,
  mirror,
  looping,
  onTogglePlay,
  onRate,
  onToggleMirror,
  onToggleLoop,
  onRestart,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={onTogglePlay}
        className="flex items-center gap-2 rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-ink shadow-soft transition hover:bg-white/90 active:scale-95"
      >
        {playing ? '⏸ Pause' : '▶ Play'}
      </button>
      <button
        onClick={onRestart}
        title="Restart section"
        className="rounded-xl border border-line bg-white/5 px-3.5 py-2.5 text-sm text-white/65 transition hover:border-white/25 hover:text-white active:scale-95"
      >
        ↺
      </button>

      <div className="mx-1 flex items-center gap-1 rounded-xl border border-line bg-white/5 p-1">
        {RATES.map((r) => (
          <button
            key={r}
            onClick={() => onRate(r)}
            className={[
              'rounded-lg px-3 py-1.5 text-sm font-medium tabular-nums transition',
              rate === r ? 'bg-brand text-white shadow-glow' : 'text-white/55 hover:text-white',
            ].join(' ')}
          >
            {r === 1 ? '1×' : `${r}×`}
          </button>
        ))}
      </div>

      <Toggle active={mirror} onClick={onToggleMirror} title="Mirror the instructor (face them like a mirror)">
        🪞 Mirror
      </Toggle>
      <Toggle active={looping} onClick={onToggleLoop} title="Loop the current 8-count">
        🔁 Loop
      </Toggle>
    </div>
  )
}
