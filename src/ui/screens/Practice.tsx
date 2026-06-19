import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'
import { PlaybackController } from '../../engine/playback'
import { PracticeEngine, type ReferenceContext } from '../../engine/practiceEngine'
import { startCamera, type CameraHandle } from '../../engine/camera'
import { VoiceController, type VoiceCommand } from '../../engine/voice'
import { getPoseProvider } from '../../providers/instance'
import { anglesAt, sectionAngles, nearestFrameIndex } from '../../core/reference/build'
import { scoreSection, type SectionScore } from '../../core/compare/score'
import { STRICT, LOOSE, type ScoreConfig, type Limb } from '../../core/compare/similarity'
import { drawSkeleton, worldProjector } from '../components/drawSkeleton'
import { AccuracyMeter } from '../components/AccuracyMeter'
import { SectionTimeline } from '../components/SectionTimeline'
import { Controls } from '../components/Controls'
import type { ReferenceTrack, DanceProgress } from '../../core/reference/types'

const PASS_THRESHOLD = 75
const RATE_STEPS = [0.5, 0.75, 1]

const VOICE_LABEL: Record<VoiceCommand, string> = {
  play: 'Play',
  pause: 'Pause',
  restart: 'Rewind',
  slower: 'Slower',
  faster: 'Faster',
  normalSpeed: 'Full speed',
  toggleLoop: 'Loop',
  toggleMirror: 'Mirror',
  next: 'Next 8-count',
  prev: 'Previous 8-count',
  toggleSkeleton: 'Skeleton',
}

function stepRate(current: number, dir: 1 | -1): number {
  const idx = RATE_STEPS.indexOf(current)
  const base = idx === -1 ? RATE_STEPS.length - 1 : idx
  return RATE_STEPS[Math.min(RATE_STEPS.length - 1, Math.max(0, base + dir))]!
}

const LIMB_TIP: Record<Limb, string> = {
  leftArm: 'Sharpen your left arm',
  rightArm: 'Sharpen your right arm',
  leftLeg: 'Watch your left leg',
  rightLeg: 'Watch your right leg',
  torso: 'Keep your torso aligned',
}

/** Project image-space landmarks (0..1 of the video frame) onto a canvas that overlays
 *  an `object-contain` video, accounting for the letterbox bars so the skeleton lines
 *  up with the dancer regardless of the clip's aspect ratio. */
function containProjector(videoW: number, videoH: number) {
  return (lm: { x: number; y: number }, w: number, h: number) => {
    if (!videoW || !videoH) return { x: lm.x * w, y: lm.y * h }
    const videoAspect = videoW / videoH
    const boxAspect = w / h
    let dispW: number
    let dispH: number
    let offX: number
    let offY: number
    if (videoAspect > boxAspect) {
      dispW = w
      dispH = w / videoAspect
      offX = 0
      offY = (h - dispH) / 2
    } else {
      dispH = h
      dispW = h * videoAspect
      offY = 0
      offX = (w - dispW) / 2
    }
    return { x: offX + lm.x * dispW, y: offY + lm.y * dispH }
  }
}

/** Match a canvas's backing store to its displayed size. Called only on resize (via a
 *  ResizeObserver) — never inside the draw loop, to avoid per-frame layout reads. */
function sizeCanvas(c: HTMLCanvasElement) {
  const rect = c.getBoundingClientRect()
  const w = Math.max(2, Math.round(rect.width))
  const h = Math.max(2, Math.round(rect.height))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
}

