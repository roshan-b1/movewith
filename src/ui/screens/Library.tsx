import { useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'

/** Verdict color for a 0..100 score, matching the rater. */
function scoreColor(score: number): string {
  if (score >= 85) return '#a3e635'
  if (score >= 70) return '#facc15'
  if (score >= 50) return '#ff9f1c'
  return '#ff5470'
}
/** Short "when" label from an epoch time (today / Nd ago / a date). */
function whenLabel(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

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
  const reportsByTrack = useSession((s) => s.reportsByTrack)

  const fileInput = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [pickRate, setPickRate] = useState(false)
  /** Track id whose full report history is open in a modal, if any. */
  const [viewReports, setViewReports] = useState<string | null>(null)

  // Only dances that were analyzed (have pose frames) can be scored.
  const scorable = tracks.filter((t) => t.frames.length > 0)

  function startRename(id: string, current: string) {
    setRenaming(id)
    setDraftName(current)
  }
  function commitRename(id: string) {
    void renameTrack(id, draftName)
    setRenaming(null)
  }

  // One upload path. It always analyzes the moves (so both practice and "Test my skills"
  // work). Uploads started from the Test-my-skills modal open straight into the rater;
  // uploads from the main dropzone open into practice.
  const uploadIntentRef = useRef<'practice' | 'rate'>('practice')
  function importFile(file: File | undefined) {
    if (!file) return
    const name = file.name.replace(/\.[^.]+$/, '')
    void importVideo(file, name || 'My dance', false, uploadIntentRef.current)
    uploadIntentRef.current = 'practice'
  }
  function uploadForRating() {
    uploadIntentRef.current = 'rate'
    setPickRate(false)
    fileInput.current?.click()
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
      {/* Hero */}
      <header className="mb-8 animate-fade-up">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/logo.svg" alt="" className="h-9 w-9" />
          <span className="font-display text-xl font-bold tracking-tightish">
            Move<span className="text-gradient">With</span>
          </span>
        </div>
        <h1 className="font-display text-5xl font-bold leading-[0.95] tracking-tightish sm:text-7xl">
          Learn any dance,
          <br />
          <span className="text-gradient italic">move by move.</span>
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink/60">
          Upload a dance tutorial and cut it into short moves. Each one loops on its own, slowed
          down and mirrored, so you learn one move at a time without ever touching play, pause, or
          rewind. When you have got it, test yourself on camera. It all runs on your device.
        </p>
      </header>

      {/* Two top-level actions: upload a tutorial, or test your skills on any dance you have */}
      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        <label
          onClick={() => { uploadIntentRef.current = 'practice' }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadIntentRef.current = 'practice'; importFile(e.dataTransfer.files?.[0]) }}
          className={[
            'group flex cursor-pointer flex-col items-center justify-center rounded-2.5xl border-2 border-dashed p-8 text-center transition-all duration-200 sm:col-span-2',
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

        <button
          onClick={() => setPickRate(true)}
          className="group flex flex-col items-center justify-center rounded-2.5xl border border-brand2/40 bg-brand2/[0.08] p-8 text-center shadow-soft transition hover:border-brand2/70 hover:bg-brand2/[0.14]"
        >
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand2/25 text-2xl transition-transform duration-200 group-hover:-translate-y-0.5">🎯</div>
          <p className="font-display text-base font-semibold">Test my skills</p>
          <p className="mt-1 text-xs text-ink/55">Dance any of your tutorials on camera and get scored, part by part.</p>
        </button>
      </div>

      {/* How it works — the actual flow, in order, so a first-timer knows what they're in for */}
      <section className="mb-10">
        <h2 className="mb-4 font-display text-sm font-medium uppercase tracking-[0.18em] text-ink/45">How it works</h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              n: '1',
              t: 'Add a dance video',
              d: 'Drop in any tutorial or dance clip from your phone or laptop. It stays on your device, nothing gets uploaded to a server.',
            },
            {
              n: '2',
              t: 'You cut it into moves',
              d: 'Play it through once and tap where each move ends (or let it auto-detect). Short segments you learn one at a time beat scrubbing one long video.',
            },
            {
              n: '3',
              t: 'Each move loops, hands-free',
              d: 'No more slowing the video down and jabbing play, pause, rewind. Every segment repeats on its own, as slow as you want and mirrored so it is easy to follow, until the move clicks.',
            },
            {
              n: '4',
              t: 'Then test yourself',
              d: 'Practice stays camera-free, just watch and drill. When you are ready, Test my skills turns on the camera, records you dancing to the music, scores each part, and plays your take back so you can see how you looked.',
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
          <p className="mx-auto mt-1 max-w-md text-sm text-ink/45">
            Upload a tutorial above and it shows up here to
            <span className="font-semibold text-ink/70"> ▶ Practice</span>. Scoring lives in
            <span className="font-semibold text-ink/70"> 🎯 Test my skills</span> at the top, which
            works on any dance you have uploaded.
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
            {/* Reports: shows up once this dance has been through Test my skills. */}
            {(reportsByTrack[t.id]?.length ?? 0) > 0 && (() => {
              const reports = reportsByTrack[t.id]!
              const best = reports.reduce((m, r) => Math.max(m, r.overall), 0)
              return (
                <button
                  onClick={() => setViewReports(t.id)}
                  className="mx-1 mt-2 flex items-center justify-between gap-2 rounded-xl border border-line bg-ink/[0.03] px-2.5 py-1.5 text-left transition hover:border-brand2/50"
                  title="See your Test my skills reports"
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-ink/60">
                    📊 {reports.length} {reports.length === 1 ? 'report' : 'reports'}
                  </span>
                  <span className="text-xs font-semibold" style={{ color: scoreColor(best) }}>
                    best {Math.round(best)}%
                  </span>
                </button>
              )
            })()}
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
                  <button onClick={() => void openTrack(t.id, 'practice')} className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-cream shadow-soft transition hover:brightness-105 active:scale-95">
                    ▶ Practice
                  </button>
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

      <footer className="mt-14 text-center text-xs text-ink/30">
        Your camera and your videos never leave your device. Only an anonymous count of visits and
        uploads is recorded.
      </footer>

      {/* Test my skills — pick which dance to be scored on (or upload one if there are none) */}
      {pickRate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setPickRate(false)}
        >
          <div className="w-full max-w-md rounded-2.5xl border border-line bg-panel p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="font-display text-lg font-bold">🎯 Test my skills</p>
              <button onClick={() => setPickRate(false)} className="text-sm text-ink/50 transition hover:text-ink">✕</button>
            </div>
            {scorable.length > 0 ? (
              <>
                <p className="mt-1 text-sm text-ink/55">Which dance do you want to be scored on?</p>
                <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                  {scorable.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => { setPickRate(false); void openTrack(t.id, 'rate') }}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-ink/[0.03] px-4 py-3 text-left transition hover:border-brand2/60 hover:bg-brand2/[0.08] active:scale-[0.99]"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-display text-sm font-semibold text-ink">{t.name}</span>
                        <span className="block text-xs text-ink/45">{Math.round(t.tempo.bpm)} BPM · {Math.round(t.source.durationSec)}s</span>
                      </span>
                      <span className="shrink-0 text-brand2">→</span>
                    </button>
                  ))}
                </div>
                <button
                  onClick={uploadForRating}
                  className="mt-3 w-full rounded-xl border border-dashed border-ink/25 px-4 py-2.5 text-sm font-medium text-ink/60 transition hover:border-ink/40 hover:text-ink"
                >
                  ↑ Upload a new dance
                </button>
              </>
            ) : (
              <>
                <p className="mt-1 text-sm text-ink/55">
                  You need a dance first: the scoring runs against a tutorial you have uploaded.
                </p>
                <button
                  onClick={uploadForRating}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-bold text-cream shadow-glow transition hover:brightness-105 active:scale-95"
                >
                  ↑ Upload a dance
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Reports history — every Test my skills run for one dance, newest first */}
      {viewReports && (reportsByTrack[viewReports]?.length ?? 0) > 0 && (
        <div
          onClick={() => setViewReports(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
        >
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2.5xl border border-line bg-panel p-5 shadow-soft">
            <div className="flex items-center justify-between">
              <p className="font-display text-lg font-bold">
                📊 {tracks.find((t) => t.id === viewReports)?.name ?? 'Reports'}
              </p>
              <button onClick={() => setViewReports(null)} className="text-sm text-ink/50 transition hover:text-ink">✕</button>
            </div>
            <p className="mt-1 text-xs text-ink/50">Every Test my skills run, newest first.</p>
            <div className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
              {reportsByTrack[viewReports]!.map((r, i) => (
                <div key={r.at + '-' + i} className="flex items-center gap-3 rounded-xl border border-line bg-ink/[0.03] px-3 py-2">
                  <span className="font-display text-2xl font-bold tabular-nums" style={{ color: scoreColor(r.overall) }}>
                    {Math.round(r.overall)}%
                  </span>
                  <span className="flex-1 text-xs text-ink/55">
                    {r.nailed} nailed · {r.close} close · {r.off} to work on
                  </span>
                  <span className="shrink-0 text-xs text-ink/40">{whenLabel(r.at, Date.now())}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
