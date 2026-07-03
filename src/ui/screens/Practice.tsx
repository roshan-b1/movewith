import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'
import { PlaybackController } from '../../engine/playback'
import { PracticeEngine, type ReferenceContext } from '../../engine/practiceEngine'
import { startCamera, listVideoInputs, preferredCameraId, type CameraHandle } from '../../engine/camera'
import { getPoseProvider } from '../../providers/instance'
import { anglesAt, sectionAngles, nearestFrameIndex } from '../../core/reference/build'
import { scoreSection, type SectionScore } from '../../core/compare/score'
import { STRICT, LOOSE, type ScoreConfig, type Limb } from '../../core/compare/similarity'
import type { Section } from '../../core/audio/beats'
import {
  type Move,
  buildMovesFromBounds,
  evenMoveBounds,
  autoMoveBounds,
} from '../../core/reference/segment'
import { VoiceController, type VoiceCommand } from '../../engine/voice'
import { drawSkeleton, drawHumanFigure, worldProjector, containProjector } from '../components/drawSkeleton'
import { InstructorAvatar, type AvatarStatus } from '../avatar/InstructorAvatar'
import { AccuracyMeter } from '../components/AccuracyMeter'
import { Scrubber } from '../components/Scrubber'
import { MoveEditor } from '../components/MoveEditor'
import { SegmentBar } from '../components/SegmentBar'
import type { ReferenceTrack } from '../../core/reference/types'

const PASS_THRESHOLD = 75
const RATE_STEPS = [0.5, 0.75, 1]
const LIMB_TIP: Record<Limb, string> = {
  leftArm: 'Sharpen your left arm', rightArm: 'Sharpen your right arm',
  leftLeg: 'Watch your left leg', rightLeg: 'Watch your right leg', torso: 'Keep your torso aligned',
}
const VOICE_LABEL: Record<VoiceCommand, string> = {
  play: 'Play', pause: 'Pause', restart: 'Restart', slower: 'Slower', faster: 'Faster',
  normalSpeed: 'Full speed', toggleLoop: 'Loop', toggleMirror: 'Mirror', next: 'Next', prev: 'Previous', toggleSkeleton: 'Skeleton',
}
function stepRate(cur: number, dir: 1 | -1) {
  const i = RATE_STEPS.indexOf(cur)
  const b = i === -1 ? RATE_STEPS.length - 1 : i
  return RATE_STEPS[Math.min(RATE_STEPS.length - 1, Math.max(0, b + dir))]!
}
function sizeCanvas(c: HTMLCanvasElement) {
  const r = c.getBoundingClientRect()
  const w = Math.max(2, Math.round(r.width))
  const h = Math.max(2, Math.round(r.height))
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
}
// Move size choices: the target length per chunk that auto-detection aims for. Each chunk
// then ends on the nearest pause/hold in the dance, so it stops between steps not mid-move.
const MOVE_SIZES = [
  { label: '~5s', sec: 5 },
  { label: '~8s', sec: 8 },
  { label: '~10s', sec: 10 },
] as const

// Move boundaries as tick marks for the scrubber.
function moveTicks(moves: Move[]): Section[] {
  return moves.map((m) => ({ index: m.index, label: '', startSec: m.startSec, endSec: m.endSec, startBeat: 0 }))
}

