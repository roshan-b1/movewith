import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../../state/sessionStore'
import { PlaybackController } from '../../engine/playback'
import { PracticeEngine, type ReferenceContext } from '../../engine/practiceEngine'
import { startCamera, listVideoInputs, preferredCameraId, cameraErrorMessage, type CameraHandle } from '../../engine/camera'
import { getPoseProvider } from '../../providers/instance'
import { anglesAtFrames, sectionAnglesFrames, nearestFrameIndex } from '../../core/reference/build'
import { medianX } from '../../core/pose/people'
import { scoreSectionDetailed, summarizeRun, describeTiming, type DetailedSectionScore, type RunSummary } from '../../core/compare/score'
import { STRICT, LOOSE, type ScoreConfig, type Limb } from '../../core/compare/similarity'
import type { Section } from '../../core/audio/beats'
import {
  type Move,
  buildMovesFromBounds,
  evenMoveBounds,
  autoMoveBounds,
} from '../../core/reference/segment'
import { detectTalkingRanges, overlapFraction } from '../../core/reference/talking'
import { captureDancerThumbs } from '../components/dancerThumbs'
import { loopWrapAction } from '../../core/practice/loopWrap'
import { sliceTakeBySegments } from '../../core/practice/takeSlice'
import { comboSpan } from '../../core/practice/combo'
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
  if (score >= 70) return { label: 'Close · tighten it up', color: '#facc15' }
  if (score >= 50) return { label: 'Getting there', color: '#ff9f1c' }
  return { label: 'Keep drilling this one', color: '#ff5470' }
}
/** Human feedback lines: which limbs drifted (and how far), and when it slipped. */
function feedbackLines(r: DetailedSectionScore): string[] {
  const lines: string[] = []
  const limbs = (Object.entries(r.perLimb) as [Limb, { errorDeg: number; ok: boolean }][])
    .sort((a, b) => b[1].errorDeg - a[1].errorDeg)
  for (const [limb, res] of limbs.slice(0, 2)) {
    if (!res.ok) lines.push(`${LIMB_LABEL[limb]} drifted ~${Math.round(res.errorDeg)}° from the move: ${LIMB_ADVICE[limb]}.`)
  }
  if (r.phases.length === 3) {
    const worst = r.phases.reduce((a, b) => (b.score < a.score ? b : a))
    const best = r.phases.reduce((a, b) => (b.score > a.score ? b : a))
    if (best.score - worst.score > 12) {
      lines.push(`The ${PHASE_LABEL[worst.phase]} slipped the most (${Math.round(worst.score)}% there).`)
    }
  }
  if (lines.length === 0) lines.push('Clean run · everything tracked tight to the reference. 🔥')
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
  const saveReport = useSession((s) => s.saveReport)
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
  // The camera turns on in exactly one place — the rater ("Test my skills"), where the pose
  // engine scores you and records your take. Plain practice never touches the camera.
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
  // How many consecutive segments loop together (1 = one move at a time). Combining is how
  // you rehearse the JOIN between moves, which drilling them separately never covers.
  const [comboCount, setComboCount] = useState(1)
  const comboCountRef = useRef(1)
  const [previewIdx, setPreviewIdx] = useState(-1) // segment being loop-previewed in the editor
  const [creating, setCreating] = useState(false) // segment-creator mode (tap to place cuts)
  const [meter, setMeter] = useState(0)
  const [camStatus, setCamStatus] = useState<'init' | 'ready' | 'error'>('init')
  const [camError, setCamError] = useState<string | null>(null)
  const [noBody, setNoBody] = useState(false)
  // segMode drives what the stage is doing:
  //  - 'watch'   plain practice (loop, Got it) — no camera, no tracking, no recording
  //  - 'runthrough' the final practice pass: the whole routine once, still no camera
  //  - 'runthrough' the final practice pass: the whole routine, cycling, still no camera
  //  - 'menu'    the rater's pick-what-to-rate screen
  //  - 'test'    the rater: dance a range once, being scored + recorded (reference audio only)
  //  - 'results' single-segment score + tips
  //  - 'summary' full run-through recap (per-segment grades)
  //  - 'replay'  side-by-side: instructor + your recorded take (watch yourself back)
  const [segMode, setSegMode] = useState<'watch' | 'runthrough' | 'recordrun' | 'menu' | 'test' | 'results' | 'summary' | 'replay'>('watch')
  /** Per-slot scores from the last take (one entry per tracked dancer, display order). */
  const [testResults, setTestResults] = useState<(DetailedSectionScore | null)[]>([])
  /** Per-slot coaching lines about being ahead of / behind the music (null = on time). */
  const [testTimings, setTestTimings] = useState<(string | null)[]>([])
  const [testError, setTestError] = useState<string | null>(null)
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null)
  /** Group run-through recap: one RunSummary per tracked dancer (display order). */
  const [multiRun, setMultiRun] = useState<{ dancers: number[]; summaries: RunSummary[] } | null>(null)
  /** Which reference dancers the group is testing against (dancer indices, unordered). */
  const [testDancers, setTestDancers] = useState<number[]>([track.activeDancer ?? 0])
  /** Snapshot of each dancer cropped from the video, so the picker shows WHO is who. */
  const [dancerThumbs, setDancerThumbs] = useState<(string | null)[]>([])
  /** Object URL of the camera recording captured during the last take. */
  const [takeUrl, setTakeUrl] = useState<string | null>(null)
  // "Record my run": an OPT-IN camera pass over the whole routine in plain practice (no
  // scoring), so you can watch yourself back. Stays on through its watch-back replay so
  // "Record again" is instant; false the rest of the time (practice is camera-free).
  const [recordRun, setRecordRun] = useState(false)
  // Where ✓/‹ Back go when leaving side-by-side replay: the single-segment feedback, the
  // full-run summary, or back to plain practice (a record-my-run watch-back).
  const [replayReturn, setReplayReturn] = useState<'results' | 'summary' | 'practice'>('results')
  // The camera owns the whole stage while the rater scores you.
  const camMain = scoring && (segMode === 'test' || segMode === 'results')
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

  // Which segments are looping together right now (for the badge and the coaching line).
  const comboIndices = useMemo(
    () => comboSpan(moves, skip, moveIdx, comboCount)?.indices ?? [moveIdx],
    [moves, skip, moveIdx, comboCount],
  )

  // Nobody picked yet: the rater can't start, but the chips stay freely toggleable so you
  // can always swap who you're being graded against.
  const multiDancer = (track.dancers?.length ?? 0) > 1
  const noDancerPicked = multiDancer && testDancers.length === 0

  // The tracked "slots" for Test my skills: the chosen reference dancers ordered as they
  // appear on screen (left → right), so a group just stands the way the video looks.
  const slotInfo = useMemo(() => {
    const ds = track.dancers
    if (!ds || ds.length <= 1) return { dancers: [track.activeDancer ?? 0], frames: [track.frames] }
    const chosen = testDancers.filter((i) => ds[i])
    const picked = chosen.length ? chosen : [0]
    const ordered = picked.slice().sort((a, b) => medianX(ds[a]!) - medianX(ds[b]!))
    return { dancers: ordered, frames: ordered.map((i) => ds[i]!) }
  }, [track, testDancers])

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
  const ratingRef = useRef(false)
  const completedRef = useRef<number[]>([])
  const countdownTimerRef = useRef<number | null>(null)
  const voiceHandlerRef = useRef<(c: VoiceCommand) => void>(() => {})
  const segModeRef = useRef<'watch' | 'runthrough' | 'recordrun' | 'menu' | 'test' | 'results' | 'summary' | 'replay'>('watch')
  /** True while the rater is recording a single scored pass (the segment playing once through). */
  const testActiveRef = useRef(false)
  /** True while the current take is the full-dance pass (sliced per segment afterwards). */
  const wholeRunRef = useRef(false)
  /** True across a record-my-run session (the recording pass + its watch-back). */
  const recordRunRef = useRef(false)
  /** Guards the one-shot "camera is warm, start the record pass" trigger. */
  const recordStartedRef = useRef(false)
  /** Playback rate the current take was danced at, so replay matches it and stays in sync. */
  const takeRateRef = useRef(1)
  const finishTestRef = useRef<() => void>(() => {})
  const finishRecordRunRef = useRef<() => void>(() => {})
  const cancelTestRef = useRef<() => void>(() => {})
  const cancelRecordRunRef = useRef<() => void>(() => {})
  const recorderRef = useRef<MediaRecorder | null>(null)
  /** Slot data mirrored into refs so the 30fps engine callback reads fresh selection. */
  const slotFramesRef = useRef(slotInfo.frames)
  const slotDancersRef = useRef(slotInfo.dancers)
  const testDancersRef = useRef(testDancers)
  const takeChunksRef = useRef<Blob[]>([])
  const takeUrlRef = useRef<string | null>(null)
  const takeVideoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => void (segModeRef.current = segMode), [segMode])
  useEffect(() => void (completedRef.current = completed), [completed])
  useEffect(() => {
    slotFramesRef.current = slotInfo.frames
    slotDancersRef.current = slotInfo.dancers
    testDancersRef.current = testDancers
  }, [slotInfo, testDancers])

  useEffect(() => void (trackRef.current = track), [track])
  useEffect(() => {
    mirrorRef.current = mirror
    // Force an instructor redraw so the flip shows immediately, even while paused.
    const pb = playbackRef.current
    if (pb) pb.seek(pb.getTime())
  }, [mirror])
  useEffect(() => void (phaseRef.current = phase), [phase])
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
      void updateProgress({ ...base, setup: { trimStart, trimEnd, moveBounds, moveSec, reps, breakSecs, skip } })
    }, 500)
    return () => window.clearTimeout(id)
  }, [trimStart, trimEnd, moveBounds, moveSec, reps, breakSecs, skip, track.id, updateProgress])
  useEffect(() => void (creatingRef.current = creating), [creating])
  useEffect(() => void (movesRef.current = moves), [moves])
  useEffect(() => void (moveIdxRef.current = moveIdx), [moveIdx])
  useEffect(() => void (repsRef.current = reps), [reps])
  useEffect(() => void (breakRef.current = breakSecs), [breakSecs])
  useEffect(() => void (scoringRef.current = scoring), [scoring])
  useEffect(() => void (ratingRef.current = rating), [rating])
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
            const active = testDancersRef.current.includes(di)
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
        // Practice never draws a tracked skeleton over the instructor — it's just watch
        // and try. Tracking lives only in "Test my skills" (on your own camera).
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
        // The playhead jumped back to the start of the region: that pass just finished.
        // What that MEANS is decided by loopWrapAction (pure + unit-tested).
        pb.pause()
        const action = loopWrapAction({
          takeActive: testActiveRef.current,
          recordRun: recordRunRef.current && segModeRef.current === 'recordrun',
          segMode: segModeRef.current,
          repsSoFar: repCounterRef.current,
          repLimit: repsRef.current,
        })
        if (action === 'finishTake') {
          testActiveRef.current = false
          finishTestRef.current()
        } else if (action === 'finishRecordRun') {
          finishRecordRunRef.current()
        } else if (action === 'hold') {
          // Side-by-side replay ran the segment once; hold at the end for ▶ Replay.
          // (The take video simply ends on its own.)
        } else if (action === 'repsDone') {
          repCounterRef.current = 0
          flashToast('Done · ✓ Got it for the next one, or ↻ repeat')
        } else {
          repCounterRef.current += 1
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

  // Camera + pose engine. Runs in the rater ("Test my skills") and during an opt-in
  // "record my run" pass, and only once you're actually practicing (phase 'go') — never
  // during setup, segment cutting, or plain (camera-free) practice. The pose engine only
  // starts when scoring; a record-run just needs the raw stream to record.
  useEffect(() => {
    if ((!rating && !recordRun) || playbackOnly || phase !== 'go') return
    let cam: CameraHandle | null = null
    let disposed = false
    const getReference = (): ReferenceContext => {
      const pb = playbackRef.current
      const slots = slotFramesRef.current
      if (!pb) return { anglesList: slots.map(() => null), mirror: mirrorRef.current, timeSec: 0 }
      const t = pb.getTime()
      return { anglesList: slots.map((fr) => anglesAtFrames(fr, t)), mirror: mirrorRef.current, timeSec: t }
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
            if (ctx) {
              // Project through the SAME object-cover geometry the <video> uses, or the
              // lines sit off the body (they'd be stretched to the box while the video
              // underneath is cropped).
              const proj = coverProjector(webcam.videoWidth, webcam.videoHeight)
              const multi = slotDancersRef.current.length > 1
              ctx.clearRect(0, 0, canvas.width, canvas.height)
              r.people.forEach((p, i) => {
                if (!p.image) return
                // Solo: per-limb good/bad colors. Group: each person wears their chosen
                // dancer's color so everyone can tell whose skeleton is whose.
                drawSkeleton(ctx, p.image, {
                  perLimb: multi ? undefined : p.frame?.perLimb,
                  baseColor: multi
                    ? DANCER_COLORS[(slotDancersRef.current[i] ?? i) % DANCER_COLORS.length]
                    : undefined,
                  project: proj,
                  minVisibility: 0.3,
                  lineWidth: Math.max(2, canvas.width * 0.008),
                  clear: false,
                })
              })
            }
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
        setCamError(cameraErrorMessage(e))
      }
    })()
    return () => {
      disposed = true
      engineRef.current?.stop(); engineRef.current = null
      ;(camRef.current ?? cam)?.stop(); camRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, rating, recordRun, playbackOnly, phase])

  useEffect(() => {
    const cs = [instructorCanvasRef.current, instructorOverlayRef.current, webcamCanvasRef.current].filter(
      (c): c is HTMLCanvasElement => c != null,
    )
    if (cs.length === 0) return
    cs.forEach(sizeCanvas)
    const ro = new ResizeObserver(() => cs.forEach(sizeCanvas))
    cs.forEach((c) => ro.observe(c))
    return () => ro.disconnect()
  }, [videoUrl, rating, camStatus, phase, segMode])

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

  // Keep the live camera element actually playing whenever it's on screen (fullscreen test
  // or the menu tile). Some browsers park a video that was display:none, so nudge it on every
  // visibility change — the dancer must always see themselves during the test.
  useEffect(() => {
    if (camMain || !replaying) void webcamVideoRef.current?.play().catch(() => { /* not ready yet */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camMain, replaying, camStatus])

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

  // Snapshot each dancer once the picker is up, so "Dancer 1 / Dancer 2" have faces.
  // Decoding happens off to the side; the on-screen video never moves.
  useEffect(() => {
    const ds = track.dancers
    if (segMode !== 'menu' || !videoUrl || !ds || ds.length <= 1 || dancerThumbs.length === ds.length) return
    let cancelled = false
    void captureDancerThumbs(videoUrl, ds, trimStart, trimEnd).then((thumbs) => {
      if (!cancelled) setDancerThumbs(thumbs)
    })
    return () => { cancelled = true }
  }, [segMode, videoUrl, track, trimStart, trimEnd, dancerThumbs.length])

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
      // A hidden tab freezes the clock mid-take — abandon the test/record cleanly instead
      // of leaving it stuck; the dancer can just start again when they're back.
      if (testActiveRef.current) cancelTestRef.current()
      else if (recordRunRef.current && segModeRef.current === 'recordrun') cancelRecordRunRef.current()
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
    setTestResults([]); setTestError(null)
  }

  // ===== Test my skills (the rater) — a top-level, camera-on scoring flow =====

  /** Enter the rater: camera on, show the pick-what-to-rate menu. */
  function enterRating() {
    if (playbackOnly) return
    clearCountdown()
    playbackRef.current?.pause(); setPlaying(false)
    setTestResults([]); setTestTimings([]); setTestError(null); setRunSummary(null); setMultiRun(null); setTakeUrl(null)
    wholeRunRef.current = false
    setRating(true); ratingRef.current = true
    setSegMode('menu'); segModeRef.current = 'menu'
  }

  /** Leave the rater entirely and return to the library (it's its own top-level mode). */
  function exitRating() {
    testActiveRef.current = false
    dropTakeRecording()
    wholeRunRef.current = false
    setRating(false); ratingRef.current = false
    back()
  }

  /** Rate a range [s,e] once, with the music. `whole` means this is the full-dance pass,
   *  which gets sliced back into segments for the recap. */
  function startRating(s: number, e: number, whole = false) {
    clearCountdown()
    const pb = playbackRef.current
    if (!pb) return
    pb.pause(); setPlaying(false)
    setTestResults([]); setTestError(null)
    setMeter(0)
    wholeRunRef.current = whole
    setSegMode('test'); segModeRef.current = 'test'
    setLoopRegion(s, e)
    runCountdown(() => {
      const p = playbackRef.current
      if (!p) return
      prevTimeRef.current = s
      testActiveRef.current = true
      takeRateRef.current = rateRef.current // replay the reference at the speed you danced
      engineRef.current?.startRecording()
      startTakeRecording()
      p.play(); setPlaying(true)
    }, whole ? 'Dance the whole thing in' : 'Your turn in', 3)
  }

  /** Dance the whole routine once, straight through, to the music. The parts you cut and
   *  the bits you marked skip are honoured (playback jumps them), and the single take is
   *  sliced up afterwards so you still get a part-by-part recap. */
  function startWholeDanceRun() {
    startRating(trimStartRef.current, trimEndRef.current, true)
  }

  /** Restart whatever is currently being tested, from the top. */
  function restartTest() {
    testActiveRef.current = false
    engineRef.current?.stopRecording()
    dropTakeRecording()
    startRating(loopStartRef.current, loopEndRef.current, wholeRunRef.current)
  }

  /** A rated range finished playing: grade every tracked dancer. The full-dance pass is
   *  one continuous take, sliced per segment for the recap; a single part shows detail. */
  function finishTest() {
    playbackRef.current?.pause()
    setPlaying(false)
    stopTakeRecording(true) // finalize the camera recording for side-by-side replay
    const eng = engineRef.current
    const tr = trackRef.current
    const takes = eng ? eng.stopRecording() : []
    const s = loopStartRef.current
    const e = loopEndRef.current

    if (wholeRunRef.current) {
      wholeRunRef.current = false
      const segs = movesRef.current.filter((m) => !skipRef.current.includes(m.index))
      // Slice the ONE take by instructor time, so each part is scored from the pass the
      // dancer actually did in one go.
      const summaries = slotFramesRef.current.map((fr, k) => {
        const parts = sliceTakeBySegments(takes[k] ?? [], segs)
        return summarizeRun(parts.map((part) => {
          const m = segs.find((x) => x.index === part.index)!
          const refAngles = sectionAnglesFrames(fr, m.startSec, m.endSec)
          const sc = refAngles.length >= 2 && part.angles.length >= 3
            ? scoreSectionDetailed(refAngles, part.angles, cfgRef.current)
            : null
          return { index: part.index, score: sc?.score ?? 0, worstLimb: sc?.worstLimb ?? null }
        }))
      })
      const sawAnyone = takes.some((t) => (t?.length ?? 0) >= 3)
      if (!sawAnyone) {
        setTestResults([])
        setTestError(
          slotFramesRef.current.length > 1
            ? "We couldn't see anyone dancing. Make sure everyone's whole body is in frame, then try again."
            : "We couldn't see you dancing. Make sure your whole body is in frame, then try again.",
        )
        setSegMode('results'); segModeRef.current = 'results'
        return
      }
      if (summaries.length > 1) {
        setMultiRun({ dancers: slotDancersRef.current.slice(), summaries })
        setRunSummary(null)
      } else {
        setRunSummary(summaries[0] ?? null)
        setMultiRun(null)
      }
      // Save a report for the dance card (the best dancer's run when it's a group).
      const best = summaries.reduce((a, b) => (b.overall > a.overall ? b : a))
      void saveReport(tr.id, { at: Date.now(), overall: best.overall, nailed: best.nailed, close: best.close, off: best.off })
      setSegMode('summary'); segModeRef.current = 'summary'
      return
    }

    // One score per slot: each tracked person vs THEIR reference dancer's timeline.
    const perSlot = slotFramesRef.current.map((fr, i) => {
      const take = (takes[i] ?? []).map((f) => f.angles)
      const refAngles = sectionAnglesFrames(fr, s, e)
      return take.length >= 3 && refAngles.length >= 2 ? scoreSectionDetailed(refAngles, take, cfgRef.current) : null
    })
    const ok = perSlot.some((p) => p !== null)
    setTestResults(perSlot)
    setTestTimings(
      perSlot.map((p) => (p ? describeTiming(p.timingNorm, e - s, tr.tempo.beatIntervalSec) : null)),
    )
    setTestError(
      ok
        ? null
        : slotFramesRef.current.length > 1
          ? "We couldn't see anyone dancing. Make sure everyone's whole body is in frame, then try again."
          : "We couldn't see you dancing. Make sure your whole body is in frame, then try again.",
    )
    setSegMode('results'); segModeRef.current = 'results'
  }
  finishTestRef.current = finishTest

  function cancelTest() {
    clearCountdown()
    testActiveRef.current = false
    engineRef.current?.stopRecording()
    dropTakeRecording()
    playbackRef.current?.pause(); setPlaying(false)
    setTestResults([]); setTestError(null)
    wholeRunRef.current = false
    setSegMode('menu'); segModeRef.current = 'menu'
  }
  cancelTestRef.current = cancelTest

  // ---- Side-by-side replay: the reference segment and YOUR recorded take, together ----

  function startReplay() {
    if (!takeUrlRef.current) return
    // Remember where ✓/‹ Back should return to (single-segment feedback vs the run summary).
    setReplayReturn(segModeRef.current === 'summary' ? 'summary' : 'results')
    playbackRef.current?.pause()
    setSegMode('replay'); segModeRef.current = 'replay'
    window.setTimeout(replayBoth, 80) // let the take <video> mount before playing
  }
  /** (Re)start both sides in sync from the top. The take video plays at its native 1x;
   *  the reference matches the speed the take was danced at, so they stay locked. */
  function replayBoth() {
    const pb = playbackRef.current
    if (!pb) return
    pb.setRate(takeRateRef.current)
    pb.seek(loopStartRef.current)
    prevTimeRef.current = loopStartRef.current
    awaitingSeekRef.current = loopStartRef.current
    lastSeekMsRef.current = performance.now()
    const tv = takeVideoRef.current
    if (tv) { tv.currentTime = 0; void tv.play().catch(() => {}) }
    pb.play(); setPlaying(true)
  }
  /** Leave replay back to the feedback it came from, restoring the practice speed. */
  function backToResults() {
    playbackRef.current?.pause(); setPlaying(false)
    playbackRef.current?.setRate(rateRef.current)
    takeVideoRef.current?.pause()
    const dest = replayReturn === 'summary' ? 'summary' : 'results'
    setSegMode(dest); segModeRef.current = dest
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

  /** Segments currently looping together (just the one unless combo practice is on). */
  function currentCombo(idx: number) {
    return comboSpan(movesRef.current, skipRef.current, idx, comboCountRef.current)
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
    const span = currentCombo(idx)
    setLoopRegion(span?.startSec ?? m.startSec, span?.endSec ?? m.endSec)
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
      const span = currentCombo(idx)
      setLoopRegion(span?.startSec ?? m.startSec, span?.endSec ?? m.endSec)
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
    // Combining? You just danced all of them, so they all count as got.
    const justDone = currentCombo(cur)?.indices ?? [cur]
    const done = [...completedRef.current]
    for (const i of justDone) if (!done.includes(i)) done.push(i)
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
  // (Re)detect the moves for a range. 'auto' cuts on distinct-movement changes and
  // pre-skips talking/explaining stretches; 'even' spaces them evenly. Clears progress
  // since the moves changed.
  function segmentInto(s: number, e: number, mode: 'auto' | 'even') {
    const bounds = mode === 'auto'
      ? autoMoveBounds(trackRef.current.frames, s, e, moveSec, trackRef.current.tempo)
      : evenMoveBounds(s, e, moveSec)
    setMoveBounds(bounds)
    setCompleted([]); completedRef.current = []
    // Auto-detect also spots where the instructor is talking rather than dancing (legs
    // near-still for a sustained stretch) and pre-skips those segments. ⊘ undoes any.
    let skipped: number[] = []
    if (mode === 'auto' && trackRef.current.frames.length > 0) {
      const talk = detectTalkingRanges(trackRef.current.frames, s, e)
      if (talk.length > 0) {
        skipped = buildMovesFromBounds(s, e, bounds)
          .filter((m) => overlapFraction(talk, m.startSec, m.endSec) >= 0.6)
          .map((m) => m.index)
      }
      if (skipped.length > 0) {
        flashToast(`⊘ Skipped ${skipped.length} talking ${skipped.length === 1 ? 'part' : 'parts'} · tap ⊘ to undo`)
      }
    }
    setSkip(skipped)
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

  // ===== The final practice pass: the whole routine once, still camera-free =====

  /** Dance the whole routine start to finish. It keeps cycling (with the usual break
   *  between passes) until they tap Got it — nothing else counts as finishing it. */
  function startPracticeRun() {
    const pb = playbackRef.current
    if (!pb) return
    clearCountdown()
    if (segModeRef.current !== 'watch') exitTestFlow()
    // Pause BEFORE arming the run: if the previous loop were still rolling, a wrap during
    // the countdown would be read as a completed pass.
    pb.pause(); setPlaying(false)
    setFullRun(false); fullRunRef.current = false
    setMoveIdx(0); moveIdxRef.current = 0
    setSegMode('runthrough'); segModeRef.current = 'runthrough'
    setLoopRegion(trimStartRef.current, trimEndRef.current)
    runCountdown(() => {
      const p = playbackRef.current
      if (!p) return
      prevTimeRef.current = trimStartRef.current
      p.play(); setPlaying(true)
    }, 'Full run-through in', 3)
  }

  /** Leave the run-through: Got it hands off to the camera, otherwise back to drilling. */
  function finishPracticeRun(gotIt: boolean) {
    clearCountdown()
    playbackRef.current?.pause(); setPlaying(false)
    setSegMode('watch'); segModeRef.current = 'watch'
    if (gotIt && !playbackOnly) { enterRating(); return }
    if (gotIt) { flashToast('Nailed the whole routine 🎉'); return }
    flashToast('No worries · drill any segment, then run it again')
    gotoMove(0)
  }

  // ===== Record my run: an opt-in single camera pass over the whole routine, no scoring,
  // just so you can watch yourself back side by side. =====

  /** Arm a recorded pass: turn the camera on and wait for it to warm. The pass itself is
   *  kicked off by the effect below once the stream is ready (so we never record blind). */
  function startRecordRun() {
    const pb = playbackRef.current
    if (!pb) return
    clearCountdown()
    if (segModeRef.current !== 'watch') exitTestFlow()
    pb.pause(); setPlaying(false)
    dropTakeRecording()
    setFullRun(false); fullRunRef.current = false
    setMoveIdx(0); moveIdxRef.current = 0
    recordStartedRef.current = false
    setRecordRun(true); recordRunRef.current = true
    setSegMode('recordrun'); segModeRef.current = 'recordrun'
    setLoopRegion(trimStartRef.current, trimEndRef.current)
  }

  /** The recorded pass finished its single loop: stop recording and watch it back. */
  function finishRecordRun() {
    playbackRef.current?.pause(); setPlaying(false)
    recordStartedRef.current = false
    stopTakeRecording(true) // onstop builds the take URL; the effect below auto-plays replay
    setReplayReturn('practice')
    setSegMode('replay'); segModeRef.current = 'replay'
  }
  finishRecordRunRef.current = finishRecordRun

  /** Stop recording and drop the camera, then resume the looping run-through camera-free.
   *  Used on Cancel, a blocked camera, or the tab going hidden mid-record. */
  function cancelRecordRun() {
    clearCountdown()
    recordStartedRef.current = false
    dropTakeRecording()
    setRecordRun(false); recordRunRef.current = false
    playbackRef.current?.pause(); setPlaying(false)
    startPracticeRun()
  }
  cancelRecordRunRef.current = cancelRecordRun

  /** Done watching a recorded run back: drop the camera and return to the looping
   *  run-through, so you can keep dancing it (and record another whenever you want). */
  function doneRecordReplay() {
    takeVideoRef.current?.pause()
    playbackRef.current?.setRate(rateRef.current)
    setRecordRun(false); recordRunRef.current = false
    startPracticeRun()
  }

  // Once the camera is warm, actually start the recorded pass (3-2-1, then play + record).
  useEffect(() => {
    if (segMode !== 'recordrun' || camStatus !== 'ready' || recordStartedRef.current) return
    recordStartedRef.current = true
    runCountdown(() => {
      const p = playbackRef.current
      if (!p) return
      prevTimeRef.current = trimStartRef.current
      takeRateRef.current = rateRef.current
      startTakeRecording()
      p.play(); setPlaying(true)
    }, 'Recording in', 3)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segMode, camStatus])

  // A record-my-run take is ready → auto-play the side-by-side watch-back.
  useEffect(() => {
    if (segMode === 'replay' && replayReturn === 'practice' && takeUrl) {
      const id = window.setTimeout(replayBoth, 90)
      return () => window.clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeUrl, segMode, replayReturn])

  function togglePlay() {
    // Don't let Space/Play interrupt a test take, a recorded pass, the final pass, or replay.
    if (['test', 'recordrun', 'replay', 'runthrough'].includes(segModeRef.current)) return
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
                : segMode === 'recordrun'
                  ? '🎥 Recording your run'
                  : segMode === 'replay' && replayReturn === 'practice'
                    ? 'Watch yourself back'
                    : segMode === 'runthrough'
                      ? 'Full run-through'
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
            {segMode === 'recordrun'
              ? '🎥 Recording'
              : segMode === 'replay' && replayReturn === 'practice'
                ? 'Watch yourself back'
                : segMode === 'runthrough'
                  ? 'Full run-through'
                  : fullRun
                    ? 'Full song'
                    : comboIndices.length > 1
                      ? `Segments ${comboIndices.map((i) => i + 1).join(' + ')}`
                      : `Segment ${moveIdx + 1} of ${moves.length}`}
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
        {/* Start the take over, or bail out of the camera test entirely. */}
        {inGo && segMode === 'test' && (
          <div className="absolute right-3 top-3 z-20 flex gap-2">
            <button
              onClick={restartTest}
              title="Start this take again from the top"
              className="rounded-2xl border border-line bg-black/50 px-3 py-2 text-sm font-semibold text-cream/90 backdrop-blur transition hover:border-brand2/60 active:scale-95"
            >
              ↻ Restart
            </button>
            <button
              onClick={cancelTest}
              className="rounded-2xl border border-line bg-black/50 px-3 py-2 text-sm font-semibold text-cream/90 backdrop-blur transition hover:border-bad/60 active:scale-95"
            >
              ✕ Cancel
            </button>
          </div>
        )}
        {/* Mirror is done by flipping the CANVAS draw (see drawInstructor), never by
            CSS-transforming the <video> — that tore into a split-screen on Windows. When
            mirrored the canvas paints the flipped video over the (untouched) <video>.
            During a camera test the reference video goes invisible (NOT unmounted — it keeps
            playing so ONLY its sound drives your take, never the picture). In side-by-side
            replay it shrinks to the LEFT HALF, with your recorded take on the right. */}
        <div className={camMain ? 'pointer-events-none absolute inset-0 opacity-0' : replaying ? 'absolute inset-y-0 left-0 w-1/2' : 'absolute inset-0'}>
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
        {inGo && (rating || recordRun) && (
          <div
            className={
              camMain
                ? 'absolute inset-0 z-10 bg-black'
                : replaying
                  ? 'hidden'
                  : segMode === 'menu' || segMode === 'recordrun'
                    ? 'absolute bottom-3 right-3 z-10 h-36 w-28 overflow-hidden rounded-2xl border border-line bg-black shadow-soft sm:h-44 sm:w-36'
                    : 'hidden'
            }
          >
            <div className="mirror absolute inset-0">
              <video ref={webcamVideoRef} className="h-full w-full object-cover" playsInline muted />
              <canvas ref={webcamCanvasRef} className="absolute inset-0 h-full w-full" />
            </div>
            {!camMain && camStatus === 'ready' && segMode !== 'recordrun' && (
              <span className="absolute bottom-1 left-1 z-20 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-cream/85 backdrop-blur">
                You
              </span>
            )}
            {segMode === 'recordrun' && camStatus === 'ready' && (
              <span className="absolute bottom-1 left-1 z-20 flex items-center gap-1 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-cream backdrop-blur">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bad" /> REC
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
                  🎥 Your turn · dance it!
                </span>
                {camStatus === 'ready' && noBody && (
                  <p className="absolute inset-x-0 bottom-16 text-center text-sm font-semibold text-warn drop-shadow">step into frame</p>
                )}
                <div className="absolute inset-x-4 bottom-3"><AccuracyMeter score={meter} compact label="Match" /></div>
              </>
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
            {/* max-h-full + scroll: with a dancer picker and many parts this panel can grow
                taller than the stage, and without a cap the top scrolls out of reach. */}
            <div className="max-h-full w-full max-w-md overflow-y-auto rounded-2.5xl border border-line bg-panel/95 p-5 shadow-soft">
              <div className="flex items-center justify-between">
                <p className="font-display text-lg font-bold">🎯 Test my skills</p>
                <button onClick={exitRating} className="text-sm text-ink/50 transition hover:text-ink">✕ Exit</button>
              </div>
              <p className="mt-1 text-sm text-ink/55">Dance it to the music and get scored, with tips on exactly what to fix.</p>
              {track.dancers && track.dancers.length > 1 && (
                <div className="mt-3 rounded-xl border border-line bg-ink/[0.04] p-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-ink/45">
                    {track.dancers.length} dancers found · tap everyone who's dancing
                  </p>
                  {/* Each card shows that dancer cropped from the video, so you pick a
                      PERSON you recognize rather than guessing what "Dancer 2" means. */}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {track.dancers.map((_, i) => {
                      const color = DANCER_COLORS[i % DANCER_COLORS.length]!
                      const active = testDancers.includes(i)
                      const thumb = dancerThumbs[i]
                      return (
                        <button
                          key={i}
                          onClick={() => {
                            // Free toggling, including down to none — starting is gated on
                            // the selection instead, so nobody gets stuck unable to swap.
                            const next = testDancers.includes(i)
                              ? testDancers.filter((x) => x !== i)
                              : [...testDancers, i]
                            setTestDancers(next)
                            // A solo pick also becomes the practice dancer, like before.
                            if (next.length === 1) void selectDancer(next[0]!)
                            const pb = playbackRef.current
                            if (pb) pb.seek(pb.getTime())
                          }}
                          className={`relative overflow-hidden rounded-xl border-2 transition active:scale-95 ${active ? 'shadow-glow' : 'border-line opacity-70 hover:opacity-100'}`}
                          style={{ borderColor: active ? color : undefined, width: 78 }}
                          title={`Dancer ${i + 1}`}
                        >
                          {thumb ? (
                            <img src={thumb} alt={`Dancer ${i + 1}`} className="h-24 w-full object-cover" />
                          ) : (
                            <div className="flex h-24 w-full items-center justify-center bg-ink/10 text-2xl">💃</div>
                          )}
                          <span
                            className="block py-1 text-center text-xs font-bold"
                            style={{ background: active ? color : 'transparent', color: active ? '#0b0b16' : undefined }}
                          >
                            {active ? '✓ ' : ''}Dancer {i + 1}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {noDancerPicked ? (
                    <p className="mt-2 text-xs font-semibold text-warn">
                      Pick at least one dancer to continue.
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-ink/45">
                      Solo? Keep one picked. Dancing with friends? Pick a dancer for each of you,
                      then stand the way the video looks · everyone gets scored against their own dancer.
                    </p>
                  )}
                </div>
              )}
              {/* Starting is gated on the camera + pose model being warm — otherwise the
                  first seconds of the take have no tracking and score as "couldn't see you". */}
              <button
                onClick={startWholeDanceRun}
                disabled={camStatus !== 'ready' || noDancerPicked}
                className="mt-4 w-full rounded-2xl bg-brand2 px-5 py-3 text-left font-display text-base font-bold text-[#06222a] shadow-soft transition hover:brightness-105 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
              >
                ▶ Dance the whole thing
                <span className="block text-xs font-medium text-[#06222a]/70">
                  Straight through to the music, once · then a part-by-part recap
                </span>
              </button>
              <p className="mt-4 mb-2 text-xs font-medium uppercase tracking-wider text-ink/45">Or drill just one part</p>
              <div className="flex flex-wrap gap-2">
                {moves.filter((m) => !skip.includes(m.index)).map((m) => (
                  <button
                    key={m.index}
                    onClick={() => startRating(m.startSec, m.endSec)}
                    disabled={camStatus !== 'ready' || noDancerPicked}
                    className="rounded-xl border border-line bg-ink/[0.06] px-4 py-2 text-sm font-semibold text-ink/80 transition hover:border-brand2/60 hover:text-ink active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
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
        {/* RESULTS — everyone's rating and exactly where it went wrong, then Done. */}
        {inGo && segMode === 'results' && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div className="max-h-full w-full max-w-md overflow-y-auto rounded-2.5xl border border-line bg-panel/95 p-5 shadow-soft">
              {testError ? (
                <>
                  <p className="font-display text-lg font-bold">Hmm, no dancer detected 🤔</p>
                  <p className="mt-2 text-sm text-ink/60">{testError}</p>
                </>
              ) : testResults.length > 1 ? (
                <>
                  <p className="font-display text-lg font-bold">Group results</p>
                  <div className="mt-3 space-y-2">
                    {testResults.map((r, i) => {
                      const d = slotInfo.dancers[i] ?? i
                      const color = DANCER_COLORS[d % DANCER_COLORS.length]!
                      return (
                        <div key={i} className="rounded-xl border border-line bg-ink/[0.03] p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-sm font-semibold text-ink/80">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                              Dancer {d + 1}
                            </span>
                            {r ? (
                              <span className="font-display text-2xl font-bold" style={{ color: scoreVerdict(r.score).color }}>
                                {Math.round(r.score)}%
                              </span>
                            ) : (
                              <span className="text-xs text-ink/45">not seen on camera</span>
                            )}
                          </div>
                          {r && (
                            <p className="mt-1 text-xs text-ink/60">
                              {scoreVerdict(r.score).label}
                              {r.worstLimb ? ` · watch the ${LIMB_LABEL[r.worstLimb].toLowerCase()}` : ''}
                              {testTimings[i] ? ` · ${testTimings[i]}` : ''}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <p className="mt-3 text-xs text-ink/45">Colors match the skeletons you danced with.</p>
                </>
              ) : testResults[0] ? (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-wider text-ink/45">Your match</p>
                      <p className="font-display text-5xl font-bold" style={{ color: scoreVerdict(testResults[0].score).color }}>
                        {Math.round(testResults[0].score)}%
                      </p>
                    </div>
                    <p className="pb-1 text-sm font-semibold" style={{ color: scoreVerdict(testResults[0].score).color }}>
                      {scoreVerdict(testResults[0].score).label}
                    </p>
                  </div>
                  <div className="mt-4 space-y-1.5">
                    {(Object.entries(testResults[0].perLimb) as [Limb, { errorDeg: number; ok: boolean }][]).map(([limb, res]) => (
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
                    {feedbackLines(testResults[0]).map((line, i) => (
                      <li key={i} className="text-sm text-ink/70">· {line}</li>
                    ))}
                    {testTimings[0] && <li className="text-sm text-ink/70">· {testTimings[0]}</li>}
                  </ul>
                </>
              ) : null}
              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                {takeUrl && (
                  <button onClick={startReplay} className={btn + ' !border-brand2/50'} title="Watch your take next to the instructor">
                    🎬 Side by side
                  </button>
                )}
                <button onClick={restartTest} className={btn}>↻ Try again</button>
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
              {/* The single biggest thing to fix: the limb that was off in the most segments. */}
              {(() => {
                const tally = new Map<Limb, number>()
                for (const s of runSummary.segments) {
                  if (s.grade !== 'nailed' && s.worstLimb) tally.set(s.worstLimb, (tally.get(s.worstLimb) ?? 0) + 1)
                }
                const worst = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
                if (!worst) return null
                return (
                  <p className="mt-3 rounded-xl border border-warn/40 bg-warn/[0.08] px-3 py-2 text-sm text-ink/80">
                    Biggest fix: your <b className="text-ink">{LIMB_LABEL[worst[0]].toLowerCase()}</b> drifted the most. {LIMB_ADVICE[worst[0]]}.
                  </p>
                )
              })()}
              <div className="mt-4 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
                {runSummary.segments.map((s) => {
                  const tint = s.grade === 'nailed' ? '#a3e635' : s.grade === 'close' ? '#facc15' : '#ff5470'
                  // Say what was off, not just a grade: the worst limb is already computed.
                  const note = s.grade === 'nailed'
                    ? 'Nailed it'
                    : s.worstLimb
                      ? `${LIMB_LABEL[s.worstLimb]} off`
                      : s.grade === 'close' ? 'Close' : 'Needs work'
                  return (
                    <div key={s.index} className="flex items-center gap-2 rounded-xl border border-line bg-ink/[0.03] px-3 py-2">
                      <span className="w-16 shrink-0 text-xs font-semibold text-ink/70">Segment {s.index + 1}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
                        <div className="h-full rounded-full" style={{ width: `${Math.round(s.score)}%`, background: tint }} />
                      </div>
                      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink/60">{Math.round(s.score)}%</span>
                      <span className="w-[76px] shrink-0 text-right text-[11px] font-semibold" style={{ color: tint }}>{note}</span>
                    </div>
                  )
                })}
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                {takeUrl && (
                  <button onClick={startReplay} className={btn + ' !border-brand2/50'} title="Watch your run next to the instructor">
                    🎬 Watch side by side
                  </button>
                )}
                <button onClick={startWholeDanceRun} className={btn}>↻ Dance it again</button>
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
        {/* GROUP SUMMARY — the run recap when several dancers tested together. */}
        {inGo && segMode === 'summary' && multiRun && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div className="flex max-h-full w-full max-w-md flex-col rounded-2.5xl border border-line bg-panel/95 p-5 shadow-soft">
              <p className="text-xs uppercase tracking-wider text-ink/45">Your group run</p>
              <div className="mt-2 space-y-1.5">
                {multiRun.summaries.map((sum, k) => {
                  const d = multiRun.dancers[k] ?? k
                  const color = DANCER_COLORS[d % DANCER_COLORS.length]!
                  return (
                    <div key={k} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-ink/[0.03] px-3 py-2">
                      <span className="flex items-center gap-2 text-sm font-semibold text-ink/80">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                        Dancer {d + 1}
                      </span>
                      <span className="text-xs text-ink/55">
                        {sum.nailed} nailed · {sum.close} close · {sum.off} to work on
                      </span>
                      <span className="font-display text-xl font-bold" style={{ color: scoreVerdict(sum.overall).color }}>
                        {Math.round(sum.overall)}%
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="mt-4 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
                {(multiRun.summaries[0]?.segments ?? []).map((s0, row) => (
                  <div key={s0.index} className="flex items-center gap-2 rounded-xl border border-line bg-ink/[0.03] px-3 py-2">
                    <span className="w-20 shrink-0 text-xs font-semibold text-ink/70">Segment {s0.index + 1}</span>
                    <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
                      {multiRun.summaries.map((sum, k) => {
                        const seg = sum.segments[row]
                        const d = multiRun.dancers[k] ?? k
                        const color = DANCER_COLORS[d % DANCER_COLORS.length]!
                        return (
                          <span key={k} className="flex items-center gap-1 text-xs tabular-nums text-ink/70">
                            <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                            {seg ? `${Math.round(seg.score)}%` : '·'}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                {takeUrl && (
                  <button onClick={startReplay} className={btn + ' !border-brand2/50'} title="Watch your run next to the instructor">
                    🎬 Watch side by side
                  </button>
                )}
                <button onClick={startWholeDanceRun} className={btn}>↻ Dance it again</button>
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
        {/* Camera blocked/missing during a record-my-run — say so plainly and offer a retry. */}
        {inGo && segMode === 'recordrun' && camStatus === 'error' && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-2.5xl border border-line bg-panel/95 p-5 text-center shadow-soft">
              <p className="font-display text-lg font-bold">Camera needed 🎥</p>
              <p className="mt-1 text-sm text-ink/60">
                {camError ?? "We can't record your run without camera access. Allow the camera for this site, then try again."}
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <button onClick={startRecordRun} className={btn}>↻ Try again</button>
                <button
                  onClick={cancelRecordRun}
                  className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95"
                >
                  ✕ Never mind
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
            {/* Loop 1, 2 or 3 segments together to drill the join between moves. */}
            {moves.length > 1 && (
              <div className="flex items-center gap-1 rounded-xl border border-line bg-ink/[0.06] p-1" title="How many segments loop together">
                <span className="px-1.5 text-xs font-medium text-ink/45">Loop</span>
                {[1, 2, 3].map((n) => (
                  <button
                    key={n}
                    onClick={() => {
                      setComboCount(n); comboCountRef.current = n
                      gotoMove(moveIdxRef.current, playing)
                    }}
                    className={`rounded-lg px-2.5 py-1.5 text-sm font-medium tabular-nums transition ${comboCount === n ? 'bg-brand text-cream' : 'text-ink/55 hover:text-ink'}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
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
            <button onClick={completeSegment} className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95">
              ✓ Got it
            </button>
            <button onClick={() => gotoMove(nextOpen(moveIdx, 1))} className={btn + ' !px-3'}>skip ›</button>
          </div>

          {/* Finished every segment → put it together in one full pass before the camera
              ever comes on. Test my skills stays reachable for anyone who'd rather skip. */}
          {moves.length > 0 && completed.length >= moves.length - skip.length && (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-brand2/40 bg-brand2/[0.08] px-4 py-3 text-center">
              <p className="text-sm font-semibold text-ink">You got every segment 🎉</p>
              <p className="text-xs text-ink/55">
                Now put it together: dance the whole thing on a loop.{!playbackOnly && ' Record any run to watch yourself back.'}
              </p>
              <button
                onClick={startPracticeRun}
                className="rounded-xl bg-brand2 px-5 py-2.5 text-sm font-bold text-[#06222a] shadow-soft transition hover:brightness-105 active:scale-95"
              >
                ▶ Full run-through
              </button>
              {!playbackOnly && (
                <button onClick={enterRating} className="text-xs text-ink/45 underline-offset-2 transition hover:text-ink hover:underline">
                  or skip to 🎯 Test my skills
                </button>
              )}
            </div>
          )}

          {/* Coaching line */}
          <div className="flex min-h-[24px] items-center justify-center text-sm">
            {toast ? (
              <span className="rounded-full bg-good/20 px-3 py-1 font-semibold text-good">{toast}</span>
            ) : (
              <span className="text-ink/40">
                {comboIndices.length > 1
                  ? `Drill segments ${comboIndices.map((i) => i + 1).join(' + ')} together, then ✓ Got it.`
                  : 'Drill this segment, then ✓ Got it for the next one.'}
              </span>
            )}
          </div>
        </>
      ) : segMode === 'runthrough' ? (
        <>
          {/* Same shape as drilling a segment: it loops, you set the speed, and YOU decide
              when you've got it. */}
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
            <button onClick={startPracticeRun} className={btn} title="Start the routine again from the top">↻ Restart</button>
            <button onClick={() => finishPracticeRun(false)} className={btn}>✕ Stop</button>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {!playbackOnly && (
              <button
                onClick={startRecordRun}
                className="rounded-xl border border-brand2/50 bg-brand2/15 px-4 py-2.5 text-sm font-bold text-ink transition hover:bg-brand2/25 active:scale-95"
                title="Record this run with the camera on, then watch yourself side by side"
              >
                🎥 Record this run
              </button>
            )}
            <button
              onClick={() => finishPracticeRun(true)}
              className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95"
            >
              ✓ Got it{!playbackOnly && ' · test me →'}
            </button>
          </div>
          <div className="flex min-h-[24px] items-center justify-center text-sm">
            {toast ? (
              <span className="rounded-full bg-good/20 px-3 py-1 font-semibold text-good">{toast}</span>
            ) : (
              <span className="text-ink/40">
                It keeps looping · dance it as many times as you like.{!playbackOnly && ' 🎥 Record this run to watch yourself back.'}
              </span>
            )}
          </div>
        </>
      ) : segMode === 'recordrun' ? (
        <>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button onClick={() => setMirror((m) => !m)} className={mirror ? btn + ' !border-brand/60 !bg-brand/20 !text-ink' : btn}>🪞 Mirror</button>
            <button onClick={cancelRecordRun} className={btn}>✕ Cancel</button>
          </div>
          <div className="flex min-h-[24px] items-center justify-center text-sm">
            <span className={camStatus === 'error' ? 'text-bad' : 'text-ink/40'}>
              {camStatus === 'error'
                ? (camError ?? "Camera not available, so this feature can't run.")
                : camStatus !== 'ready'
                  ? 'Warming up your camera…'
                  : '🔴 Recording your run · dance the whole thing once, then watch it back.'}
            </span>
          </div>
        </>
      ) : segMode === 'replay' ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button onClick={replayBoth} className="rounded-xl bg-brand px-6 py-2.5 text-sm font-semibold text-cream shadow-glow transition hover:brightness-105 active:scale-95">
            ▶ Replay
          </button>
          {replayReturn === 'practice' ? (
            <>
              <button onClick={startRecordRun} className={btn}>↻ Record another</button>
              <button
                onClick={doneRecordReplay}
                className="rounded-xl bg-good px-5 py-2.5 text-sm font-bold text-[#13260a] shadow-soft transition hover:brightness-105 active:scale-95"
              >
                ✓ Back to practice
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
            {segMode === 'menu' ? 'Pick what to test.' : segMode === 'test' ? '🎥 Dance it · you’re being scored and recorded.' : segMode === 'summary' ? 'Your run recap is above.' : 'Check your feedback above.'}
          </span>
        </div>
      )}

      {(rating || recordRun) && cameras.length > 0 && (
        <div className="flex justify-center">
          <select value={activeCam ?? ''} onChange={(e) => void switchCamera(e.target.value)} className="max-w-[240px] truncate rounded-xl border border-line bg-panel px-2 py-1.5 text-xs text-ink/80 outline-none">
            {cameras.map((c, i) => <option key={c.deviceId || i} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}
