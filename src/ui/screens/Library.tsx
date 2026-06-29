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

  const learnInput = useRef<HTMLInputElement>(null)
  const playInput = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  function importFile(file: File | undefined, playbackOnly: boolean) {
    if (!file) return
    const name = file.name.replace(/\.[^.]+$/, '')
    void importVideo(file, name || 'My dance', playbackOnly)
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
      {/* Hero */}
      <header className="mb-10 animate-fade-up">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-ink/[0.04] px-3 py-1 text-xs font-medium text-ink/60">
          <span className="h-1.5 w-1.5 rounded-full bg-good" />
          Your smart dance helper · runs in your browser
        </div>
        <h1 className="font-display text-5xl font-bold leading-[0.95] tracking-tightish sm:text-7xl">
          Learn any dance,
          <br />
          <span className="text-gradient italic">move by move.</span>
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink/60">
          Drop in a tutorial and learn it bit by bit. Slow it down, loop the tricky parts, and dance
          along. Turn the camera on when you want it to check your moves.
        </p>
      </header>

      {/* Two clear actions */}
      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            importFile(e.dataTransfer.files?.[0], false)
          }}
          className={[
            'group flex cursor-pointer flex-col items-center justify-center rounded-2.5xl border-2 border-dashed p-8 text-center transition-all duration-200 sm:col-span-2',
            dragOver ? 'scale-[1.01] border-brand bg-brand/10 shadow-glow' : 'border-ink/20 bg-ink/[0.02] hover:border-ink/35 hover:bg-ink/[0.04]',
          ].join(' ')}
        >
          <input ref={learnInput} type="file" accept="video/*" className="hidden" onChange={(e) => importFile(e.target.files?.[0], false)} />
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-2xl text-cream shadow-glow transition-transform duration-200 group-hover:-translate-y-0.5">
            ↑
          </div>
          <p className="font-display text-lg font-semibold">Learn a dance, coached</p>
          <p className="mt-1 text-sm text-ink/50">
            Upload a tutorial. It learns the moves, then your camera checks you and scores each one.
          </p>
        </label>

        <button
          onClick={() => playInput.current?.click()}
          className="flex flex-col items-center justify-center rounded-2.5xl border border-line bg-panel/70 p-8 text-center shadow-soft transition hover:border-ink/25"
        >
          <input ref={playInput} type="file" accept="video/*" className="hidden" onChange={(e) => importFile(e.target.files?.[0], true)} />
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand2/20 text-2xl">▶</div>
          <p className="font-display text-base font-semibold">Practice along</p>
          <p className="mt-1 text-xs text-ink/50">Dance along to any video: slow-mo, loop the hard parts, mirror it. No camera.</p>
        </button>
      </div>

      {/* What you can do */}
      <div className="mb-10 flex flex-wrap items-center justify-center gap-2 text-xs text-ink/55">
        {['Slow-mo', 'Loop any part', 'Mirror', 'Move-by-move breakdown', 'Trim to the section you want', 'Voice control', 'Live scoring'].map((f) => (
          <span key={f} className="rounded-full border border-line bg-ink/[0.04] px-3 py-1">{f}</span>
        ))}
      </div>

      {/* Extraction progress */}
      {status === 'extracting' && extract && (
        <div className="mb-10 animate-fade-up rounded-2.5xl border border-line bg-panel/80 p-6 shadow-soft">
          <div className="mb-3 flex items-center gap-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand/40 border-t-brand" />
            <p className="text-sm font-medium">{extract.message}</p>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-ink/10">
            <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${extract.ratio * 100}%` }} />
          </div>
        </div>
      )}

      {error && (
        <div className="mb-10 flex items-start justify-between gap-3 rounded-2xl border border-bad/40 bg-bad/10 p-4 text-sm">
          <span className="text-bad">{error}</span>
          <button onClick={clearError} className="shrink-0 text-ink/50 transition hover:text-ink">✕</button>
        </div>
      )}

      {/* Library grid */}
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="font-display text-sm font-medium uppercase tracking-[0.18em] text-ink/45">Your dances</h2>
        <span className="text-xs text-ink/35">{tracks.length} saved</span>
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tracks.map((t, i) => (
          <div
            key={t.id}
            style={{ animationDelay: `${i * 60}ms` }}
            className="group flex animate-fade-up flex-col justify-between rounded-2.5xl border border-line bg-panel/80 p-3 shadow-soft transition-all duration-200 hover:-translate-y-1 hover:border-ink/25"
          >
            <button onClick={() => void openTrack(t.id)} className="text-left">
              <div className="relative mb-4 flex h-32 items-center justify-center overflow-hidden rounded-xl bg-brand/15">
                <span className="text-5xl transition-transform duration-300 group-hover:scale-110">
                  {t.source.type === 'bundled' ? '🕺' : t.frames.length === 0 ? '🎬' : '💃'}
                </span>
                {t.frames.length === 0 && t.source.type !== 'bundled' && (
                  <span className="absolute left-2.5 top-2.5 rounded-full bg-ink/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink/70">
                    Playback
                  </span>
                )}
              </div>
              <h3 className="px-1 font-display text-base font-semibold leading-snug">{t.name}</h3>
              <p className="mt-1 px-1 text-xs text-ink/50">
                {Math.round(t.tempo.bpm)} BPM · {Math.round(t.source.durationSec)}s
              </p>
            </button>
            <div className="mt-4 flex items-center justify-between gap-2 px-1 pb-1">
              {confirmDelete === t.id ? (
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-xs text-ink/60">Delete this practice?</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => { setConfirmDelete(null); void removeTrack(t.id) }}
                      className="rounded-lg bg-bad px-3 py-1.5 text-xs font-semibold text-cream transition hover:brightness-110 active:scale-95"
                    >
                      Delete
                    </button>
                    <button onClick={() => setConfirmDelete(null)} className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink/60 transition hover:text-ink">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button onClick={() => void openTrack(t.id)} className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-cream shadow-soft transition hover:brightness-105 active:scale-95">
                    Open →
                  </button>
                  {t.id !== DEMO_TRACK_ID && (
                    <button
                      onClick={() => setConfirmDelete(t.id)}
                      className="rounded-xl border border-line px-3 py-2 text-xs font-medium text-ink/45 transition hover:border-bad/50 hover:text-bad"
                      title="Delete this practice"
                    >
                      🗑 Delete
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <footer className="mt-14 text-center text-xs text-ink/30">Your camera never leaves your device. Everything runs locally.</footer>
    </div>
  )
}