export function Practice() {
  const track = useSession((s) => s.activeTrack)!
  const videoUrl = useSession((s) => s.activeVideoUrl)
  const back = useSession((s) => s.back)
  const updateProgress = useSession((s) => s.updateProgress)

  const duration = track.source.durationSec
  const playbackOnly = track.frames.length === 0

  // Restore the dancer's saved trim + segments + settings for this track, if any.
  const savedSetup = useSession.getState().progress?.setup

  // ---- setup choices (made before practice) ----
  const [phase, setPhase] = useState<'setup' | 'bounds' | 'go'>('setup')
  const [moveSec, setMoveSec] = useState<number>(savedSetup?.moveSec ?? 8)
  const [reps, setReps] = useState<number>(savedSetup?.reps ?? Infinity)
  const [breakSecs, setBreakSecs] = useState<number>(savedSetup?.breakSecs ?? 3)
  const [cameraOn, setCameraOn] = useState(savedSetup?.cameraOn ?? false)
  const scoring = cameraOn && !playbackOnly && phase === 'go'
  const [completed, setCompleted] = useState<number[]>([])
  const [skip, setSkip] = useState<number[]>(savedSetup?.skip ?? [])
  const [countdown, setCountdown] = useState(0)
  const [countdownLabel, setCountdownLabel] = useState('Replaying in')

  // ---- runtime ----
  const [trimStart, setTrimStart] = useState(savedSetup?.trimStart ?? 0)
  const [trimEnd, setTrimEnd] = useState(savedSetup?.trimEnd ?? duration)
  // Internal cut times between segments. Restored from save, else placed by the user.
  const [moveBounds, setMoveBounds] = useState<number[]>(savedSetup?.moveBounds ?? [])
  const [moveIdx, setMoveIdx] = useState(0)
  const [fullRun, setFullRun] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [mirror, setMirror] = useState(false)
  const [previewIdx, setPreviewIdx] = useState(-1) // segment being loop-previewed in the editor
  const [creating, setCreating] = useState(false) // segment-creator mode (tap to place cuts)
  const [meter, setMeter] = useState(0)
  const [camStatus, setCamStatus] = useState<'init' | 'ready' | 'error'>('init')
  const [camError, setCamError] = useState<string | null>(null)
  const [noBody, setNoBody] = useState(false)
  const [lastTake, setLastTake] = useState<SectionScore | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [activeCam, setActiveCam] = useState<string | null>(null)
  const [voiceOn, setVoiceOn] = useState(false)
  const voiceSupported = useMemo(() => VoiceController.isSupported(), [])
  // 3D dancer: on by default; falls back to the classic 2D drawing if the model fails.
  const [avatar3d, setAvatar3d] = useState(true)
  const [avatarStatus, setAvatarStatus] = useState<AvatarStatus>('loading')

  const moves = useMemo(() => buildMovesFromBounds(trimStart, trimEnd, moveBounds), [trimStart, trimEnd, moveBounds])
  const ticks = useMemo(() => moveTicks(moves), [moves])

  // refs
  const instructorVideoRef = useRef<HTMLVideoElement | null>(null)
  const instructorCanvasRef = useRef<HTMLCanvasElement>(null)
  const instructorOverlayRef = useRef<HTMLCanvasElement>(null)
  const avatarCanvasRef = useRef<HTMLCanvasElement>(null)
  const avatarRef = useRef<InstructorAvatar | null>(null)
  // Driven imperatively from the playback tick so the whole screen doesn't re-render 60×/s.
  const scrubPlayheadRef = useRef<HTMLDivElement>(null)
  const moveEditorPlayheadRef = useRef<HTMLDivElement>(null)
  const phaseRef = useRef(phase)
  const webcamVideoRef = useRef<HTMLVideoElement>(null)
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null)
  const playbackRef = useRef<PlaybackController | null>(null)
  const engineRef = useRef<PracticeEngine | null>(null)
  const camRef = useRef<CameraHandle | null>(null)
  const trackRef = useRef<ReferenceTrack>(track)
  const mirrorRef = useRef(mirror)
  const movesRef = useRef<Move[]>(moves)
  const moveIdxRef = useRef(0)
  const trimStartRef = useRef(0)
  const trimEndRef = useRef(duration)
  const creatingRef = useRef(false)
  const fullRunRef = useRef(false)
  const segmentBeforeFullRef = useRef(0)
  const skipRef = useRef<number[]>(skip)
  const loopStartRef = useRef(0)
  const loopEndRef = useRef(duration)
  const cfgRef = useRef<ScoreConfig>(STRICT)
  const prevTimeRef = useRef(0)
  const lastSeekMsRef = useRef(0)
  const awaitingSeekRef = useRef<number | null>(null)
  const meterThrottleRef = useRef(0)
  const lastBodyMsRef = useRef(0)
  const noBodyShownRef = useRef(false)
  const repCounterRef = useRef(0)
  const repsRef = useRef(reps)
  const breakRef = useRef(breakSecs)
  const rateRef = useRef(rate)
  const scoringRef = useRef(scoring)
  const completedRef = useRef<number[]>([])
  const countdownTimerRef = useRef<number | null>(null)
  const voiceHandlerRef = useRef<(c: VoiceCommand) => void>(() => {})
  useEffect(() => void (completedRef.current = completed), [completed])

  useEffect(() => void (trackRef.current = track), [track])
  useEffect(() => {
    mirrorRef.current = mirror
    // Force an instructor redraw so the flip shows immediately, even while paused.
    const pb = playbackRef.current
    if (pb) pb.seek(pb.getTime())
  }, [mirror])
  useEffect(() => void (phaseRef.current = phase), [phase])
  // Toggling the 3D dancer swaps render paths — force a redraw so it shows while paused.
  useEffect(() => {
    const pb = playbackRef.current
    if (pb) pb.seek(pb.getTime())
  }, [avatar3d])
  useEffect(() => { trimStartRef.current = trimStart; trimEndRef.current = trimEnd }, [trimStart, trimEnd])
  // Keep skip state + the controller's skip ranges (for full-song playback) in sync.
  useEffect(() => {
    skipRef.current = skip
    const ranges = moves.filter((m) => skip.includes(m.index)).map((m) => [m.startSec, m.endSec] as [number, number])
    playbackRef.current?.setSkipRanges(ranges)
  }, [skip, moves])

  // Persist the dancer's trim + segments + settings for this track (debounced) so they're
  // restored on next open. Skips the very first render (nothing changed yet).
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return }
    const id = window.setTimeout(() => {
      const cur = useSession.getState().progress
      const base = cur ?? { trackId: track.id, bestSectionScores: {}, unlockedThrough: 0 }
      void updateProgress({ ...base, setup: { trimStart, trimEnd, moveBounds, moveSec, reps, breakSecs, cameraOn, skip } })
    }, 500)
    return () => window.clearTimeout(id)
  }, [trimStart, trimEnd, moveBounds, moveSec, reps, breakSecs, cameraOn, skip, track.id, updateProgress])
  useEffect(() => void (creatingRef.current = creating), [creating])
  useEffect(() => void (movesRef.current = moves), [moves])
  useEffect(() => void (moveIdxRef.current = moveIdx), [moveIdx])
  useEffect(() => void (repsRef.current = reps), [reps])
  useEffect(() => void (breakRef.current = breakSecs), [breakSecs])
  useEffect(() => void (scoringRef.current = scoring), [scoring])
  useEffect(() => {
    rateRef.current = rate
    const cfg = rate < 1 ? LOOSE : STRICT
    cfgRef.current = cfg
    engineRef.current?.setConfig(cfg)
  }, [rate])

  // When to show the rigged 3D dancer: whenever there are landmark frames to drive it.
  // Demo routine: always (it replaces the old geometric silhouette). Uploaded videos: during
  // practice, when the dancer toggle is on (the real video stays for segment editing).
  // If the model ever fails to load we quietly fall back to the classic 2D drawing.
  const hasFrames = track.frames.length > 0
  const showAvatar =
    hasFrames && avatarStatus !== 'error' && (videoUrl ? phase === 'go' && avatar3d : phase !== 'setup')

  // 3D dancer lifecycle: create it when its canvas is on screen, tear down when hidden.
  useEffect(() => {
    if (!showAvatar) return
    const canvas = avatarCanvasRef.current
    if (!canvas) return
    const inst = new InstructorAvatar(canvas, (s) => {
      setAvatarStatus(s)
      if (s === 'ready') {
        // Push the current frame so the dancer strikes the right pose even while paused.
        const pb = playbackRef.current
        if (pb) pb.seek(pb.getTime())
      }
    })
    avatarRef.current = inst
    return () => { avatarRef.current = null; inst.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAvatar, track.id])

  // Playback + instructor draw loop
  useEffect(() => {
    const pb = new PlaybackController(duration)
    pb.attachVideo(videoUrl ? instructorVideoRef.current : null)
    playbackRef.current = pb
    pb.setLoop({ startSec: 0, endSec: duration })
    // Seed skip ranges from restored state (the skip-sync effect runs before this on mount).
    pb.setSkipRanges(movesRef.current.filter((m) => skipRef.current.includes(m.index)).map((m) => [m.startSec, m.endSec] as [number, number]))
    // Keep the play/pause button in sync with what the video actually does (autoplay
    // can be blocked, which would otherwise leave the button stuck showing "Pause").
    const unsubPlay = pb.onPlayingChange((p) => setPlaying(p))

    let lastDrawMs = 0
    const drawInstructor = (t: number) => {
      const now = performance.now()
      if (now - lastDrawMs < 33) return
      lastDrawMs = now
      const i = nearestFrameIndex(track.frames, t)
      const frame = (i >= 0 ? track.frames[i] : null) ?? null
      // 3D dancer active: feed it the frame (mirror is a CSS flip on its canvas) and keep
      // the 2D layers clean so nothing stale shows when toggling back.
      const avatar = avatarRef.current
      if (avatar) {
        avatar.setFrame(frame)
        const overlay = instructorOverlayRef.current
        if (overlay) overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
        return
      }
      if (videoUrl) {
        const canvas = instructorOverlayRef.current
        const video = instructorVideoRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const w = canvas.width, h = canvas.height
        const mir = mirrorRef.current
        const vw = video?.videoWidth ?? 0
        const vh = video?.videoHeight ?? 0
        ctx.clearRect(0, 0, w, h)
        ctx.save()
        if (mir) { ctx.translate(w, 0); ctx.scale(-1, 1) }
        // When mirrored, paint the (flipped) video onto the canvas — we never CSS-transform
        // the <video> element itself, which is what tore into a split-screen on Windows.
        if (mir && video && vw && vh) {
          const va = vw / vh, ba = w / h
          let dw: number, dh: number, ox: number, oy: number
          if (va > ba) { dw = w; dh = w / va; ox = 0; oy = (h - dh) / 2 }
          else { dh = h; dw = h * va; oy = 0; ox = (w - dw) / 2 }
          try { ctx.drawImage(video, ox, oy, dw, dh) } catch { /* not ready yet */ }
        }
        if (frame?.image) {
          drawSkeleton(ctx, frame.image, {
            project: containProjector(vw, vh),
            baseColor: 'rgba(34,211,238,0.95)',
            lineWidth: Math.max(2.5, w * 0.005),
            jointRadius: Math.max(2.5, w * 0.005),
          })
        }
        ctx.restore()
      } else {
        const canvas = instructorCanvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.save()
        if (mirrorRef.current) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1) }
        drawHumanFigure(ctx, frame ? frame.world : null, { project: worldProjector })
        ctx.restore()
      }
    }

    let lastHeadMs = 0
    const unsub = pb.onTick((t) => {
      drawInstructor(t)
      const now = performance.now()
      // Move the playheads by touching the DOM directly (cheap) instead of setState
      // (which would re-render the whole Practice tree every frame = the lag).
      if (now - lastHeadMs > 33) {
        lastHeadMs = now
        const sc = scrubPlayheadRef.current
        if (sc) sc.style.left = `${duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0}%`
        const me = moveEditorPlayheadRef.current
        if (me) {
          const sp = Math.max(0.001, trimEndRef.current - trimStartRef.current)
          me.style.left = `${Math.min(100, Math.max(0, ((t - trimStartRef.current) / sp) * 100))}%`
        }
      }

      const prev = prevTimeRef.current
      prevTimeRef.current = t
      // After a deliberate seek (Repeat, tapping a segment, scrubbing) the real <video> seek
      // is async and reads stale positions, so the time jumps backward — which would look
      // like a loop wrap and falsely fire the break while it's actually playing. Suppress
      // wrap detection until the playhead actually reaches the seek target (or 1.5s fallback).
      const seekTarget = awaitingSeekRef.current
      if (seekTarget !== null) {
        if (Math.abs(t - seekTarget) < 0.35 || now - lastSeekMsRef.current > 1500) awaitingSeekRef.current = null
      } else if (prev > t + 0.08 && phaseRef.current === 'go' && !fullRunRef.current) {
        if (scoringRef.current) gradeLoop()
        repCounterRef.current += 1
        const reachedLimit = repsRef.current !== Infinity && repCounterRef.current >= repsRef.current
        pb.pause()
        if (reachedLimit) {
          repCounterRef.current = 0
          flashToast('Done · ✓ got it, or ↻ repeat')
        } else {
          // Wait the break, then resume from the loop start (already there — no re-seek,
          // which could otherwise interrupt play() and leave it stuck paused).
          runCountdown(() => {
            const p = playbackRef.current
            if (!p) return
            prevTimeRef.current = loopStartRef.current
            engineRef.current?.startRecording()
            p.play()
          })
        }
      } else if (prev > t + 0.08 && phaseRef.current === 'go' && fullRunRef.current && scoringRef.current) {
        gradeLoop()
      }
    })

    drawInstructor(pb.getTime())
    return () => { unsub(); unsubPlay(); pb.dispose(); playbackRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, videoUrl])

  // Attach the <video> to the playback controller the moment it mounts (it doesn't exist
  // on the setup screen). Without this the controller stays in virtual mode and the real
  // video never plays. Stable callback so React doesn't detach/reattach every render.
  const attachInstructorVideo = useCallback((el: HTMLVideoElement | null) => {
    instructorVideoRef.current = el
    if (el && playbackRef.current) {
      playbackRef.current.attachVideo(el)
      playbackRef.current.setRate(rateRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Camera (+ engine when scoring), once started
  useEffect(() => {
    if (!cameraOn || phase !== 'go') return
    let cam: CameraHandle | null = null
    let disposed = false
    const getReference = (): ReferenceContext => {
      const pb = playbackRef.current
      if (!pb) return { angles: null, mirror: mirrorRef.current }
      return { angles: anglesAt(trackRef.current, pb.getTime()), mirror: mirrorRef.current }
    }
    setCamStatus('init')
    ;(async () => {
      try {
        const webcam = webcamVideoRef.current
        if (!webcam) return
        const saved = localStorage.getItem('movewith.cameraId') || undefined
        try { cam = await startCamera(webcam, saved) } catch { cam = await startCamera(webcam) }
        if (disposed) return cam.stop()
        camRef.current = cam
        setActiveCam(cam.deviceId)
        const inputs = await listVideoInputs()
        if (!disposed) {
          setCameras(inputs)
          if (!saved) {
            const better = preferredCameraId(inputs, cam.deviceId)
            if (better) { cam.stop(); cam = await startCamera(webcam, better); camRef.current = cam; setActiveCam(cam.deviceId) }
          }
        }
        if (!scoringRef.current) { setCamStatus('ready'); return }
        const provider = await getPoseProvider()
        await provider.init()
        if (disposed) return cam.stop()
        const engine = new PracticeEngine({ provider, webcam, getReference, config: cfgRef.current })
        engineRef.current = engine
        engine.onResult((r) => {
          const canvas = webcamCanvasRef.current
          if (canvas) {
            const ctx = canvas.getContext('2d')
            if (ctx) drawSkeleton(ctx, r.liveImage, { perLimb: r.frame?.perLimb, minVisibility: 0.3, lineWidth: Math.max(2, canvas.width * 0.012) })
          }
          const now = performance.now()
          if (now - meterThrottleRef.current > 250) { meterThrottleRef.current = now; setMeter(r.rollingScore) }
          if (r.bodyPresent) lastBodyMsRef.current = now
          const hint = now - lastBodyMsRef.current > 1200
          if (hint !== noBodyShownRef.current) { noBodyShownRef.current = hint; setNoBody(hint) }
        })
        lastBodyMsRef.current = performance.now()
        engine.start(); engine.startRecording()
        setCamStatus('ready')
      } catch (e) {
        if (disposed) return
        setCamStatus('error')
        setCamError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      disposed = true
      engineRef.current?.stop(); engineRef.current = null
      ;(camRef.current ?? cam)?.stop(); camRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, cameraOn, playbackOnly, phase])

  useEffect(() => {
    const cs = [instructorCanvasRef.current, instructorOverlayRef.current, webcamCanvasRef.current].filter(
      (c): c is HTMLCanvasElement => c != null,
    )
    if (cs.length === 0) return
    cs.forEach(sizeCanvas)
    const ro = new ResizeObserver(() => cs.forEach(sizeCanvas))
    cs.forEach((c) => ro.observe(c))
    return () => ro.disconnect()
  }, [videoUrl, cameraOn, camStatus, phase])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || phase !== 'go') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Pause when the tab is hidden. The browser suspends requestAnimationFrame while hidden,
  // so the segment-loop logic stops but the <video> keeps playing — which would otherwise
  // run straight past the segment through the whole song. Pause like a video player does.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) return
      playbackRef.current?.pause()
      if (countdownTimerRef.current) { window.clearTimeout(countdownTimerRef.current); countdownTimerRef.current = null }
      setCountdown(0)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  useEffect(() => {
    if (!voiceOn) return
    const vc = new VoiceController({
      onCommand: (cmd) => { voiceHandlerRef.current(cmd); flashToast(`🎙 ${VOICE_LABEL[cmd]}`) },
      onStatus: (s) => { if (s === 'error') setVoiceOn(false) },
    })
    vc.start()
    return () => vc.stop()
  }, [voiceOn])

  function gradeLoop() {
    const eng = engineRef.current
    const tr = trackRef.current
    if (!eng || !tr) return
    const take = eng.stopRecording()
    eng.startRecording()
    if (take.length < 3) return
    const refAngles = sectionAngles(tr, loopStartRef.current, loopEndRef.current)
    if (refAngles.length < 2) return
    setLastTake(scoreSection(refAngles, take, cfgRef.current))
  }
  function flashToast(msg: string) { setToast(msg); window.setTimeout(() => setToast(null), 2400) }

  function clearCountdown() {
    if (countdownTimerRef.current) { window.clearTimeout(countdownTimerRef.current); countdownTimerRef.current = null }
    setCountdown(0)
  }
  // The break before playback resumes. `label` reads "Replaying in" for a loop repeat or
  // "Playing next segment in" after Got it. Length is the user's break setting (0 = none).
  function runCountdown(after: () => void, label = 'Replaying in', seconds = breakRef.current) {
    clearCountdown()
    const total = seconds
    if (total <= 0) { after(); return }
    setCountdownLabel(label)
    let n = total
    setCountdown(n)
    const tick = () => {
      n -= 1
      if (n <= 0) { setCountdown(0); countdownTimerRef.current = null; after() }
      else { setCountdown(n); countdownTimerRef.current = window.setTimeout(tick, 1000) }
    }
    countdownTimerRef.current = window.setTimeout(tick, 1000)
  }

  function setLoopRegion(s: number, e: number) {
    const pb = playbackRef.current
    if (!pb) return
    loopStartRef.current = s
    loopEndRef.current = e
    repCounterRef.current = 0
    setLastTake(null)
    pb.setLoop({ startSec: s, endSec: e })
    pb.seek(s)
    prevTimeRef.current = s
    lastSeekMsRef.current = performance.now()
    awaitingSeekRef.current = s
    engineRef.current?.startRecording()
  }

  function gotoMove(i: number, play = true) {
    clearCountdown()
    const list = movesRef.current
    const idx = Math.max(0, Math.min(i, list.length - 1))
    const m = list[idx]
    if (!m) return
    setFullRun(false); fullRunRef.current = false
    setMoveIdx(idx); moveIdxRef.current = idx
    setLoopRegion(m.startSec, m.endSec)
    if (play) { playbackRef.current?.play(); setPlaying(true) }
  }
  // Tapping a segment on the timeline. If it's already done (greyed), un-mark it for review.
  // In Full song: stay in full song, just jump the playhead to that segment and play on.
  // Otherwise: drill just that segment. Either way, hold a "Get ready" 3-2-1 countdown first.
  function reviewSegment(i: number) {
    if (completedRef.current.includes(i)) {
      const next = completedRef.current.filter((x) => x !== i)
      setCompleted(next); completedRef.current = next
      flashToast('Marked for review')
    }
    const pb = playbackRef.current
    if (!pb) return
    const list = movesRef.current
    const idx = Math.max(0, Math.min(i, list.length - 1))
    const m = list[idx]
    if (!m) return
    pb.pause()
    setMoveIdx(idx); moveIdxRef.current = idx
    if (fullRunRef.current) {
      // Keep the full-range loop; just move the playhead to this segment's start.
      pb.seek(m.startSec)
      prevTimeRef.current = m.startSec
      awaitingSeekRef.current = m.startSec
      lastSeekMsRef.current = performance.now()
    } else {
      setLoopRegion(m.startSec, m.endSec)
    }
    runCountdown(() => {
      const p = playbackRef.current
      if (!p) return
      engineRef.current?.startRecording()
      p.play(); setPlaying(true)
    }, 'Get ready', 3)
  }
  function repeatMove() {
    clearCountdown()
    setLoopRegion(loopStartRef.current, loopEndRef.current)
    playbackRef.current?.play(); setPlaying(true)
  }
  function gotIt() {
    const list = movesRef.current
    const cur = moveIdxRef.current
    const done = completedRef.current.includes(cur) ? completedRef.current : [...completedRef.current, cur]
    setCompleted(done); completedRef.current = done
    // Find the next segment that isn't done or skipped, starting after the current one.
    const n = list.length
    let next = -1
    for (let k = 1; k <= n; k++) { const j = (cur + k) % n; if (!done.includes(j) && !skipRef.current.includes(j)) { next = j; break } }
    if (next === -1) {
      clearCountdown()
      playbackRef.current?.pause(); setPlaying(false)
      flashToast('You got the whole thing 🎉')
    } else {
      // Set up the next segment, then wait the break before it starts.
      flashToast('Nice ✓')
      clearCountdown()
      const pb = playbackRef.current
      pb?.pause(); setPlaying(false)
      setFullRun(false); fullRunRef.current = false
      setMoveIdx(next); moveIdxRef.current = next
      const m = list[next]
      if (m) setLoopRegion(m.startSec, m.endSec)
      runCountdown(() => { playbackRef.current?.play(); setPlaying(true) }, 'Playing next segment in')
    }
  }
  // (Re)detect the moves for a range. 'auto' snaps cuts to natural pauses; 'even' spaces
  // them evenly. Clears progress since the moves changed.
  function segmentInto(s: number, e: number, mode: 'auto' | 'even') {
    const bounds = mode === 'auto'
      ? autoMoveBounds(trackRef.current.frames, s, e, moveSec)
      : evenMoveBounds(s, e, moveSec)
    setMoveBounds(bounds)
    setCompleted([]); completedRef.current = []; setSkip([])
    setMoveIdx(0); moveIdxRef.current = 0
    setPreviewIdx(-1)
  }
  // In the editor, tap a segment to loop-play just that slice so you can see where it ends.
  function previewSegment(m: Move) {
    clearCountdown()
    setCreating(false)
    setPreviewIdx(m.index)
    setLoopRegion(m.startSec, m.endSec)
    playbackRef.current?.play()
  }

  // Segment creator: clear the cuts, play the whole range, and let the user tap to drop a
  // cut wherever a move ends — building the segments themselves in one watch-through.
  function startCreator() {
    clearCountdown()
    setPreviewIdx(-1)
    setMoveBounds([])
    setCompleted([]); completedRef.current = []; setSkip([])
    setCreating(true)
    setLoopRegion(trimStart, trimEnd)
    playbackRef.current?.play()
  }
  function addCut() {
    const t = playbackRef.current?.getTime() ?? trimStart
    if (t <= trimStart + 0.2 || t >= trimEnd - 0.2) return
    if (movesRef.current.some((m) => Math.abs(m.startSec - t) < 0.25)) return
    setMoveBounds([...movesRef.current.slice(1).map((m) => m.startSec), t].sort((a, b) => a - b))
    setSkip([])
  }
  function onTrimChange(s: number, e: number) {
    setTrimStart(s); setTrimEnd(e)
    // In the creator, leave the segments to the user — just keep their cuts that still fall
    // inside the new range. Otherwise re-detect to match the new range.
    if (creatingRef.current) {
      setMoveBounds((bounds) => bounds.filter((b) => b > s + 0.05 && b < e - 0.05))
      setPreviewIdx(-1); setSkip([])
      return
    }
    segmentInto(s, e, 'auto')
    window.setTimeout(() => gotoMove(0, phase === 'go'), 0)
  }

  // ---- Move editor handlers (used on the bounds step) ----
  function editorMoveBound(moveIndex: number, t: number) {
    // Replace the (moveIndex-1)-th internal cut with the dragged time, then re-sort.
    const cuts = movesRef.current.slice(1).map((m) => m.startSec)
    if (moveIndex - 1 < 0 || moveIndex - 1 >= cuts.length) return
    cuts[moveIndex - 1] = t
    setMoveBounds(cuts.slice().sort((a, b) => a - b))
  }
  function editorRemoveBound(moveIndex: number) {
    const cuts = movesRef.current.slice(1).map((m) => m.startSec)
    cuts.splice(moveIndex - 1, 1)
    setMoveBounds(cuts)
    setCompleted([]); completedRef.current = []; setSkip([])
  }
  // Delete a segment: drop the boundary that makes it distinct so its time merges into a
  // neighbour (the first segment merges into the next, others into the previous).
  function deleteSegment(moveIndex: number) {
    if (movesRef.current.length <= 1) return
    editorRemoveBound(moveIndex === 0 ? 1 : moveIndex)
    setPreviewIdx(-1)
  }
  // Skip/cut a segment out of practice (e.g. the instructor's explanation parts).
  function toggleSkip(i: number) {
    setSkip((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))
  }
  // Next non-skipped segment index in a direction (wraps).
  function nextOpen(from: number, dir: 1 | -1): number {
    const n = movesRef.current.length
    for (let k = 1; k <= n; k++) {
      const j = (((from + dir * k) % n) + n) % n
      if (!skipRef.current.includes(j)) return j
    }
    return from
  }
  function splitAtPlayhead() {
    const t = playbackRef.current?.getTime() ?? trimStart
    if (t <= trimStart + 0.2 || t >= trimEnd - 0.2) { flashToast('Move the playhead into the range first'); return }
    if (movesRef.current.some((m) => Math.abs(m.startSec - t) < 0.2)) { flashToast('Too close to a divider'); return }
    setMoveBounds([...movesRef.current.slice(1).map((m) => m.startSec), t].sort((a, b) => a - b))
    setCompleted([]); completedRef.current = []; setSkip([])
  }
  function playAll() {
    const pb = playbackRef.current
    if (!pb) return
    clearCountdown()
    // Toggle: tapping Full song again returns to the segment you were on.
    if (fullRunRef.current) {
      gotoMove(segmentBeforeFullRef.current)
      return
    }
    segmentBeforeFullRef.current = moveIdxRef.current
    setFullRun(true); fullRunRef.current = true
    setMoveIdx(0); moveIdxRef.current = 0
    setLoopRegion(trimStart, trimEnd)
    pb.play(); setPlaying(true)
  }

  function togglePlay() {
    const pb = playbackRef.current
    if (!pb) return
    clearCountdown()
    pb.toggle()
    setPlaying(pb.isPlaying)
    if (pb.isPlaying) { prevTimeRef.current = pb.getTime(); engineRef.current?.startRecording() }
  }
  function changeRate(r: number) { setRate(r); playbackRef.current?.setRate(r) }
  function seekTo(t: number) { playbackRef.current?.seek(t); prevTimeRef.current = t; lastSeekMsRef.current = performance.now(); awaitingSeekRef.current = t }

  async function switchCamera(deviceId: string) {
    const webcam = webcamVideoRef.current
    if (!webcam) return
    try {
      camRef.current?.stop()
      const cam = await startCamera(webcam, deviceId)
      camRef.current = cam
      setActiveCam(cam.deviceId)
      localStorage.setItem('movewith.cameraId', deviceId)
      setCameras(await listVideoInputs())
    } catch (e) { setCamError(e instanceof Error ? e.message : String(e)) }
  }

  function goToBounds() {
    setPhase('bounds')
    // If segments were already saved/restored for this track, open the editor showing them;
    // otherwise start the "create your segments" step blank so the user places their own.
    const hasSegments = moveBounds.length > 0
    setCreating(!hasSegments)
    setPreviewIdx(-1)
    setMoveIdx(0); moveIdxRef.current = 0
    // Autoplay the video here so they can watch while placing cuts.
    window.setTimeout(() => {
      const pb = playbackRef.current
      if (pb) { pb.setLoop({ startSec: trimStart, endSec: trimEnd }); pb.seek(trimStart); prevTimeRef.current = trimStart; pb.play(); setPlaying(true) }
    }, 80)
  }
  // Jump back to the segment editor (the bounds step) without losing the trim/segments.
  function editSegments() {
    playbackRef.current?.pause()
    setPlaying(false)
    setCreating(false)
    setPhase('bounds')
    window.setTimeout(() => {
      const pb = playbackRef.current
      if (pb) { pb.setLoop({ startSec: trimStart, endSec: trimEnd }); pb.seek(trimStart); prevTimeRef.current = trimStart; pb.play(); setPlaying(true) }
    }, 60)
  }
  function beginPractice() {
    setPhase('go')
    playbackRef.current?.pause(); setPlaying(false)
    // Set up the first non-skipped segment but don't play yet — "Get ready" countdown first.
    const first = skipRef.current.includes(0) ? nextOpen(0, 1) : 0
    window.setTimeout(() => {
      gotoMove(first, false)
      runCountdown(() => {
        const p = playbackRef.current
        if (!p) return
        engineRef.current?.startRecording()
        p.play(); setPlaying(true)
      }, 'Get ready', 3)
    }, 60)
  }

  voiceHandlerRef.current = (cmd) => {
    const pb = playbackRef.current
    switch (cmd) {
      case 'play': if (pb && !pb.isPlaying) togglePlay(); break
      case 'pause': if (pb && pb.isPlaying) togglePlay(); break
      case 'restart': repeatMove(); break
      case 'slower': changeRate(stepRate(rate, -1)); break
      case 'faster': changeRate(stepRate(rate, 1)); break
      case 'normalSpeed': changeRate(1); break
      case 'toggleMirror': setMirror((m) => !m); break
      case 'next': gotIt(); break
      case 'prev': gotoMove(nextOpen(moveIdxRef.current, -1)); break
      default: break
    }
  }

  const tip = lastTake && lastTake.score < PASS_THRESHOLD && lastTake.worstLimb ? LIMB_TIP[lastTake.worstLimb] : null
  const btn = 'rounded-xl border border-line bg-ink/[0.06] px-3.5 py-2.5 text-sm font-medium text-ink/70 transition hover:border-ink/25 hover:text-ink active:scale-95'
  const chip = (on: boolean) =>
    `rounded-xl px-4 py-2 text-sm font-semibold transition ${on ? 'bg-brand text-cream shadow-glow' : 'border border-line bg-ink/[0.06] text-ink/70 hover:text-ink'}`

  // ---------- SETUP ----------
  if (phase === 'setup') {
    return (
      <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-5 sm:p-8">
        <button onClick={back} className={btn + ' !py-2 absolute left-5 top-5'}>← Library</button>
        <div className="text-center">
          <h1 className="font-display text-3xl font-bold tracking-tightish">{track.name}</h1>
          <p className="mt-1 text-sm text-ink/50">{Math.round(track.tempo.bpm)} BPM · set it up, then dance</p>
        </div>

        <div className="space-y-5 rounded-2.5xl border border-line bg-panel/70 p-6 shadow-soft">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink/45">Segment length</p>
            <div className="flex gap-2">
              {MOVE_SIZES.map((m) => (
                <button key={m.label} onClick={() => setMoveSec(m.sec)} className={chip(moveSec === m.sec)}>{m.label}</button>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink/45">The dance splits into short segments you learn one at a time. You set them up next; this is just the target length.</p>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink/45">Repeat each segment</p>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setReps(Infinity)} className={chip(reps === Infinity)}>Loop till I move on</button>
              <span className="text-sm text-ink/40">or</span>
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={reps === Infinity ? '' : reps}
                placeholder="5"
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  setReps(Number.isFinite(n) && n > 0 ? n : 1)
                }}
                className="w-16 rounded-xl border border-line bg-ink/[0.06] px-3 py-2 text-center text-sm text-ink outline-none focus:border-brand"
              />
              <span className="text-sm text-ink/50">times</span>
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink/45">Break between replays</p>
            <div className="flex gap-2">
              {[0, 2, 3, 5].map((s) => (
                <button key={s} onClick={() => setBreakSecs(s)} className={chip(breakSecs === s)}>{s === 0 ? 'No break' : `${s}s`}</button>
              ))}
            </div>
          </div>
          {!playbackOnly && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink/45">Camera</p>
              <div className="flex gap-2">
                <button onClick={() => setCameraOn(true)} className={chip(cameraOn)}>On · score me</button>
                <button onClick={() => setCameraOn(false)} className={chip(!cameraOn)}>Off · just follow</button>
              </div>
            </div>
          )}
        </div>

        <button onClick={goToBounds} className="rounded-2xl bg-brand py-4 text-lg font-bold text-cream shadow-glow transition hover:brightness-105 active:scale-[0.99]">
          Next: trim & create segments ▶
        </button>
      </div>
    )
  }

  const inGo = phase === 'go'

  // ---------- PRACTICE ----------
  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-3 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <button onClick={() => { playbackRef.current?.pause(); setPlaying(false); setPhase('setup') }} className={btn + ' !py-2'}>‹ Settings</button>
        <div className="min-w-0 text-center">
          <h1 className="truncate font-display text-base font-semibold tracking-tightish">{track.name}</h1>
          <p className="text-xs text-ink/45">
            {phase === 'bounds'
              ? (creating ? 'Create your segments' : 'Edit segments')
              : fullRun
                ? 'Full song'
                : `Segment ${moveIdx + 1} of ${moves.length}`}
          </p>
        </div>
        <button onClick={back} className={btn + ' !py-2'}>Exit</button>
      </header>

      {/* Instructor (flips when Mirror is on) */}
      <section className="relative aspect-video overflow-hidden rounded-2.5xl border border-line bg-black/60 shadow-soft">
        {/* Which segment you're on — top-left badge (no beat count). */}
        {inGo && (
          <span className="absolute left-3 top-3 z-20 rounded-2xl bg-brand px-3 py-2 font-display text-sm font-bold text-cream shadow-glow">
            {fullRun ? 'Full song' : `Segment ${moveIdx + 1} of ${moves.length}`}
          </span>
        )}
        {/* Editor preview: which segment is playing. */}
        {!inGo && previewIdx >= 0 && moves[previewIdx] && (
          <span className="absolute left-3 top-3 z-20 rounded-2xl bg-brand px-3 py-2 font-display text-sm font-bold text-cream shadow-glow">
            ▶ Segment {previewIdx + 1}
          </span>
        )}
        {/* Mirror is done by flipping the CANVAS draw (see drawInstructor), never by
            CSS-transforming the <video> — that tore into a split-screen on Windows. When
            mirrored the canvas paints the flipped video over the (untouched) <video>. */}
        <div className="absolute inset-0">
          {videoUrl ? (
            <>
              <video
                ref={attachInstructorVideo}
                src={videoUrl}
                className="absolute inset-0 h-full w-full object-contain"
                preload="auto"
                playsInline
              />
              <canvas
                ref={instructorOverlayRef}
                className="pointer-events-none absolute inset-0 h-full w-full"
              />
            </>
          ) : (
            !showAvatar && (
              <canvas
                ref={instructorCanvasRef}
                className="absolute inset-0 h-full w-full"
              />
            )
          )}
          {/* Rigged 3D dancer. Sits above the video (which keeps playing for the music) on
              an opaque stage backdrop. Mirror is a CSS flip of the WebGL canvas. */}
          {showAvatar && (
            <div
              className="absolute inset-0 z-10"
              style={{ background: 'radial-gradient(ellipse at 50% 42%, #353b58 0%, #171a28 62%, #0c0e18 100%)' }}
            >
              <canvas
                ref={avatarCanvasRef}
                className="h-full w-full"
                style={{ transform: mirror ? 'scaleX(-1)' : undefined }}
              />
              {avatarStatus === 'loading' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                  <div className="h-7 w-7 animate-spin rounded-full border-2 border-cream/25 border-t-cream" />
                  <p className="text-xs text-cream/60">Loading your dancer…</p>
                </div>
              )}
            </div>
          )}
        </div>
        {cameraOn && (
          <div className="absolute bottom-3 right-3 z-20 w-[34%] max-w-[230px] overflow-hidden rounded-xl border border-brand/50 bg-black/60 shadow-soft">
            <div className="relative aspect-video">
              <div className="mirror absolute inset-0">
                <video ref={webcamVideoRef} className="h-full w-full object-cover" playsInline muted />
                <canvas ref={webcamCanvasRef} className="absolute inset-0 h-full w-full" />
              </div>
              {camStatus !== 'ready' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-2 text-center">
                  {camStatus === 'init'
                    ? <div className="h-5 w-5 animate-spin rounded-full border-2 border-cream/30 border-t-cream" />
                    : <p className="text-[11px] text-bad">{camError ?? 'No camera'}</p>}
                </div>
              )}
              {scoring && camStatus === 'ready' && noBody && (
                <p className="absolute inset-x-0 bottom-1 text-center text-[10px] text-warn">step into frame</p>
              )}
            </div>
            {scoring && <div className="px-2 pb-2 pt-1"><AccuracyMeter score={meter} compact label="Match" /></div>}
          </div>
        )}
        {countdown > 0 && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/45 backdrop-blur-[1px]">
            <p className="text-xs uppercase tracking-[0.2em] text-cream/70">{countdownLabel}</p>
            <p className="font-display text-7xl font-bold text-cream drop-shadow">{countdown}</p>
          </div>
        )}
      </section>

      {/* Bounds: a trimmer to pick the part. Practice: the segment timeline (already trimmed). */}
      {inGo ? (
        <SegmentBar
          trimStart={trimStart}
          trimEnd={trimEnd}
          moves={moves}
          activeIndex={moveIdx}
          completed={completed}
          skip={skip}
          playheadRef={moveEditorPlayheadRef}
          onTap={reviewSegment}
          onSeek={seekTo}
        />
      ) : (
        <Scrubber duration={duration} currentTime={0} rangeStart={trimStart} rangeEnd={trimEnd} sections={ticks} onSeek={seekTo} onRangeChange={onTrimChange} playheadRef={scrubPlayheadRef} />
      )}

      {!inGo ? (
        /* Bounds step: trim, then create the segments to learn, then begin */
        <div className="flex flex-col items-center gap-3">
          <p className="max-w-lg text-center text-sm text-ink/55">
            {creating ? (
              <>
                <b className="text-ink/80">Step 2: create your segments.</b> Play the video and tap{' '}
                <b className="text-ink/80">✂ Cut here</b> wherever a move ends. Build them one at a time, in
                order. (First trim the part you want with the handles above, or tap ↻ Auto-detect.)
              </>
            ) : (
              <>Fine-tune your segments: tap to play, <b className="text-ink/80">⊘ to skip</b> a part (like an explanation), ✕ to delete, drag a divider to move it.</>
            )}
          </p>

          {/* Segment editor */}
          <div className="w-full rounded-2xl border border-brand/30 bg-brand/[0.06] p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-display text-sm font-semibold">{creating ? '✂ Create your segments' : '✎ Segment editor'}</span>
              <span className="text-xs text-ink/50">
                {creating ? 'one ✂ Cut at the end of each move' : 'tap to play · ⊘ skip · ✕ delete · drag dividers'}
              </span>
            </div>
            <MoveEditor
              trimStart={trimStart}
              trimEnd={trimEnd}
              moves={moves}
              activeIndex={previewIdx}
              playheadRef={moveEditorPlayheadRef}
              creating={creating}
              skip={skip}
              onPlaySegment={previewSegment}
              onMoveBound={editorMoveBound}
              onDeleteSegment={deleteSegment}
              onToggleSkip={toggleSkip}
            />
          </div>

          {creating ? (
            /* Create step: watch it play, tap to drop a cut at each move */
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button onClick={togglePlay} className={btn}>{playing ? '⏸ Pause' : '▶ Play'}</button>
              <div className="flex items-center gap-1 rounded-xl border border-line bg-ink/[0.06] p-1">
                {RATE_STEPS.slice().reverse().map((r) => (
                  <button key={r} onClick={() => changeRate(r)} className={`rounded-lg px-3 py-1.5 text-sm font-medium tabular-nums transition ${rate === r ? 'bg-brand text-cream' : 'text-ink/55 hover:text-ink'}`}>{r === 1 ? '1×' : `${r}×`}</button>
                ))}
              </div>
              <button onClick={addCut} className="rounded-xl bg-brand px-6 py-3 text-base font-bold text-cream shadow-glow transition hover:brightness-105 active:scale-95">
                ✂ Cut here
              </button>
              <button onClick={() => segmentInto(trimStart, trimEnd, 'auto')} className={btn} title="Let it place the segments for you">↻ Auto-detect</button>
              <button onClick={() => { setMoveBounds([]); setCompleted([]); completedRef.current = []; setPreviewIdx(-1) }} className={btn} title="Clear all cuts and start over">↺ Clear</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button onClick={togglePlay} className={btn}>{playing ? '⏸ Pause' : '▶ Preview'}</button>
              <div className="flex items-center gap-1 rounded-xl border border-line bg-ink/[0.06] p-1">
                {RATE_STEPS.slice().reverse().map((r) => (
                  <button key={r} onClick={() => changeRate(r)} className={`rounded-lg px-3 py-1.5 text-sm font-medium tabular-nums transition ${rate === r ? 'bg-brand text-cream' : 'text-ink/55 hover:text-ink'}`}>{r === 1 ? '1×' : `${r}×`}</button>
                ))}
              </div>
              <button onClick={() => segmentInto(trimStart, trimEnd, 'auto')} className={btn} title="Re-detect segments from the dancing">↻ Auto-detect</button>
              <button onClick={startCreator} className={btn} title="Clear and place your own segments">✋ Place my own</button>
              <button onClick={splitAtPlayhead} className={btn}>✂ Split here</button>
              <button onClick={() => segmentInto(trimStart, trimEnd, 'even')} className={btn} title="Space segments evenly">≡ Even</button>
            </div>
          )}
          <button onClick={beginPractice} className="rounded-2xl bg-brand px-8 py-3 text-base font-bold text-cream shadow-glow transition hover:brightness-105 active:scale-95">
            Start practicing ▶
          </button>
        </div>
      ) : (
        <>
          {/* Transport */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button onClick={togglePlay} className="rounded-xl bg-brand px-6 py-2.5 text-sm font-semibold text-cream shadow-glow transition hover:brightness-105 active:scale-95">
              {playing ? '⏸ Pause' : '▶ Play'}
            </button>
            <div className="flex items-center gap-1 rounded-xl border border-line bg-ink/[0.06] p-1">
              {RATE_STEPS.slice().reverse().map((r) => (
                <button key={r} onClick={() => changeRate(r)} className={`rounded-lg px-3 py-1.5 text-sm font-medium tabular-nums transition ${rate === r ? 'bg-brand text-cream' : 'text-ink/55 hover:text-ink'}`}>
                  {r === 1 ? '1×' : `${r}×`}
                </button>
              ))}
            </div>
            <button onClick={() => setMirror((m) => !m)} className={mirror ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn}>🪞 Mirror</button>
            {videoUrl && hasFrames && avatarStatus !== 'error' && (
              <button
                onClick={() => setAvatar3d((v) => !v)}
                className={avatar3d ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn}
                title="Follow a 3D dancer instead of the video"
              >
                🕺 3D dancer
              </button>
            )}
            <button onClick={playAll} className={fullRun ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn} title="Practice the whole song start to finish">▶ Full song</button>
            <button onClick={editSegments} className={btn} title="Go back and edit the segments">✎ Edit segments</button>
            {voiceSupported && (
              <button onClick={() => setVoiceOn((v) => !v)} className={voiceOn ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn}>🎙</button>
            )}
          </div>

          {/* Got it / repeat */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button onClick={() => gotoMove(nextOpen(moveIdx, -1))} className={btn + ' !px-3'}>‹ prev</button>
            <button onClick={repeatMove} className="rounded-xl border border-line bg-ink/[0.06] px-5 py-2.5 text-sm font-semibold text-ink/80 transition hover:text-ink active:scale-95">↻ Repeat</button>
            <button onClick={gotIt} className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95">✓ Got it</button>
            <button onClick={() => gotoMove(nextOpen(moveIdx, 1))} className={btn + ' !px-3'}>skip ›</button>
          </div>

          {/* Coaching line */}
          <div className="flex min-h-[24px] items-center justify-center text-sm">
            {toast ? (
              <span className="rounded-full bg-good/20 px-3 py-1 font-semibold text-good">{toast}</span>
            ) : lastTake ? (
              <span className="text-ink/70">
                Last: <b style={{ color: lastTake.score >= PASS_THRESHOLD ? '#a3e635' : '#ff9f1c' }}>{Math.round(lastTake.score)}%</b>
                {tip && <span className="text-ink/45"> · {tip}</span>}
              </span>
            ) : (
              <span className="text-ink/40">Drill this segment, then ✓ Got it for the next one.</span>
            )}
          </div>
        </>
      )}

      {cameraOn && cameras.length > 0 && (
        <div className="flex justify-center">
          <select value={activeCam ?? ''} onChange={(e) => void switchCamera(e.target.value)} className="max-w-[240px] truncate rounded-xl border border-line bg-panel px-2 py-1.5 text-xs text-ink/80 outline-none">
            {cameras.map((c, i) => <option key={c.deviceId || i} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}
