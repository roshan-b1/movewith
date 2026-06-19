import { useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'
import { DEMO_TRACK_ID } from '../../core/demo/demoDance'

export function Library() {
  const tracks = useSession((s) => s.tracks)
  const openTrack = useSession((s) => s.openTrack)
  const importVideo = useSession((s) => s.importVideo)
  const removeTrack = useSession((s) => s.removeTrack)
  const status = useSession((s) => s.status)
  const extract = useSession((s) => s.extract)
  const error = useSession((s) => s.error)
  const clearError = useSession((s) => s.clearError)

  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    const name = file.name.replace(/\.[^.]+$/, '')
    void importVideo(file, name || 'My dance')
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
      {/* Hero */}
      <header className="mb-12 animate-fade-up sm:mb-16">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-white/5 px-3 py-1 text-xs font-medium text-white/70">
          <span className="h-1.5 w-1.5 rounded-full bg-good" />
          Live pose coaching · runs in your browser
        </div>
        <h1 className="font-display text-5xl font-bold leading-[0.95] tracking-tightish sm:text-7xl">
          Dance tutorials
          <br />
          that move <span className="text-gradient italic">with you.</span>
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-white/55">
          Load any routine and learn it 8-count by 8-count. Your camera watches along,
          shows you exactly where you're off, and unlocks the next move once you've got it.
          No pausing, no rewinding.
        </p>
      </header>

      {/* Upload */}
      <label
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          handleFiles(e.dataTransfer.files)
        }}
        className={[
          'group mb-12 flex cursor-pointer flex-col items-center justify-center rounded-2.5xl border border-dashed px-8 py-12 text-center transition-all duration-200',
          dragOver
            ? 'scale-[1.01] border-brand/70 bg-brand/10 shadow-glow'
            : 'border-white/15 bg-white/[0.02] hover:border-white/30 hover:bg-white/[0.04]',
        ].join(' ')}
      >
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand2 text-2xl shadow-glow transition-transform duration-200 group-hover:-translate-y-0.5">
          ↑
        </div>
        <p className="font-display text-lg font-semibold">Upload a tutorial video</p>
        <p className="mt-1 text-sm text-white/45">
          Drop a clip here or click to choose · a full-body, well-lit shot works best
        </p>
      </label>

      {/* Extraction progress */}
      {status === 'extracting' && extract && (
        <div className="mb-12 animate-fade-up rounded-2.5xl border border-line bg-panel/60 p-6 shadow-soft">
          <div className="mb-3 flex items-center gap-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand/40 border-t-brand" />
            <p className="text-sm font-medium">{extract.message}</p>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand to-brand2 transition-[width] duration-300"
              style={{ width: `${extract.ratio * 100}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mb-12 flex items-start justify-between gap-3 rounded-2xl border border-bad/40 bg-bad/10 p-4 text-sm">
          <span className="text-bad/90">{error}</span>
          <button onClick={clearError} className="shrink-0 text-white/50 transition hover:text-white">
            ✕
          </button>
        </div>
      )}

      {/* Library grid */}
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="font-display text-sm font-medium uppercase tracking-[0.18em] text-white/40">
          Your dances
        </h2>
        <span className="text-xs text-white/30">{tracks.length} saved</span>
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tracks.map((t, i) => (
          <div
            key={t.id}
            style={{ animationDelay: `${i * 60}ms` }}
            className="group flex animate-fade-up flex-col justify-between rounded-2.5xl border border-line bg-panel/50 p-3 shadow-soft transition-all duration-200 hover:-translate-y-1 hover:border-white/20"
          >
            <button onClick={() => void openTrack(t.id)} className="text-left">
              <div className="relative mb-4 flex h-32 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-brand/25 via-brand2/15 to-transparent">
                <span className="text-5xl drop-shadow-lg transition-transform duration-300 group-hover:scale-110">
                  {t.source.type === 'bundled' ? '🕺' : '💃'}
                </span>
                {t.source.type === 'bundled' && (
                  <span className="absolute left-2.5 top-2.5 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/70 backdrop-blur">
                    Demo
                  </span>
                )}
              </div>
              <h3 className="px-1 font-display text-base font-semibold leading-snug">{t.name}</h3>
              <p className="mt-1 px-1 text-xs text-white/45">
                {t.sections.length} 8-counts · {Math.round(t.tempo.bpm)} BPM · {Math.round(t.source.durationSec)}s
              </p>
            </button>
            <div className="mt-4 flex items-center justify-between px-1 pb-1">
              <button
                onClick={() => void openTrack(t.id)}
                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-ink shadow-soft transition hover:bg-white/90 active:scale-95"
              >
                Learn →
              </button>
              {t.id !== DEMO_TRACK_ID && (
                <button
                  onClick={() => void removeTrack(t.id)}
                  className="px-2 text-xs text-white/30 transition hover:text-bad"
                  title="Delete dance"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <footer className="mt-16 text-center text-xs text-white/25">
        Your camera never leaves your device. Everything runs locally.
      </footer>
    </div>
  )
}
