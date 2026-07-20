import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'
import { PlaybackController } from '../../engine/playback'
import { PracticeEngine, type ReferenceContext } from '../../engine/practiceEngine'
import { startCamera, listVideoInputs, preferredCameraId, type CameraHandle } from '../../engine/camera'
import { getPoseProvider } from '../../providers/instance'
import { anglesAt, sectionAngles, nearestFrameIndex } from '../../core/reference/build'
import { scoreSectionDetailed, summarizeRun, type DetailedSectionScore, type RunSummary } from '../../core/compare/score'
import { STRICT, LOOSE, type ScoreConfig, type Limb } from '../../core/compare/similarity'
import type { Section } from '../../core/audio/beats'
import {
  type Move,
  buildMovesFromBounds,
  evenMoveBounds,
  autoMoveBounds,
} from '../../core/reference/segment'
import { VoiceController, type VoiceCommand } from '../../engine/voice'
import { BeatMusic } from '../../engine/beatMusic'
import { drawSkeleton, drawHumanFigure, worldProjector, containProjector, coverProjector } from '../components/drawSkeleton'
import { InstructorAvatar, type AvatarStatus } from '../avatar/InstructorAvatar'
import { AccuracyMeter } from '../components/AccuracyMeter'
import { Scrubber } from '../components/Scrubber'
import { MoveEditor } from '../components/MoveEditor'
import { SegmentBar } from '../components/SegmentBar'
import type { ReferenceTrack } from '../../core/reference/types'

const RATE_STEPS = [0.5, 0.75, 1]
// The rigged 3D dancer isn't good enough to show anyone yet. The whole implementation
// stays (InstructorAvatar, the .glb, the pose solver) — this just keeps it off screen
// until it's ready. Flip to true to bring it back.
const ENABLE_3D_AVATAR = false