export function Practice() {
  const track = useSession((s) => s.activeTrack)!
  const videoUrl = useSession((s) => s.activeVideoUrl)
  const progress = useSession((s) => s.progress)
  const updateProgress = useSession((s) => s.updateProgress)
  const back = useSession((s) => s.back)

  // React UI state.
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [mirror, setMirror] = useState(false)
  const [looping, setLooping] = useState(true)
  const [activeIndex, setActiveIndex] = useState(0)
  const [meter, setMeter] = useState(0)
  const [camStatus, setCamStatus] = useState<'init' | 'ready' | 'error'>('init')
  const [camError, setCamError] = useState<string | null>(null)
  const [lastTake, setLastTake] = useState<SectionScore | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [noBody, setNoBody] = useState(false)
  // Draw the tracked skeleton on top of the real instructor video (uploads only).
  const [showSkeleton, setShowSkeleton] = useState(true)
  // Voice control.
  const [voiceOn, setVoiceOn] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<'listening' | 'stopped' | 'error'>('stopped')
  const [voiceErr, setVoiceErr] = useState<string | null>(null)
  const voiceSupported = useMemo(() => VoiceController.isSupported(), [])
  const voiceHandlerRef = useRef<(cmd: VoiceCommand) => void>(() => {})

  // Imperative refs (read inside rAF callbacks without re-subscribing).
  const instructorVideoRef = useRef<HTMLVideoElement>(null)
  const instructorCanvasRef = useRef<HTMLCanvasElement>(null)
  const instructorOverlayRef = useRef<HTMLCanvasElement>(null)
  const webcamVideoRef = useRef<HTMLVideoElement>(null)
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null)

  const playbackRef = useRef<PlaybackController | null>(null)
  const engineRef = useRef<PracticeEngine | null>(null)
  const trackRef = useRef<ReferenceTrack>(track)
  const progressRef = useRef<DanceProgress | null>(progress)
  const mirrorRef = useRef(mirror)
  const loopingRef = useRef(looping)
  const activeIndexRef = useRef(activeIndex)
  const cfgRef = useRef<ScoreConfig>(STRICT)
  const prevTimeRef = useRef(0)
  const meterThrottleRef = useRef(0)
  const countRef = useRef(0)
  const lastBodyMsRef = useRef(0)
  const noBodyShownRef = useRef(false)
  const showSkeletonRef = useRef(showSkeleton)
  useEffect(() => {
    showSkeletonRef.current = showSkeleton
    // Force one redraw so toggling updates immediately even while paused.
    const pb = playbackRef.current
    if (pb) pb.seek(pb.getTime())
  }, [showSkeleton])

  // Keep refs in sync with state/props.
  useEffect(() => void (trackRef.current = track), [track])
  useEffect(() => void (progressRef.current = progress), [progress])
  useEffect(() => void (mirrorRef.current = mirror), [mirror])
  useEffect(() => void (loopingRef.current = looping), [looping])
  useEffect(() => void (activeIndexRef.current = activeIndex), [activeIndex])

  // Difficulty: slow practice is forgiving, full speed is strict (per the plan).
  useEffect(() => {
    const cfg = rate < 1 ? LOOSE : STRICT
    cfgRef.current = cfg
    engineRef.current?.setConfig(cfg)
  }, [rate])

  // ---- Setup: playback controller + instructor drawing loop (runs once per track) ----
  useEffect(() => {
    const pb = new PlaybackController(track.source.durationSec)
    pb.attachVideo(videoUrl ? instructorVideoRef.current : null)
    playbackRef.current = pb

    // Start on the first section, looping it.
    const first = track.sections[0]
    if (first) pb.setLoop({ startSec: first.startSec, endSec: first.endSec })

    let lastDrawMs = 0
    const drawInstructor = (t: number) => {
      // The reference only changes at the source fps, so ~30fps redraw is plenty.
      const now = performance.now()
      if (now - lastDrawMs < 33) return
      lastDrawMs = now

      const i = nearestFrameIndex(track.frames, t)
      const frame = i >= 0 ? track.frames[i] : null

      if (videoUrl) {
        // Real video instructor: draw the tracked skeleton on top, aligned to the video.
        const canvas = instructorOverlayRef.current
        const video = instructorVideoRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        if (!showSkeletonRef.current || !frame?.image) {
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          return
        }
        drawSkeleton(ctx, frame.image, {
          project: containProjector(video?.videoWidth ?? 0, video?.videoHeight ?? 0),
          baseColor: 'rgba(155,140,255,0.92)',
          lineWidth: Math.max(2.5, canvas.width * 0.005),
          jointRadius: Math.max(2.5, canvas.width * 0.005),
        })
      } else {
        // Synthetic demo: the stick-figure ghost from world landmarks.
        const canvas = instructorCanvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        drawSkeleton(ctx, frame ? frame.world : null, {
          project: worldProjector,
          baseColor: '#9b8cff',
          lineWidth: Math.max(4, canvas.width * 0.008),
        })
      }
    }

    const unsub = pb.onTick((t) => {
      drawInstructor(t)

      // Live 8-count: which beat (1..8) of the active section are we on?
      const section = track.sections[activeIndexRef.current]
      let c = 0
      const bi = track.tempo.beatIntervalSec
      if (section && bi > 0 && t >= section.startSec) {
        c = (Math.floor((t - section.startSec) / bi) % 8) + 1
      }
      if (c !== countRef.current) {
        countRef.current = c
        setCount(c)
      }

      // Loop-wrap detection -> grade the take that just finished.
      const prev = prevTimeRef.current
      prevTimeRef.current = t
      if (loopingRef.current && prev > t + 0.08) {
        gradeActiveSection()
      }
    })

    drawInstructor(pb.getTime())
    return () => {
      unsub()
      pb.dispose()
      playbackRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, videoUrl])

  // ---- Setup: camera + pose engine + live overlay (runs once per track) ----
  useEffect(() => {
    let cam: CameraHandle | null = null
    let disposed = false

    const getReference = (): ReferenceContext => {
      const pb = playbackRef.current
      const tr = trackRef.current
      if (!pb) return { angles: null, mirror: mirrorRef.current }
      return { angles: anglesAt(tr, pb.getTime()), mirror: mirrorRef.current }
    }

    ;(async () => {
      try {
        const webcam = webcamVideoRef.current
        if (!webcam) return
        cam = await startCamera(webcam)
        // If we were torn down while awaiting (StrictMode/fast nav), stop the stream
        // we just opened — otherwise the camera light stays on after leaving.
        if (disposed) {
          cam.stop()
          return
        }
        const provider = await getPoseProvider()
        await provider.init()
        if (disposed) {
          cam.stop()
          return
        }

        const engine = new PracticeEngine({
          provider,
          webcam,
          getReference,
          config: cfgRef.current,
        })
        engineRef.current = engine

        engine.onResult((r) => {
          // Overlay (imperative — no React re-render at 30fps).
          const canvas = webcamCanvasRef.current
          if (canvas) {
            const ctx = canvas.getContext('2d')
            if (ctx) {
              drawSkeleton(ctx, r.liveImage, {
                perLimb: r.frame?.perLimb,
                minVisibility: 0.3,
                lineWidth: Math.max(3, canvas.width * 0.006),
              })
            }
          }
          // Throttle the meter to ~12/s.
          const now = performance.now()
          if (now - meterThrottleRef.current > 80) {
            meterThrottleRef.current = now
            setMeter(r.rollingScore)
          }
          // "Step into frame" hint when we haven't seen a body for a moment.
          if (r.bodyPresent) lastBodyMsRef.current = now
          const hint = now - lastBodyMsRef.current > 1200
          if (hint !== noBodyShownRef.current) {
            noBodyShownRef.current = hint
            setNoBody(hint)
          }
        })

        lastBodyMsRef.current = performance.now()
        engine.start()
        engine.startRecording()
        setCamStatus('ready')
      } catch (e) {
        if (disposed) return
        setCamStatus('error')
        setCamError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      engineRef.current?.stop()
      engineRef.current = null
      cam?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id])

  // Spacebar = play/pause (a natural shortcut while dancing away from the keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      e.preventDefault()
      const pb = playbackRef.current
      if (!pb) return
      pb.toggle()
      setPlaying(pb.isPlaying)
      if (pb.isPlaying) {
        prevTimeRef.current = pb.getTime()
        engineRef.current?.startRecording()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Size the canvases to their displayed box once, and only again on resize — so the
  // 30–60fps draw loops never touch layout (getBoundingClientRect) themselves.
  useEffect(() => {
    const canvases = [
      instructorCanvasRef.current,
      instructorOverlayRef.current,
      webcamCanvasRef.current,
    ].filter((c): c is HTMLCanvasElement => c != null)
    if (canvases.length === 0) return
    canvases.forEach(sizeCanvas)
    const ro = new ResizeObserver(() => canvases.forEach(sizeCanvas))
    canvases.forEach((c) => ro.observe(c))
    return () => ro.disconnect()
  }, [videoUrl, camStatus])

  // Grade the take just recorded for the active section, update best + unlock.
  function gradeActiveSection() {
    const eng = engineRef.current
    const tr = trackRef.current
    if (!eng || !tr) return
    const take = eng.stopRecording()
    eng.startRecording() // immediately begin capturing the next pass
    const idx = activeIndexRef.current
    const section = tr.sections[idx]
    if (!section || take.length < 3) return
    const refAngles = sectionAngles(tr, section.startSec, section.endSec)
    if (refAngles.length < 2) return

    const result = scoreSection(refAngles, take, cfgRef.current)
    setLastTake(result)
    applyResult(idx, result.score)
  }

  function applyResult(index: number, score: number) {
    const prog: DanceProgress =
      progressRef.current ?? { trackId: track.id, bestSectionScores: {}, unlockedThrough: 0 }
    const prevBest = prog.bestSectionScores[index] ?? 0
    const best = Math.max(prevBest, score)
    const bestSectionScores = { ...prog.bestSectionScores, [index]: best }
    let unlockedThrough = prog.unlockedThrough
    if (best >= PASS_THRESHOLD && index === unlockedThrough && index < track.sections.length - 1) {
      unlockedThrough = index + 1
      const nextLabel = track.sections[unlockedThrough]?.label ?? 'next section'
      flashToast(`🎉 Nice! ${nextLabel} unlocked`)
    }
    void updateProgress({ ...prog, bestSectionScores, unlockedThrough })
  }

  function flashToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2600)
  }

  // ---- Control handlers ----
  function togglePlay() {
    const pb = playbackRef.current
    if (!pb) return
    pb.toggle()
    setPlaying(pb.isPlaying)
    if (pb.isPlaying) {
      prevTimeRef.current = pb.getTime()
      engineRef.current?.startRecording()
    }
  }

  function selectSection(index: number) {
    const pb = playbackRef.current
    const section = track.sections[index]
    if (!pb || !section) return
    setActiveIndex(index)
    activeIndexRef.current = index
    setLastTake(null)
    pb.setLoop(loopingRef.current ? { startSec: section.startSec, endSec: section.endSec } : null)
    pb.seek(section.startSec)
    prevTimeRef.current = section.startSec
    engineRef.current?.startRecording()
  }

  function changeRate(r: number) {
    setRate(r)
    playbackRef.current?.setRate(r)
  }

  function toggleMirror() {
    setMirror((m) => !m)
  }

  function toggleLoop() {
    setLooping((prev) => {
      const next = !prev
      const pb = playbackRef.current
      const section = track.sections[activeIndexRef.current]
      if (pb && section) pb.setLoop(next ? { startSec: section.startSec, endSec: section.endSec } : null)
      return next
    })
  }

  function restart() {
    const section = track.sections[activeIndexRef.current]
    const pb = playbackRef.current
    if (pb && section) {
      pb.seek(section.startSec)
      prevTimeRef.current = section.startSec
      engineRef.current?.startRecording()
    }
  }

  // Map a recognized voice command to an action. Reassigned every render so it always
  // sees the latest state; the controller invokes it through voiceHandlerRef.
  voiceHandlerRef.current = (cmd: VoiceCommand) => {
    const pb = playbackRef.current
    switch (cmd) {
      case 'play':
        if (pb && !pb.isPlaying) {
          pb.play()
          setPlaying(true)
          prevTimeRef.current = pb.getTime()
          engineRef.current?.startRecording()
        }
        break
      case 'pause':
        if (pb && pb.isPlaying) {
          pb.pause()
          setPlaying(false)
        }
        break
      case 'restart':
        restart()
        break
      case 'slower':
        changeRate(stepRate(rate, -1))
        break
      case 'faster':
        changeRate(stepRate(rate, 1))
        break
      case 'normalSpeed':
        changeRate(1)
        break
      case 'toggleLoop':
        toggleLoop()
        break
      case 'toggleMirror':
        toggleMirror()
        break
      case 'toggleSkeleton':
        setShowSkeleton((s) => !s)
        break
      case 'next': {
        const i = activeIndexRef.current
        const maxUnlocked = progressRef.current?.unlockedThrough ?? 0
        if (i + 1 < track.sections.length && i + 1 <= maxUnlocked) selectSection(i + 1)
        break
      }
      case 'prev': {
        const i = activeIndexRef.current
        if (i - 1 >= 0) selectSection(i - 1)
        break
      }
    }
  }

  // Start/stop voice recognition when toggled on.
  useEffect(() => {
    if (!voiceOn) return
    const vc = new VoiceController({
      onCommand: (cmd) => {
        voiceHandlerRef.current(cmd)
        flashToast(`🎙 ${VOICE_LABEL[cmd]}`)
      },
      onStatus: (s, detail) => {
        setVoiceStatus(s)
        if (s === 'error') {
          setVoiceErr(detail ?? 'Voice error')
          setVoiceOn(false)
        }
      },
    })
    vc.start()
    return () => vc.stop()
  }, [voiceOn])

  const passedCount = track.sections.filter(
    (s) => (progress?.bestSectionScores[s.index] ?? 0) >= PASS_THRESHOLD,
  ).length

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-4 sm:p-6">
      {/* Header */}
      <header className="flex items-center justify-between gap-3">
        <button
          onClick={back}
          className="rounded-xl border border-line bg-white/5 px-3.5 py-2 text-sm text-white/75 transition hover:border-white/25 hover:text-white"
        >
          ← Library
        </button>
        <div className="min-w-0 text-center">
          <h1 className="truncate font-display text-lg font-semibold tracking-tightish">{track.name}</h1>
          <p className="text-xs text-white/45">
            {passedCount}/{track.sections.length} mastered · {Math.round(track.tempo.bpm)} BPM
          </p>
        </div>
        {/* Mastery progress dots — a small, deliberate status cue. */}
        <div className="flex w-[84px] justify-end gap-1.5">
          {track.sections.map((s) => {
            const passed = (progress?.bestSectionScores[s.index] ?? 0) >= PASS_THRESHOLD
            return (
              <span
                key={s.index}
                className={`h-1.5 w-1.5 rounded-full ${passed ? 'bg-good' : 'bg-white/20'}`}
              />
            )
          })}
        </div>
      </header>

      {/* Stages */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Instructor */}
        <section className="relative aspect-video overflow-hidden rounded-2.5xl border border-line bg-black/50 shadow-soft">
          <span className="absolute left-3 top-3 z-10 rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-white/70 backdrop-blur">
            Instructor
          </span>
          {/* Live 8-count so you always know where you are in the phrase. */}
          {playing && count > 0 && (
            <span className="absolute right-3 top-3 z-10 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand2 font-display text-2xl font-bold tabular-nums text-white shadow-glow">
              {count}
            </span>
          )}
          {videoUrl ? (
            <>
              <video ref={instructorVideoRef} src={videoUrl} className="h-full w-full object-contain" playsInline />
              <canvas ref={instructorOverlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
              <button
                onClick={() => setShowSkeleton((s) => !s)}
                title="Show or hide the tracked skeleton on the instructor"
                className="absolute bottom-3 right-3 z-10 rounded-lg border border-line bg-black/45 px-2.5 py-1.5 text-xs font-medium text-white/80 backdrop-blur transition hover:border-white/30"
              >
                {showSkeleton ? '🦴 Skeleton on' : '🦴 Skeleton off'}
              </button>
            </>
          ) : (
            <canvas ref={instructorCanvasRef} className="h-full w-full" />
          )}
        </section>

        {/* You */}
        <section className="relative aspect-video overflow-hidden rounded-2.5xl border border-line bg-black/50 shadow-soft">
          <span className="absolute left-3 top-3 z-10 rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-white/70 backdrop-blur">
            You
          </span>
          <div className="mirror absolute inset-0">
            <video ref={webcamVideoRef} className="h-full w-full object-cover" playsInline muted />
            <canvas ref={webcamCanvasRef} className="absolute inset-0 h-full w-full" />
          </div>

          {camStatus !== 'ready' && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center">
              {camStatus === 'init' ? (
                <>
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  <p className="text-sm text-white/70">Starting camera & loading the AI model…</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-bad">Camera unavailable</p>
                  <p className="max-w-xs text-xs text-white/60">{camError}</p>
                </>
              )}
            </div>
          )}

          {camStatus === 'ready' && noBody && (
            <div className="absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 px-4 text-center">
              <span className="rounded-full bg-black/60 px-3 py-1.5 text-sm text-warn">
                Step back so your whole body is in frame
              </span>
            </div>
          )}

          <div className="absolute inset-x-3 bottom-3 z-10">
            <AccuracyMeter score={meter} compact label="Live match" />
          </div>
        </section>
      </div>

      {/* Coaching line */}
      <div className="flex min-h-[28px] items-center justify-center gap-3 text-sm">
        {toast ? (
          <span className="rounded-full bg-good/20 px-3 py-1 font-semibold text-good">{toast}</span>
        ) : lastTake ? (
          <span className="text-white/70">
            Last take:{' '}
            <b style={{ color: lastTake.score >= PASS_THRESHOLD ? '#36d399' : '#ffb547' }}>
              {Math.round(lastTake.score)}%
            </b>
            {lastTake.score < PASS_THRESHOLD && lastTake.worstLimb && (
              <span className="text-white/50"> · {LIMB_TIP[lastTake.worstLimb]}</span>
            )}
          </span>
        ) : (
          <span className="text-white/40">Press play and follow along. Loop a section until it turns green.</span>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Controls
          playing={playing}
          rate={rate}
          mirror={mirror}
          looping={looping}
          onTogglePlay={togglePlay}
          onRate={changeRate}
          onToggleMirror={toggleMirror}
          onToggleLoop={toggleLoop}
          onRestart={restart}
        />
        <span className="mx-1 hidden h-6 w-px bg-white/10 sm:block" />
        <button
          onClick={() => {
            if (!voiceSupported) {
              setVoiceErr('Voice control needs Chrome or Edge.')
              return
            }
            setVoiceErr(null)
            setVoiceOn((v) => !v)
          }}
          title="Hands-free control. Say: pause, rewind, slower, faster, loop, mirror, next"
          className={[
            'flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition active:scale-95',
            voiceOn && voiceStatus === 'listening'
              ? 'border-brand2/60 bg-brand2/20 text-white shadow-glowpink'
              : 'border-line bg-white/5 text-white/65 hover:border-white/25 hover:text-white',
            !voiceSupported ? 'opacity-50' : '',
          ].join(' ')}
        >
          <span
            className={
              voiceOn && voiceStatus === 'listening'
                ? 'h-2 w-2 animate-pulse rounded-full bg-brand2'
                : 'h-2 w-2 rounded-full bg-white/30'
            }
          />
          {voiceOn ? 'Listening' : '🎙 Voice'}
        </button>
      </div>

      {/* Voice status / hint */}
      {voiceErr ? (
        <p className="text-xs text-bad/80">{voiceErr}</p>
      ) : voiceOn && voiceStatus === 'listening' ? (
        <p className="text-xs text-white/40">
          Listening. Try “pause”, “rewind”, “slower”, “loop”, “next”.
        </p>
      ) : null}

      {/* Timeline */}
      <div>
        <h2 className="mb-3 font-display text-xs font-medium uppercase tracking-[0.18em] text-white/40">
          Step by step
        </h2>
        <SectionTimeline
          sections={track.sections}
          activeIndex={activeIndex}
          unlockedThrough={progress?.unlockedThrough ?? 0}
          bestScores={progress?.bestSectionScores ?? {}}
          passThreshold={PASS_THRESHOLD}
          onSelect={selectSection}
        />
      </div>
    </div>
  )
}
