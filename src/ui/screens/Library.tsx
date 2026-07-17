import { useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'

export function Library() {
  const tracks = useSession((s) => s.tracks)
  const openTrack = useSession((s) => s.openTrack)
  const importVideo = useSession((s) => s.importVideo)
  const renameTrack = useSession((s) => s.renameTrack)
  const removeTrack = useSession((s) => s.removeTrack)
  const status = useSession((s) => s.status)
  const extract = useSession((s) => s.extract)
  const error = useSession((s) => s.error)
  const clearError = useSession((s) => s.clearError)

  const fileInput = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  function startRename(id: string, current: string) {
    setRenaming(id)
    setDraftName(current)
  }
  function commitRename(id: string) {
    void renameTrack(id, draftName)
    setRenaming(null)
  }

  // One upload path. It always analyzes the moves (so both practice and "Test my skills"
  // work) — the camera choice happens later, per session, not here.
  function importFile(file: File | undefined) {
    if (!file) return
    const name = file.name.replace(/\.[^.]+$/, '')
    void importVideo(file, name || 'My dance', false)
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
      {/* Hero */}
      <header className="mb-8 animate-fade-up">
        <h1 className="font-display text-5xl font-bold leading-[0.95] tracking-tightish sm:text-7xl">
          Learn any dance,
          <br />
          <span className="text-gradient italic">move by move.</span>
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink/60">
          Upload a tutorial. It splits into short segments you learn one at a time, then test
          your skills on camera when you are ready. Everything runs on your device.
        </p>
      </header>

      {/* Upload — one clear action */}
      <label
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); importFile(e.dataTransfer.files?.[0]) }}
        className={[
          'group mb-10 flex cursor-pointer flex-col items-center justify-center rounded-2.5xl border-2 border-dashed p-8 text-center transition-all duration-200',
          dragOver ? 'scale-[1.01] border-brand bg-brand/10 shadow-glow' : 'border-ink/20 bg-ink/[0.02] hover:border-ink/35 hover:bg-ink/[0.04]',
        ].join(' ')}
      >
        <input ref={fileInput} type="file" accept="video/*" className="hidden" onChange={(e) => importFile(e.target.files?.[0])} />
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-2xl text-cream shadow-glow transition-transform duration-200 group-hover:-translate-y-0.5">
          ↑
        </div>
        <p className="font-display text-lg font-semibold">Upload a tutorial</p>
        <p className="mt-1 max-w-md text-sm text-ink/50">
          Drop in any dance video, or click to pick one. It learns the moves so you can drill them
          and get scored later.
        </p>
      </label>

      {/* How it works — the actual flow, in order, so a first-timer knows what they're in for */}
      <section className="mb-10">
        <h2 className="mb-4 font-display text-sm font-medium uppercase tracking-[0.18em] text-ink/45">How it works</h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              n: '1',
              t: 'Add a tutorial',
              d: 'Pick any dance video off your phone or laptop. Nothing gets uploaded to a server: the file stays on your device.',
            },
            {
              n: '2',
              t: 'Cut it into segments',
              d: 'Trim off the intro, then tap along to mark where each move starts and ends. Short segments beat one long routine.',
            },
            {
              n: '3',
              t: 'Learn it, watching yourself',
              d: 'Loop a segment, slow it to half speed, mirror it. Turn the camera on to dance beside yourself and watch each take play back before you move on.',
            },
            {
              n: '4',
              t: 'Test your skills',
              d: 'When you are ready, run the whole dance or one segment on camera. It scores each part and tells you which you nailed and which need work.',
            },
          ].map((s) => (
            <li key={s.n} className="rounded-2.5xl border border-line bg-panel/60 p-4">
              <span className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-brand text-xs font-bold text-cream">
                {s.n}
              </span>
              <p className="font-display text-sm font-semibold">{s.t}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink/50">{s.d}</p>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-ink/45">
          <span className="text-ink/35">Also built in:</span>
          {['Half speed with the pitch kept', 'Mirror mode', 'Loop any segment', 'Skip the talking parts', 'Voice control', 'Your progress saves'].map((f) => (
            <span key={f} className="rounded-full border border-line bg-ink/[0.04] px-3 py-1">{f}</span>
          ))}
        </div>
      </section>

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
      {tracks.length === 0 && status !== 'extracting' && (
        <div className="rounded-2.5xl border border-dashed border-ink/15 bg-ink/[0.02] p-10 text-center">
          <p className="font-display text-base font-semibold text-ink/70">No dances yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink/45">
            Add a tutorial above and it shows up here, with your segments and progress saved for
            next time.
          </p>
        </div>
      )}
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
            </button>
            {renaming === t.id ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => commitRename(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(t.id)
                  if (e.key === 'Escape') setRenaming(null)
                }}
                className="mx-1 w-[calc(100%-0.5rem)] rounded-lg border border-brand bg-ink/[0.06] px-2 py-1 font-display text-base font-semibold text-ink outline-none"
              />
            ) : (
              <div className="flex items-start justify-between gap-1">
                <button onClick={() => void openTrack(t.id)} className="min-w-0 flex-1 px-1 text-left font-display text-base font-semibold leading-snug">
                  {t.name}
                </button>
                <button
                  onClick={() => startRename(t.id, t.name)}
                  title="Rename"
                  className="shrink-0 rounded-lg px-1.5 py-0.5 text-sm text-ink/30 opacity-0 transition hover:text-ink group-hover:opacity-100"
                >
                  ✏
                </button>
              </div>
            )}
            <p className="mt-1 px-1 text-xs text-ink/50">
              {Math.round(t.tempo.bpm)} BPM · {Math.round(t.source.durationSec)}s
            </p>
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
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <button onClick={() => void openTrack(t.id, 'practice')} className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-cream shadow-soft transition hover:brightness-105 active:scale-95">
                      ▶ Practice
                    </button>
                    {t.frames.length > 0 && (
                      <button
                        onClick={() => void openTrack(t.id, 'rate')}
                        className="rounded-xl border border-brand2/50 bg-brand2/15 px-3 py-2 text-sm font-semibold text-ink transition hover:bg-brand2/25 active:scale-95"
                        title="Turn the camera on and get scored"
                      >
                        🎯 Test my skills
                      </button>
                    )}
                  </div>
                  {t.source.type !== 'bundled' && (
                    <button
                      onClick={() => setConfirmDelete(t.id)}
                      className="shrink-0 rounded-xl border border-line px-2.5 py-2 text-xs font-medium text-ink/45 transition hover:border-bad/50 hover:text-bad"
                      title="Delete this practice"
                    >
                      🗑
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