const LIMB_LABEL: Record<Limb, string> = {
  leftArm: 'Left arm', rightArm: 'Right arm', leftLeg: 'Left leg', rightLeg: 'Right leg', torso: 'Torso',
}
const LIMB_ADVICE: Record<Limb, string> = {
  leftArm: 'match the elbow bend and where the arm points',
  rightArm: 'match the elbow bend and where the arm points',
  leftLeg: 'check the knee bend and where the foot lands',
  rightLeg: 'check the knee bend and where the foot lands',
  torso: 'keep your lean and hip line matched to the move',
}
const PHASE_LABEL: Record<'start' | 'middle' | 'end', string> = {
  start: 'beginning', middle: 'middle', end: 'ending',
}
/** Convert an average per-limb error (degrees) into a 0-100 bar for the results panel. */
function limbQuality(errorDeg: number) {
  return Math.max(0, Math.min(100, Math.round(100 - errorDeg * 2.2)))
}
function scoreVerdict(score: number) {
  if (score >= 85) return { label: 'Nailed it', color: '#a3e635' }
  if (score >= 70) return { label: 'Close — tighten it up', color: '#facc15' }
  if (score >= 50) return { label: 'Getting there', color: '#ff9f1c' }
  return { label: 'Keep drilling this one', color: '#ff5470' }
}
/** Human feedback lines: which limbs drifted (and how far), and when it slipped. */
function feedbackLines(r: DetailedSectionScore): string[] {
  const lines: string[] = []
  const limbs = (Object.entries(r.perLimb) as [Limb, { errorDeg: number; ok: boolean }][])
    .sort((a, b) => b[1].errorDeg - a[1].errorDeg)
  for (const [limb, res] of limbs.slice(0, 2)) {
    if (!res.ok) lines.push(`${LIMB_LABEL[limb]} drifted ~${Math.round(res.errorDeg)}° from the move — ${LIMB_ADVICE[limb]}.`)
  }
  if (r.phases.length === 3) {
    const worst = r.phases.reduce((a, b) => (b.score < a.score ? b : a))
    const best = r.phases.reduce((a, b) => (b.score > a.score ? b : a))
    if (best.score - worst.score > 12) {
      lines.push(`The ${PHASE_LABEL[worst.phase]} slipped the most (${Math.round(worst.score)}% there).`)
    }
  }
  if (lines.length === 0) lines.push('Clean run — everything tracked tight to the reference. 🔥')
  return lines
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
// Colors telling the dancers apart in the multi-dancer picker (skeleton + chip match).
const DANCER_COLORS = ['#22d3ee', '#ff2e88', '#a3e635', '#ff9f1c'] as const

// Move boundaries as tick marks for the scrubber.
function moveTicks(moves: Move[]): Section[] {
  return moves.map((m) => ({ index: m.index, label: '', startSec: m.startSec, endSec: m.endSec, startBeat: 0 }))
}

export function Practice() {
  const track = useSession((s) => s.activeTrack)!
  const videoUrl = useSession((s) => s.activeVideoUrl)
  const openIntent = useSession((s) => s.openIntent)
  const back = useSession((s) => s.back)
  const updateProgress = useSession((s) => s.updateProgress)
  const renameTrack = useSession((s) => s.renameTrack)
  const selectDancer = useSession((s) => s.selectDancer)

  const duration = track.source.durationSec
  const playbackOnly = track.frames.length === 0

  // Restore the dancer's saved trim + segments + settings for this track, if any.
  const savedSetup = useSession.getState().progress?.setup

  // ---- setup choices (made before practice) ----
  const [phase, setPhase] = useState<'setup' | 'bounds' | 'go'>('setup')
  // Target length auto-detect aims for per segment. No UI — the primary path is cutting
  // your own segments while watching; auto-detect just needs a sensible default.
  const [moveSec] = useState<number>(savedSetup?.moveSec ?? 8)
  const [reps, setReps] = useState<number>(savedSetup?.reps ?? Infinity)
  const [breakSecs, setBreakSecs] = useState<number>(savedSetup?.breakSecs ?? 3)
  // Camera turns on in two places, never in plain practice:
  //  - selfView: dance beside yourself and watch each take replay (NO scoring).
  //  - rating ("Test my skills"): the pose engine scores you.
  const [selfView, setSelfView] = useState(savedSetup?.selfView ?? false)
  const [rating, setRating] = useState(false)
  const scoring = rating && !playbackOnly
  const [completed, setCompleted] = useState<number[]>([])
  const [skip, setSkip] = useState<number[]>(savedSetup?.skip ?? [])
  const [countdown, setCountdown] = useState(0)
  const [countdownLabel, setCountdownLabel] = useState('Replaying in')
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')

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
  // Draw the tracked skeleton over the instructor. Never shown while cutting segments;
  // toggleable in practice/test in case the tracking is off for a video.
  const [tracking, setTracking] = useState(true)
  const [previewIdx, setPreviewIdx] = useState(-1) // segment being loop-previewed in the editor
  const [creating, setCreating] = useState(false) // segment-creator mode (tap to place cuts)
  const [meter, setMeter] = useState(0)
  const [camStatus, setCamStatus] = useState<'init' | 'ready' | 'error'>('init')
  const [camError, setCamError] = useState<string | null>(null)
  const [noBody, setNoBody] = useState(false)
  // segMode drives what the stage is doing:
  //  - 'watch'   plain practice (loop, Got it) — no camera
  //  - 'selftry' self-view: dance the segment once beside your live camera (recording)
  //  - 'menu'    the rater's pick-what-to-rate screen
  //  - 'test'    the rater: dance a range once, being scored
  //  - 'results' single-segment score + tips
  //  - 'summary' full run-through recap (per-segment grades)
  //  - 'replay'  side-by-side: instructor + your recorded take
  const [segMode, setSegMode] = useState<'watch' | 'selftry' | 'menu' | 'test' | 'results' | 'summary' | 'replay'>('watch')
  const [testResult, setTestResult] = useState<DetailedSectionScore | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null)
  /** Object URL of the camera recording captured during the last take. */
  const [takeUrl, setTakeUrl] = useState<string | null>(null)
  // The camera owns the whole stage while the rater scores you.
  const camMain = scoring && (segMode === 'test' || segMode === 'results')
  // Self-view live pass: instructor left, your live camera right.
  const selfTrying = segMode === 'selftry'
  // Side-by-side replay: instructor on the left, your recorded take on the right.
  const replaying = phase === 'go' && segMode === 'replay' && !!takeUrl
  const [toast, setToast] = useState<string | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [activeCam, setActiveCam] = useState<string | null>(null)
  const [voiceOn, setVoiceOn] = useState(false)
  const voiceSupported = useMemo(() => VoiceController.isSupported(), [])
  const [avatarStatus, setAvatarStatus] = useState<AvatarStatus>('loading')
  // Synthesized backing beat for generated routines (no video = no audio track of its own).
  const [musicOn, setMusicOn] = useState(true)
  const musicRef = useRef<BeatMusic | null>(null)

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
  const trackingRef = useRef(true)
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
  const ratingRef = useRef(false)
  const selfViewRef = useRef(false)
  const completedRef = useRef<number[]>([])
  const countdownTimerRef = useRef<number | null>(null)
  const voiceHandlerRef = useRef<(c: VoiceCommand) => void>(() => {})
  const segModeRef = useRef<'watch' | 'selftry' | 'menu' | 'test' | 'results' | 'summary' | 'replay'>('watch')
  /** True while a single-pass take is being recorded (segment playing once through) —
   *  used by both the rater ('test') and self-view ('selftry'). */
  const testActiveRef = useRef(false)
  /** Full run-through state: the queue of segment indices to score, and the scores so far. */
  const raterQueueRef = useRef<number[]>([])
  const raterPosRef = useRef(0)
  const runScoresRef = useRef<{ index: number; score: number; worstLimb: Limb | null }[]>([])
  const finishTestRef = useRef<() => void>(() => {})
  const finishSelfTryRef = useRef<() => void>(() => {})
  const cancelTestRef = useRef<() => void>(() => {})
  const recorderRef = useRef<MediaRecorder | null>(null)
  const takeChunksRef = useRef<Blob[]>([])
  const takeUrlRef = useRef<string | null>(null)
  const takeVideoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => void (segModeRef.current = segMode), [segMode])
  useEffect(() => void (completedRef.current = completed), [completed])

  useEffect(() => void (trackRef.current = track), [track])
  useEffect(() => {
    mirrorRef.current = mirror
    // Force an instructor redraw so the flip shows immediately, even while paused.
    const pb = playbackRef.current
    if (pb) pb.seek(pb.getTime())
  }, [mirror])
  useEffect(() => void (phaseRef.current = phase), [phase])
  useEffect(() => {
    trackingRef.current = tracking
    // Redraw immediately so the overlay clears/appears without waiting for playback.
    const pb = playbackRef.current
    if (pb) pb.seek(pb.getTime())
  }, [tracking])
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
      void updateProgress({ ...base, setup: { trimStart, trimEnd, moveBounds, moveSec, reps, breakSecs, selfView, skip } })
    }, 500)
    return () => window.clearTimeout(id)
  }, [trimStart, trimEnd, moveBounds, moveSec, reps, breakSecs, selfView, skip, track.id, updateProgress])
  useEffect(() => void (creatingRef.current = creating), [creating])
  useEffect(() => void (movesRef.current = moves), [moves])
  useEffect(() => void (moveIdxRef.current = moveIdx), [moveIdx])
  useEffect(() => void (repsRef.current = reps), [reps])
  useEffect(() => void (breakRef.current = breakSecs), [breakSecs])
  useEffect(() => void (scoringRef.current = scoring), [scoring])
  useEffect(() => void (ratingRef.current = rating), [rating])
  useEffect(() => void (selfViewRef.current = selfView), [selfView])
  useEffect(() => {
    rateRef.current = rate
    const cfg = rate < 1 ? LOOSE : STRICT
    cfgRef.current = cfg
    engineRef.current?.setConfig(cfg)
  }, [rate])

  // The 3D dancer performs ONLY our generated routines (no video of their own — the demo
  // and future built-in tutorials). Uploaded videos always show the real footage: the
  // dancer is the instructor for content we author, never a replacement for the video.
  // If the model ever fails to load we quietly fall back to the classic 2D drawing.
  const hasFrames = track.frames.length > 0
  const showAvatar = ENABLE_3D_AVATAR && hasFrames && avatarStatus !== 'error' && !videoUrl && phase !== 'setup'

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
    // Camera-relative stage travel (walking toward camera / across frame) is measured
    // against the whole routine's median body size — calibrate before frames stream in.
    inst.calibrate(trackRef.current.frames)
    avatarRef.current = inst
    return () => { avatarRef.current = null; inst.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAvatar, track.id])

  // Playback + instructor draw loop
  useEffect(() => {
    const pb = new PlaybackController(duration)
    pb.attachVideo(videoUrl ? instructorVideoRef.current : null)
    playbackRef.current = pb
    // Generated routines have no audio of their own — give them a synthesized beat
    // (follows play/pause/loop/slow-mo through the controller's clock).
    if (!videoUrl) {
      musicRef.current = new BeatMusic(pb, track.tempo.bpm, track.tempo.firstBeatSec)
    }
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
        // Multi-dancer picker (rater menu): draw EVERY dancer's skeleton in its own
        // color so "which dancer?" is answerable at a glance — the chosen one bold,
        // the others thin.
        const dancers = trackRef.current.dancers
        if (segModeRef.current === 'menu' && dancers && dancers.length > 1) {
          dancers.forEach((df, di) => {
            const j = nearestFrameIndex(df, t)
            const dfr = j >= 0 ? df[j] : null
            const active = di === (trackRef.current.activeDancer ?? 0)
            if (dfr?.image) {
              drawSkeleton(ctx, dfr.image, {
                project: containProjector(vw, vh),
                baseColor: DANCER_COLORS[di % DANCER_COLORS.length],
                lineWidth: Math.max(active ? 3.5 : 1.5, w * (active ? 0.007 : 0.003)),
                jointRadius: Math.max(2.5, w * 0.004),
                clear: false, // stack the skeletons — clearRect already ran above
              })
            }
          })
        }
        // The skeleton overlay belongs to practicing/testing — never while cutting
        // segments (the bounds step is about the video, not the tracking), and it can
        // be toggled off entirely if the tracking is bad for a particular video.
        else if (frame?.image && trackingRef.current && phaseRef.current === 'go') {
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
        pb.pause()
        if (testActiveRef.current) {
          // A single recorded pass plays the segment exactly once — the wrap is the finish
          // line. Scoring pass → grade it; self-view pass → jump to the replay.
          testActiveRef.current = false
          if (scoringRef.current) finishTestRef.current()
          else finishSelfTryRef.current()
        } else if (segModeRef.current === 'replay') {
          // Side-by-side replay ran the segment once; hold at the end for ▶ Replay.
          // (The take video simply ends on its own.)
        } else {
          repCounterRef.current += 1
          const reachedLimit = repsRef.current !== Infinity && repCounterRef.current >= repsRef.current
          if (reachedLimit) {
            repCounterRef.current = 0
            flashToast('Done · ✓ Got it for the next one, or ↻ repeat')
          } else {
            // Wait the break, then resume from the loop start (already there — no re-seek,
            // which could otherwise interrupt play() and leave it stuck paused).
            runCountdown(() => {
              const p = playbackRef.current
              if (!p) return
              prevTimeRef.current = loopStartRef.current
              p.play()
            })
          }
        }
      }
    })

    drawInstructor(pb.getTime())
    return () => {
      unsub(); unsubPlay()
      musicRef.current?.dispose(); musicRef.current = null
      pb.dispose(); playbackRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, videoUrl])

  // Keep the beat track in sync with the music toggle.
  useEffect(() => void musicRef.current?.setEnabled(musicOn), [musicOn, track.id])

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

  // Camera + pose engine. Runs when self-view or the rater is on, and ONLY once you're
  // actually practicing (phase 'go') — never during setup or segment cutting. The pose
  // engine only starts when scoring (rating); self-view just needs the raw stream.
  useEffect(() => {
    if ((!selfView && !rating) || playbackOnly || phase !== 'go') return
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
            // Project through the SAME object-cover geometry the <video> uses, or the
            // lines sit off the body (they'd be stretched to the box while the video
            // underneath is cropped).
            if (ctx) drawSkeleton(ctx, r.liveImage, {
              perLimb: r.frame?.perLimb,
              project: coverProjector(webcam.videoWidth, webcam.videoHeight),
              minVisibility: 0.3,
              lineWidth: Math.max(2, canvas.width * 0.008),
            })
          }
          const now = performance.now()
          if (now - meterThrottleRef.current > 250) { meterThrottleRef.current = now; setMeter(r.rollingScore) }
          if (r.bodyPresent) lastBodyMsRef.current = now
          const hint = now - lastBodyMsRef.current > 1200
          if (hint !== noBodyShownRef.current) { noBodyShownRef.current = hint; setNoBody(hint) }
        })
        lastBodyMsRef.current = performance.now()
        // Detection runs continuously (so the camera is warm and the live meter works the
        // moment a rating starts); takes are only RECORDED during a rating (startRating).
        engine.start()
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
  }, [track.id, rating, selfView, playbackOnly, phase])

  useEffect(() => {
    const cs = [instructorCanvasRef.current, instructorOverlayRef.current, webcamCanvasRef.current].filter(
      (c): c is HTMLCanvasElement => c != null,
    )
    if (cs.length === 0) return
    cs.forEach(sizeCanvas)
    const ro = new ResizeObserver(() => cs.forEach(sizeCanvas))
    cs.forEach((c) => ro.observe(c))
    return () => ro.disconnect()
  }, [videoUrl, rating, selfView, camStatus, phase, segMode])

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

  // Keep the preview element actually playing whenever it's on screen (side-by-side self
  // view or fullscreen test). Some browsers park a video that was display:none, so nudge it
  // on every visibility change — the dancer must ALWAYS see themselves.
  useEffect(() => {
    if (camMain || !replaying) void webcamVideoRef.current?.play().catch(() => { /* not ready yet */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camMain, replaying, selfTrying, camStatus])

  // Opened straight into "Test my skills" from the library: jump past setup into the rater
  // menu once the video is mounted. Runs once.
  const didIntentRef = useRef(false)
  useEffect(() => {
    if (didIntentRef.current) return
    didIntentRef.current = true
    if (openIntent === 'rate' && !playbackOnly) {
      setPhase('go')
      window.setTimeout(() => enterRating(), 80)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Self-view: once a recorded take is ready, auto-play the side-by-side replay.
  useEffect(() => {
    if (segMode === 'replay' && takeUrl && selfViewRef.current && !ratingRef.current) {
      const id = window.setTimeout(() => replayBoth(), 90)
      return () => window.clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeUrl, segMode])

  // Tidy up the take recording on unmount (stop the recorder, free the blob URL).
  useEffect(() => () => {
    try { recorderRef.current?.stop() } catch { /* already stopped */ }
    if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current)
  }, [])

  // Pause when the tab is hidden. The browser suspends requestAnimationFrame while hidden,
  // so the segment-loop logic stops but the <video> keeps playing — which would otherwise
  // run straight past the segment through the whole song. Pause like a video player does.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) return
      // A hidden tab freezes the clock mid-take — abandon the test cleanly instead of
      // leaving it stuck; the dancer can just hit Got it again when they're back.
      if (testActiveRef.current) cancelTestRef.current()
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

  function flashToast(msg: string) { setToast(msg); window.setTimeout(() => setToast(null), 2400) }

  // ---- The camera test: watch → "Got it" → perform it on camera to the music → score ----

  /** Record the camera during a take so it can be replayed side by side afterwards. */
  function startTakeRecording() {
    dropTakeRecording()
    const stream = webcamVideoRef.current?.srcObject as MediaStream | null
    if (!stream || typeof MediaRecorder === 'undefined') return
    try {
      const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m))
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      takeChunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) takeChunksRef.current.push(e.data) }
      rec.onstop = () => {
        if (takeChunksRef.current.length === 0) return
        const url = URL.createObjectURL(new Blob(takeChunksRef.current, { type: rec.mimeType || 'video/webm' }))
        takeUrlRef.current = url
        setTakeUrl(url)
      }
      rec.start()
      recorderRef.current = rec
    } catch { /* recording is a bonus — the test still scores without it */ }
  }
  function stopTakeRecording(keep: boolean) {
    const rec = recorderRef.current
    recorderRef.current = null
    if (!rec) return
    if (!keep) rec.onstop = null
    try { rec.stop() } catch { /* already stopped */ }
    if (!keep) takeChunksRef.current = []
  }
  function dropTakeRecording() {
    stopTakeRecording(false)
    if (takeUrlRef.current) { URL.revokeObjectURL(takeUrlRef.current); takeUrlRef.current = null }
    setTakeUrl(null)
  }

  /** Leave any in-flight test cleanly (navigation, segment switch, exit). */
  function exitTestFlow() {
    testActiveRef.current = false
    takeVideoRef.current?.pause()
    dropTakeRecording()
    setSegMode('watch'); segModeRef.current = 'watch'
    setTestResult(null); setTestError(null)
  }

  // ===== Test my skills (the rater) — a top-level, camera-on scoring flow =====

  /** Enter the rater: camera on, show the pick-what-to-rate menu. */
  function enterRating() {
    if (playbackOnly) return
    clearCountdown()
    playbackRef.current?.pause(); setPlaying(false)
    setTestResult(null); setTestError(null); setRunSummary(null); setTakeUrl(null)
    raterQueueRef.current = []; raterPosRef.current = 0; runScoresRef.current = []
    setRating(true); ratingRef.current = true
    setSegMode('menu'); segModeRef.current = 'menu'
  }

  /** Leave the rater entirely and return to the library (it's its own top-level mode). */
  function exitRating() {
    testActiveRef.current = false
    dropTakeRecording()
    raterQueueRef.current = []; runScoresRef.current = []
    setRating(false); ratingRef.current = false
    back()
  }

  /** Rate a single range [s,e] once, with the music. */
  function startRating(s: number, e: number) {
    clearCountdown()
    const pb = playbackRef.current
    if (!pb) return
    pb.pause(); setPlaying(false)
    setTestResult(null); setTestError(null)
    setMeter(0)
    setSegMode('test'); segModeRef.current = 'test'
    setLoopRegion(s, e)
    const running = raterQueueRef.current.length > 1
    const label = running ? `Segment ${raterPosRef.current + 1} of ${raterQueueRef.current.length} in` : 'Your turn in'
    runCountdown(() => {
      const p = playbackRef.current
      if (!p) return
      prevTimeRef.current = s
      testActiveRef.current = true
      engineRef.current?.startRecording()
      startTakeRecording()
      p.play(); setPlaying(true)
    }, label, 3)
  }

  /** Score every non-skipped segment, one at a time, then show the run summary. */
  function startRunThrough() {
    const queue = movesRef.current.map((m) => m.index).filter((i) => !skipRef.current.includes(i))
    if (queue.length === 0) return
    raterQueueRef.current = queue
    raterPosRef.current = 0
    runScoresRef.current = []
    const m = movesRef.current[queue[0]!]
    if (m) startRating(m.startSec, m.endSec)
  }

  /** A rated range finished playing: grade it. In a run-through, log the score and advance
   *  (or summarize at the end); otherwise show the single-segment detail. */
  function finishTest() {
    playbackRef.current?.pause()
    setPlaying(false)
    stopTakeRecording(true) // finalize the camera recording for side-by-side replay
    const eng = engineRef.current
    const tr = trackRef.current
    const take = eng ? eng.stopRecording() : []
    const refAngles = sectionAngles(tr, loopStartRef.current, loopEndRef.current)
    const ok = take.length >= 3 && refAngles.length >= 2
    const scored = ok ? scoreSectionDetailed(refAngles, take, cfgRef.current) : null

    if (raterQueueRef.current.length > 0) {
      const segIdx = raterQueueRef.current[raterPosRef.current]!
      runScoresRef.current.push({ index: segIdx, score: scored?.score ?? 0, worstLimb: scored?.worstLimb ?? null })
      raterPosRef.current += 1
      if (raterPosRef.current < raterQueueRef.current.length) {
        if (scored) flashToast(`Segment ${segIdx + 1}: ${Math.round(scored.score)}%`)
        const m = movesRef.current[raterQueueRef.current[raterPosRef.current]!]
        if (m) startRating(m.startSec, m.endSec)
      } else {
        setRunSummary(summarizeRun(runScoresRef.current))
        setSegMode('summary'); segModeRef.current = 'summary'
      }
      return
    }
    setTestResult(scored)
    setTestError(ok ? null : "We couldn't see you dancing — make sure your whole body is in frame, then try again.")
    setSegMode('results'); segModeRef.current = 'results'
  }
  finishTestRef.current = finishTest

  /** Self-view: a recorded single pass of a segment ended — go straight to the replay so
   *  you can see how you looked. No scoring here. */
  function finishSelfTry() {
    playbackRef.current?.pause()
    setPlaying(false)
    stopTakeRecording(true) // onstop builds the take URL; an effect auto-plays the replay
    setSegMode('replay'); segModeRef.current = 'replay'
  }
  finishSelfTryRef.current = finishSelfTry

  function cancelTest() {
    clearCountdown()
    testActiveRef.current = false
    engineRef.current?.stopRecording()
    dropTakeRecording()
    playbackRef.current?.pause(); setPlaying(false)
    setTestResult(null); setTestError(null)
    raterQueueRef.current = []; runScoresRef.current = []
    setSegMode('menu'); segModeRef.current = 'menu'
  }
  cancelTestRef.current = cancelTest

  // ===== Self-view practice: dance beside yourself, then replay each take (no scoring) =====

  /** Record one pass of a segment while you dance beside your live camera. */
  function startSelfTry(idx: number) {
    const list = movesRef.current
    const i = Math.max(0, Math.min(idx, list.length - 1))
    const m = list[i]
    if (!m) return
    clearCountdown()
    const pb = playbackRef.current
    if (!pb) return
    pb.pause(); setPlaying(false)
    dropTakeRecording()
    setMoveIdx(i); moveIdxRef.current = i
    setSegMode('selftry'); segModeRef.current = 'selftry'
    setLoopRegion(m.startSec, m.endSec)
    runCountdown(() => {
      const p = playbackRef.current
      if (!p) return
      prevTimeRef.current = m.startSec
      testActiveRef.current = true
      startTakeRecording() // camera only — no pose engine, no scoring
      p.play(); setPlaying(true)
    }, 'Dance in', 3)
  }

  // ---- Side-by-side replay: the reference segment and YOUR recorded take, together ----

  function startReplay() {
    if (!takeUrlRef.current) return
    playbackRef.current?.pause()
    setSegMode('replay'); segModeRef.current = 'replay'
    window.setTimeout(replayBoth, 80) // let the take <video> mount before playing
  }
  /** (Re)start both sides in sync from the top of the segment. */
  function replayBoth() {
    const pb = playbackRef.current
    if (!pb) return
    pb.seek(loopStartRef.current)
    prevTimeRef.current = loopStartRef.current
    awaitingSeekRef.current = loopStartRef.current
    lastSeekMsRef.current = performance.now()
    const tv = takeVideoRef.current
    if (tv) { tv.currentTime = 0; void tv.play().catch(() => {}) }
    pb.play(); setPlaying(true)
  }
  function backToResults() {
    playbackRef.current?.pause(); setPlaying(false)
    takeVideoRef.current?.pause()
    setSegMode('results'); segModeRef.current = 'results'
  }

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
    pb.setLoop({ startSec: s, endSec: e })
    pb.seek(s)
    prevTimeRef.current = s
    lastSeekMsRef.current = performance.now()
    awaitingSeekRef.current = s
  }

  function gotoMove(i: number, play = true) {
    clearCountdown()
    if (segModeRef.current !== 'watch') exitTestFlow()
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
    if (segModeRef.current !== 'watch') exitTestFlow()
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
      p.play(); setPlaying(true)
    }, 'Get ready', 3)
  }
  function repeatMove() {
    clearCountdown()
    setLoopRegion(loopStartRef.current, loopEndRef.current)
    playbackRef.current?.play(); setPlaying(true)
  }
  /** Mark the current segment complete and move on (Proceed — regardless of score). */
  function completeSegment() {
    exitTestFlow()
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
      ? autoMoveBounds(trackRef.current.frames, s, e, moveSec, trackRef.current.tempo)
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
    if (segModeRef.current !== 'watch') exitTestFlow()
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
    // Don't let Space/Play interrupt a test take or desync the side-by-side replay.
    if (segModeRef.current === 'test' || segModeRef.current === 'replay') return
    const pb = playbackRef.current
    if (!pb) return
    clearCountdown()
    pb.toggle()
    setPlaying(pb.isPlaying)
    if (pb.isPlaying) prevTimeRef.current = pb.getTime()
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
    if (segModeRef.current !== 'watch') exitTestFlow()
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
      case 'next': if (segModeRef.current === 'watch') completeSegment(); break
      case 'prev': gotoMove(nextOpen(moveIdxRef.current, -1)); break
      default: break
    }
  }

  const btn = 'rounded-xl border border-line bg-ink/[0.06] px-3.5 py-2.5 text-sm font-medium text-ink/70 transition hover:border-ink/25 hover:text-ink active:scale-95'
  const chip = (on: boolean) =>
    `rounded-xl px-4 py-2 text-sm font-semibold transition ${on ? 'bg-brand text-cream shadow-glow' : 'border border-line bg-ink/[0.06] text-ink/70 hover:text-ink'}`

  // ---------- SETUP ----------
  if (phase === 'setup') {
    return (
      <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-5 sm:p-8">
        <button onClick={back} className={btn + ' !py-2 absolute left-5 top-5'}>← Library</button>
        <div className="text-center">
          {editingTitle ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={() => { void renameTrack(track.id, draftTitle); setEditingTitle(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { void renameTrack(track.id, draftTitle); setEditingTitle(false) }
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              className="mx-auto block w-full max-w-md rounded-xl border border-brand bg-ink/[0.06] px-3 py-1.5 text-center font-display text-3xl font-bold tracking-tightish text-ink outline-none"
            />
          ) : (
            <button
              onClick={() => { setDraftTitle(track.name); setEditingTitle(true) }}
              title="Tap to rename"
              className="group inline-flex items-center gap-2 font-display text-3xl font-bold tracking-tightish"
            >
              {track.name}
              <span className="text-base text-ink/25 transition group-hover:text-ink/60">✏</span>
            </button>
          )}
          <p className="mt-1 text-sm text-ink/50">{Math.round(track.tempo.bpm)} BPM · set it up, then dance</p>
        </div>

        <div className="space-y-5 rounded-2.5xl border border-line bg-panel/70 p-6 shadow-soft">
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
                <button onClick={() => setSelfView(false)} className={chip(!selfView)}>Off · just follow</button>
                <button onClick={() => setSelfView(true)} className={chip(selfView)}>See myself dance</button>
              </div>
              <p className="mt-2 text-xs text-ink/45">
                {selfView
                  ? 'You dance beside your own camera, and each take replays so you can see how you looked.'
                  : 'Just watch and drill. No scoring here — that lives in 🎯 Test my skills, on its own.'}
              </p>
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
        {rating ? (
          <button onClick={exitRating} className={btn + ' !py-2'}>‹ Exit</button>
        ) : (
          <button onClick={() => { playbackRef.current?.pause(); setPlaying(false); setPhase('setup') }} className={btn + ' !py-2'}>‹ Settings</button>
        )}
        <div className="min-w-0 text-center">
          <h1 className="truncate font-display text-base font-semibold tracking-tightish">{track.name}</h1>
          <p className="text-xs text-ink/45">
            {rating
              ? '🎯 Test my skills'
              : phase === 'bounds'
                ? (creating ? 'Create your segments' : 'Edit segments')
                : fullRun
                  ? 'Full song'
                  : `Segment ${moveIdx + 1} of ${moves.length}`}
          </p>
        </div>
        <button onClick={rating ? exitRating : back} className={btn + ' !py-2'}>Exit</button>
      </header>

      {/* Instructor (flips when Mirror is on) */}
      <section className="relative aspect-video overflow-hidden rounded-2.5xl border border-line bg-black/60 shadow-soft">
        {/* Which segment you're on — top-left badge (the test overlay has its own). */}
        {inGo && !camMain && (
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
        {/* Generated routines: toggle the synthesized backing beat. */}
        {!videoUrl && !camMain && (
          <button
            onClick={() => setMusicOn((m) => !m)}
            title={musicOn ? 'Mute the beat' : 'Play the beat'}
            className="absolute right-3 top-3 z-20 rounded-2xl border border-line bg-black/50 px-3 py-2 text-sm font-semibold text-cream/90 backdrop-blur transition hover:border-brand/60 active:scale-95"
          >
            {musicOn ? '🔊 Beat on' : '🔇 Beat off'}
          </button>
        )}
        {/* Bail out of a camera test back to watching. */}
        {inGo && segMode === 'test' && (
          <button
            onClick={cancelTest}
            className="absolute right-3 top-3 z-20 rounded-2xl border border-line bg-black/50 px-3 py-2 text-sm font-semibold text-cream/90 backdrop-blur transition hover:border-bad/60 active:scale-95"
          >
            ✕ Cancel
          </button>
        )}
        {/* Mirror is done by flipping the CANVAS draw (see drawInstructor), never by
            CSS-transforming the <video> — that tore into a split-screen on Windows. When
            mirrored the canvas paints the flipped video over the (untouched) <video>.
            During a camera test the reference layers go invisible (NOT unmounted — the
            video keeps playing so its music drives your take). In side-by-side replay
            they shrink to the LEFT HALF, with your recorded take on the right. */}
        <div className={camMain ? 'pointer-events-none absolute inset-0 opacity-0' : (replaying || selfTrying || (inGo && selfView && segMode === 'watch')) ? 'absolute inset-y-0 left-0 w-1/2' : 'absolute inset-0'}>
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
        {/* YOUR CAMERA — fullscreen while the rater scores you; the RIGHT HALF (beside the
            instructor) during self-view and self-view takes; a small corner tile on the rater
            menu. Hidden during side-by-side replay (your recorded take is on screen there).
            Stays mounted so the stream stays warm. */}
        {inGo && (selfView || rating) && (
          <div
            className={
              camMain
                ? 'absolute inset-0 z-10 bg-black'
                : (selfTrying || (selfView && segMode === 'watch'))
                  ? 'absolute inset-y-0 right-0 z-10 w-1/2 border-l border-line bg-black'
                  : replaying
                    ? 'hidden'
                    : rating && segMode === 'menu'
                      ? 'absolute bottom-3 right-3 z-10 h-36 w-28 overflow-hidden rounded-2xl border border-line bg-black shadow-soft sm:h-44 sm:w-36'
                      : 'hidden'
            }
          >
            <div className="mirror absolute inset-0">
              <video ref={webcamVideoRef} className="h-full w-full object-cover" playsInline muted />
              <canvas ref={webcamCanvasRef} className="absolute inset-0 h-full w-full" />
            </div>
            {!camMain && camStatus === 'ready' && (
              <span className="absolute bottom-1 left-1 z-20 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-cream/85 backdrop-blur">
                You
              </span>
            )}
            {camStatus !== 'ready' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-2 text-center">
                {camStatus === 'init'
                  ? <div className="h-6 w-6 animate-spin rounded-full border-2 border-cream/30 border-t-cream" />
                  : <p className="text-sm text-bad">{camError ?? 'No camera'}</p>}
              </div>
            )}
            {segMode === 'test' && (
              <>
                <span className="absolute left-3 top-3 z-20 rounded-2xl bg-brand2 px-3 py-2 font-display text-sm font-bold text-[#06222a] shadow-soft">
                  🎥 Your turn — dance it!
                </span>
                {camStatus === 'ready' && noBody && (
                  <p className="absolute inset-x-0 bottom-16 text-center text-sm font-semibold text-warn drop-shadow">step into frame</p>
                )}
                <div className="absolute inset-x-4 bottom-3"><AccuracyMeter score={meter} compact label="Match" /></div>
              </>
            )}
            {selfTrying && (
              <span className="absolute left-2 top-2 z-20 flex items-center gap-1.5 rounded-xl bg-black/60 px-2.5 py-1 text-xs font-bold text-cream backdrop-blur">
                <span className="h-2 w-2 animate-pulse rounded-full bg-bad" /> Recording
              </span>
            )}
          </div>
        )}
        {/* SIDE-BY-SIDE REPLAY — the reference next to YOUR recorded take. */}
        {replaying && (
          <>
            <div className="absolute inset-y-0 right-0 w-1/2 border-l border-line bg-black">
              <video
                ref={takeVideoRef}
                src={takeUrl ?? undefined}
                className="mirror h-full w-full object-contain"
                playsInline
                muted
              />
            </div>
            <span className="absolute bottom-3 left-3 z-20 rounded-xl bg-black/60 px-2.5 py-1 text-xs font-semibold text-cream/85 backdrop-blur">
              Instructor
            </span>
            <span className="absolute bottom-3 right-3 z-20 rounded-xl bg-brand2/90 px-2.5 py-1 text-xs font-bold text-[#06222a]">
              You
            </span>
          </>
        )}
        {/* RATE MENU — the full run-through (scored per segment) or a single segment.
            With 2+ dancers in the video the backdrop stays light so the color-coded
            skeletons behind it are visible while picking. */}
        {inGo && segMode === 'menu' && (
          <div className={`absolute inset-0 z-30 flex items-center justify-center p-4 ${(track.dancers?.length ?? 0) > 1 ? 'bg-black/35' : 'bg-black/70 backdrop-blur-sm'}`}>
            <div className="w-full max-w-md rounded-2.5xl border border-line bg-panel/95 p-5 shadow-soft">
              <div className="flex items-center justify-between">
                <p className="font-display text-lg font-bold">🎯 Test my skills</p>
                <button onClick={exitRating} className="text-sm text-ink/50 transition hover:text-ink">✕ Exit</button>
              </div>
              <p className="mt-1 text-sm text-ink/55">Dance it to the music and get scored, with tips on exactly what to fix.</p>
              {track.dancers && track.dancers.length > 1 && (
                <div className="mt-3 rounded-xl border border-line bg-ink/[0.04] p-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-ink/45">
                    {track.dancers.length} dancers found · grade me against
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {track.dancers.map((_, i) => {
                      const color = DANCER_COLORS[i % DANCER_COLORS.length]!
                      const active = (track.activeDancer ?? 0) === i
                      return (
                        <button
                          key={i}
                          onClick={() => { void selectDancer(i).then(() => { const pb = playbackRef.current; if (pb) pb.seek(pb.getTime()) }) }}
                          className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition active:scale-95 ${active ? 'border-transparent text-[#0b0b16]' : 'border-line text-ink/70 hover:text-ink'}`}
                          style={active ? { background: color } : undefined}
                        >
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: active ? '#0b0b16' : color }} />
                          Dancer {i + 1}
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-xs text-ink/45">The skeletons on the video match these colors · your pick is the bold one.</p>
                </div>
              )}
              <button
                onClick={startRunThrough}
                className="mt-4 w-full rounded-2xl bg-brand2 px-5 py-3 text-left font-display text-base font-bold text-[#06222a] shadow-soft transition hover:brightness-105 active:scale-[0.99]"
              >
                ▶ Full run-through · recommended
                <span className="block text-xs font-medium text-[#06222a]/70">
                  Dance the whole thing once · every part scored, then a full recap
                </span>
              </button>
              <p className="mt-4 mb-2 text-xs font-medium uppercase tracking-wider text-ink/45">Or just one part</p>
              <div className="flex flex-wrap gap-2">
                {moves.filter((m) => !skip.includes(m.index)).map((m) => (
                  <button
                    key={m.index}
                    onClick={() => { raterQueueRef.current = []; startRating(m.startSec, m.endSec) }}
                    className="rounded-xl border border-line bg-ink/[0.06] px-4 py-2 text-sm font-semibold text-ink/80 transition hover:border-brand2/60 hover:text-ink active:scale-95"
                  >
                    {m.index + 1}
                  </button>
                ))}
              </div>
              {moves.length <= 1 && (
                <p className="mt-2 text-xs text-ink/40">
                  Parts come from the segments you cut in Practice · with none cut, the whole
                  dance is one part.
                </p>
              )}
              {camStatus !== 'ready' && (
                <p className="mt-4 flex items-center gap-2 text-xs text-ink/45">
                  {camStatus === 'error'
                    ? <span className="text-bad">{camError ?? 'No camera found.'}</span>
                    : <><span className="h-3 w-3 animate-spin rounded-full border-2 border-ink/30 border-t-ink/70" /> Warming up your camera…</>}
                </p>
              )}
            </div>
          </div>
        )}
        {/* RESULTS — your rating and exactly where it went wrong, then Done. */}
        {inGo && segMode === 'results' && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2.5xl border border-line bg-panel/95 p-5 shadow-soft">
              {testError ? (
                <>
                  <p className="font-display text-lg font-bold">Hmm — no dancer detected 🤔</p>
                  <p className="mt-2 text-sm text-ink/60">{testError}</p>
                </>
              ) : testResult ? (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-wider text-ink/45">Your match</p>
                      <p className="font-display text-5xl font-bold" style={{ color: scoreVerdict(testResult.score).color }}>
                        {Math.round(testResult.score)}%
                      </p>
                    </div>
                    <p className="pb-1 text-sm font-semibold" style={{ color: scoreVerdict(testResult.score).color }}>
                      {scoreVerdict(testResult.score).label}
                    </p>
                  </div>
                  <div className="mt-4 space-y-1.5">
                    {(Object.entries(testResult.perLimb) as [Limb, { errorDeg: number; ok: boolean }][]).map(([limb, res]) => (
                      <div key={limb} className="flex items-center gap-2">
                        <span className="w-20 shrink-0 text-xs text-ink/55">{LIMB_LABEL[limb]}</span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${limbQuality(res.errorDeg)}%`, background: res.ok ? '#a3e635' : '#ff9f1c' }}
                          />
                        </div>
                        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink/45">{limbQuality(res.errorDeg)}%</span>
                      </div>
                    ))}
                  </div>
                  <ul className="mt-4 space-y-1.5">
                    {feedbackLines(testResult).map((line, i) => (
                      <li key={i} className="text-sm text-ink/70">· {line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                {takeUrl && (
                  <button onClick={startReplay} className={btn + ' !border-brand2/50'} title="Watch your take next to the instructor">
                    🎬 Side by side
                  </button>
                )}
                <button onClick={() => { raterQueueRef.current = []; startRating(loopStartRef.current, loopEndRef.current) }} className={btn}>↻ Try again</button>
                <button onClick={() => setSegMode('menu')} className={btn}>🎯 Rate something else</button>
                <button
                  onClick={exitRating}
                  className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95"
                >
                  ✓ Done
                </button>
              </div>
            </div>
          </div>
        )}
        {/* SUMMARY — the full run-through recap: which segments you nailed, which need work. */}
        {inGo && segMode === 'summary' && runSummary && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div className="flex max-h-full w-full max-w-md flex-col rounded-2.5xl border border-line bg-panel/95 p-5 shadow-soft">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wider text-ink/45">Your run</p>
                  <p className="font-display text-5xl font-bold" style={{ color: scoreVerdict(runSummary.overall).color }}>
                    {Math.round(runSummary.overall)}%
                  </p>
                </div>
                <p className="pb-1 text-right text-xs text-ink/55">
                  {runSummary.nailed} nailed · {runSummary.close} close · {runSummary.off} to work on
                </p>
              </div>
              <div className="mt-4 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
                {runSummary.segments.map((s) => {
                  const tint = s.grade === 'nailed' ? '#a3e635' : s.grade === 'close' ? '#facc15' : '#ff5470'
                  const word = s.grade === 'nailed' ? 'Nailed it' : s.grade === 'close' ? 'Close' : 'Needs work'
                  return (
                    <div key={s.index} className="flex items-center gap-2 rounded-xl border border-line bg-ink/[0.03] px-3 py-2">
                      <span className="w-16 shrink-0 text-xs font-semibold text-ink/70">Segment {s.index + 1}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
                        <div className="h-full rounded-full" style={{ width: `${Math.round(s.score)}%`, background: tint }} />
                      </div>
                      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink/60">{Math.round(s.score)}%</span>
                      <span className="w-20 shrink-0 text-right text-xs font-semibold" style={{ color: tint }}>{word}</span>
                    </div>
                  )
                })}
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                <button onClick={startRunThrough} className={btn}>↻ Run again</button>
                <button onClick={() => setSegMode('menu')} className={btn}>🎯 One segment</button>
                <button
                  onClick={exitRating}
                  className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95"
                >
                  ✓ Done
                </button>
              </div>
            </div>
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
      ) : segMode === 'watch' ? (
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
            {hasFrames && !!videoUrl && (
              <button
                onClick={() => setTracking((v) => !v)}
                className={tracking ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn}
                title="Show or hide the tracked skeleton on the instructor"
              >
                🦴 Tracking
              </button>
            )}
            <button onClick={playAll} className={fullRun ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn} title="Practice the whole song start to finish">▶ Full song</button>
            <button onClick={editSegments} className={btn} title="Go back and edit the segments">✎ Edit segments</button>
            {voiceSupported && (
              <button onClick={() => setVoiceOn((v) => !v)} className={voiceOn ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn}>🎙</button>
            )}
          </div>

          {/* Got it / repeat — pure practice */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button onClick={() => gotoMove(nextOpen(moveIdx, -1))} className={btn + ' !px-3'}>‹ prev</button>
            <button onClick={repeatMove} className="rounded-xl border border-line bg-ink/[0.06] px-5 py-2.5 text-sm font-semibold text-ink/80 transition hover:text-ink active:scale-95">↻ Repeat</button>
            {selfView && !playbackOnly && (
              <button onClick={() => startSelfTry(moveIdxRef.current)} className="rounded-xl border border-brand2/50 bg-brand2/15 px-4 py-2.5 text-sm font-bold text-ink transition hover:bg-brand2/25 active:scale-95" title="Dance this segment once and watch it back">
                🎬 Record my take
              </button>
            )}
            <button onClick={completeSegment} className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95">
              ✓ Got it
            </button>
            <button onClick={() => gotoMove(nextOpen(moveIdx, 1))} className={btn + ' !px-3'}>skip ›</button>
          </div>

          {/* Finished everything → nudge toward the rater */}
          {!playbackOnly && moves.length > 0 && completed.length >= moves.length - skip.length && (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-brand2/40 bg-brand2/[0.08] px-4 py-3 text-center">
              <p className="text-sm font-semibold text-ink">Great job — you got the whole thing! 🎉</p>
              <button
                onClick={enterRating}
                className="rounded-xl bg-brand2 px-5 py-2.5 text-sm font-bold text-[#06222a] shadow-soft transition hover:brightness-105 active:scale-95"
              >
                🎯 Test your skills on camera →
              </button>
            </div>
          )}

          {/* Coaching line */}
          <div className="flex min-h-[24px] items-center justify-center text-sm">
            {toast ? (
              <span className="rounded-full bg-good/20 px-3 py-1 font-semibold text-good">{toast}</span>
            ) : (
              <span className="text-ink/40">
                {selfView
                  ? 'Dance beside yourself, then 🎬 Record my take to watch it back.'
                  : 'Drill this segment, then ✓ Got it for the next one.'}
              </span>
            )}
          </div>
        </>
      ) : segMode === 'replay' ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button onClick={replayBoth} className="rounded-xl bg-brand px-6 py-2.5 text-sm font-semibold text-cream shadow-glow transition hover:brightness-105 active:scale-95">
            ▶ Replay
          </button>
          {selfView && !rating ? (
            <>
              <button onClick={() => startSelfTry(moveIdxRef.current)} className={btn}>↻ Record again</button>
              <button
                onClick={() => { exitTestFlow(); completeSegment() }}
                className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95"
              >
                Next segment ›
              </button>
            </>
          ) : (
            <>
              <button onClick={backToResults} className={btn}>‹ Back to feedback</button>
              <button
                onClick={exitRating}
                className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95"
              >
                ✓ Done
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-[24px] items-center justify-center text-sm">
          <span className="text-ink/40">
            {segMode === 'menu' ? 'Pick what to test.' : segMode === 'test' ? '🎥 Dance it — you’re being scored.' : segMode === 'selftry' ? '🎬 Dance the segment — recording your take.' : segMode === 'summary' ? 'Your run recap is above.' : 'Check your feedback above.'}
          </span>
        </div>
      )}

      {(selfView || rating) && cameras.length > 0 && (
        <div className="flex justify-center">
          <select value={activeCam ?? ''} onChange={(e) => void switchCamera(e.target.value)} className="max-w-[240px] truncate rounded-xl border border-line bg-panel px-2 py-1.5 text-xs text-ink/80 outline-none">
            {cameras.map((c, i) => <option key={c.deviceId || i} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}
