// Session/UI state and the async data operations (library, import, progress). The
// 30fps live loop deliberately does NOT live here — it runs imperatively in the
// practice screen to avoid re-rendering React on every frame.

import { create } from 'zustand'
import type { ReferenceTrack, DanceProgress, RunReport } from '../core/reference/types'
import type { Mix } from '../core/mix/timeline'
import { generateDemoDance, DEMO_TRACK_ID, OLD_DEMO_TRACK_IDS } from '../core/demo/demoDance'

// The generated demo routine rides on the 3D dancer, which isn't presentable yet, so the
// library shows only real uploads for now. The generator stays intact (see generateDemoDance
// below) — flip this to true to seed it again.
const ENABLE_DEMO_TRACK = false

// Bundled routines that no longer exist — cleaned out of returning users' libraries.
const REMOVED_TRACK_IDS = ['macarena-v1']
import { extractReferenceFromVideo, type ExtractProgress } from '../engine/extractReference'
import { trackEvent, trackVisitOnce } from '../engine/analytics'
import { getPoseProvider } from '../providers/instance'
import {
  listTracks,
  getTrack,
  saveTrack,
  saveVideo,
  getVideo,
  getProgress,
  saveProgress,
  deleteTrack,
  saveMix as dbSaveMix,
  getMix,
  listMixes,
  deleteMix as dbDeleteMix,
} from '../storage/db'

export type Screen = 'library' | 'practice' | 'mixEditor' | 'mixPractice'
/** Why the practice screen was opened: to learn/drill, or to be scored by the rater. */
export type OpenIntent = 'practice' | 'rate'

export interface SessionState {
  screen: Screen
  tracks: ReferenceTrack[]
  activeTrack: ReferenceTrack | null
  activeVideoUrl: string | null
  progress: DanceProgress | null
  /** Saved Test-my-skills reports per track (newest first), for the library cards. */
  reportsByTrack: Record<string, RunReport[]>
  /** Saved mixes (medleys), newest first, for the library. */
  mixes: Mix[]
  /** The mix being edited or practiced (null in the editor means a fresh draft). */
  activeMix: Mix | null
  /** Object URLs for source dances' videos, keyed by track id — used by the mix editor and
   *  mix playback. Populated on demand and revoked when leaving a mix screen. */
  sourceUrls: Record<string, string>
  /** What the practice screen should open into (drilling vs "Test my skills"). */
  openIntent: OpenIntent
  status: 'idle' | 'loading' | 'extracting' | 'error'
  extract: ExtractProgress | null
  error: string | null

  init: () => Promise<void>
  openTrack: (id: string, intent?: OpenIntent) => Promise<void>
  importVideo: (file: File, name: string, playbackOnly?: boolean, intent?: OpenIntent) => Promise<void>
  renameTrack: (id: string, name: string) => Promise<void>
  /** Multi-dancer track: switch which dancer is learned/graded against. */
  selectDancer: (index: number) => Promise<void>
  removeTrack: (id: string) => Promise<void>
  updateProgress: (next: DanceProgress) => Promise<void>
  /** Append a Test-my-skills result to a track's saved reports (kept to the last 20). */
  saveReport: (trackId: string, report: RunReport) => Promise<void>
  /** Open the mix editor: pass a saved mix to edit it, or nothing for a fresh medley. */
  openMixEditor: (existing?: Mix) => Promise<void>
  /** Open a saved mix to practice it. */
  openMix: (id: string) => Promise<void>
  /** Load + cache a source dance's video object URL (for the editor and mix playback). */
  ensureSourceUrl: (trackId: string) => Promise<string | null>
  /** Persist a mix (create or update) and refresh the library list. */
  saveMix: (mix: Mix) => Promise<void>
  /** Delete a saved mix. Never touches the source dances. */
  removeMix: (id: string) => Promise<void>
  back: () => void
  clearError: () => void
}

function freshProgress(trackId: string): DanceProgress {
  return { trackId, bestSectionScores: {}, unlockedThrough: 0 }
}

export const useSession = create<SessionState>((set, get) => ({
  screen: 'library',
  tracks: [],
  activeTrack: null,
  activeVideoUrl: null,
  progress: null,
  reportsByTrack: {},
  mixes: [],
  activeMix: null,
  sourceUrls: {},
  openIntent: 'practice',
  status: 'idle',
  extract: null,
  error: null,

  async init() {
    set({ status: 'loading', error: null })
    trackVisitOnce()
    try {
      // Clean out old generator versions and removed bundled routines. While the demo is
      // disabled its track goes too, so returning users don't keep a stale copy.
      const stale = [...OLD_DEMO_TRACK_IDS, ...REMOVED_TRACK_IDS]
      if (!ENABLE_DEMO_TRACK) stale.push(DEMO_TRACK_ID)
      for (const old of stale) {
        if (await getTrack(old)) await deleteTrack(old)
      }
      if (ENABLE_DEMO_TRACK && !(await getTrack(DEMO_TRACK_ID))) {
        await saveTrack(generateDemoDance(Date.now()))
      }
      const list = await listTracks()
      // Pull each dance's saved reports so the library cards can show them at a glance.
      const reportsByTrack: Record<string, RunReport[]> = {}
      for (const t of list) {
        const p = await getProgress(t.id)
        if (p?.reports?.length) reportsByTrack[t.id] = p.reports
      }
      set({ tracks: list, reportsByTrack, mixes: await listMixes(), status: 'idle' })
    } catch (e) {
      set({ status: 'error', error: errMsg(e) })
    }
  },

  async openTrack(id, intent = 'practice') {
    set({ status: 'loading', error: null })
    try {
      const track = await getTrack(id)
      if (!track) throw new Error('Dance not found')
      let url: string | null = null
      if (track.videoBlobKey) {
        const blob = await getVideo(track.videoBlobKey)
        if (blob) url = URL.createObjectURL(blob)
      }
      const progress = (await getProgress(id)) ?? freshProgress(id)
      // Revoke any previous object URL.
      const prev = get().activeVideoUrl
      if (prev) URL.revokeObjectURL(prev)
      set({ activeTrack: track, activeVideoUrl: url, progress, openIntent: intent, screen: 'practice', status: 'idle' })
    } catch (e) {
      set({ status: 'error', error: errMsg(e) })
    }
  },

  async importVideo(file, name, playbackOnly = false, intent = 'practice') {
    set({ status: 'extracting', error: null, extract: { phase: 'loading', ratio: 0, message: 'Starting…' } })
    try {
      const { track, videoBlob } = await extractReferenceFromVideo({
        file,
        name,
        provider: await getPoseProvider(),
        createdAt: Date.now(),
        skipPose: playbackOnly,
        onProgress: (p) => set({ extract: p }),
      })
      if (track.videoBlobKey) await saveVideo(track.videoBlobKey, videoBlob)
      await saveTrack(track)
      await saveProgress(freshProgress(track.id))
      // Count the upload (anonymous id + duration only — the video stays on-device).
      trackEvent('upload', { durationSec: Math.round(track.source.durationSec), dancers: track.dancers?.length ?? 1 })
      set({ tracks: await listTracks(), status: 'idle', extract: null })
      // Carry the caller's intent through: an upload started from "Test my skills"
      // opens straight into the rater, not the practice setup.
      await get().openTrack(track.id, intent)
    } catch (e) {
      set({ status: 'error', error: errMsg(e), extract: null })
    }
  },

  async renameTrack(id, name) {
    const clean = name.trim()
    if (!clean) return
    const track = await getTrack(id)
    if (!track) return
    const updated = { ...track, name: clean }
    await saveTrack(updated)
    const active = get().activeTrack
    set({
      tracks: await listTracks(),
      activeTrack: active && active.id === id ? updated : active,
    })
  },

  async selectDancer(index) {
    const track = get().activeTrack
    const frames = track?.dancers?.[index]
    if (!track || !frames) return
    const updated = { ...track, frames, activeDancer: index }
    await saveTrack(updated)
    set({ activeTrack: updated, tracks: await listTracks() })
  },

  async removeTrack(id) {
    await deleteTrack(id)
    // A deleted dance may be sliced into saved mixes. Strip those clips so no mix is left
    // pointing at a source that no longer exists (which would play a black stage); a mix
    // left with no clips is removed entirely.
    for (const mix of await listMixes()) {
      if (!mix.clips.some((c) => c.sourceTrackId === id)) continue
      const clips = mix.clips.filter((c) => c.sourceTrackId !== id)
      if (clips.length === 0) await dbDeleteMix(mix.id)
      else await dbSaveMix({ ...mix, clips })
    }
    const tracks = await listTracks()
    const mixes = await listMixes()
    set((s) => {
      const { [id]: _gone, ...reportsByTrack } = s.reportsByTrack
      return { tracks, reportsByTrack, mixes }
    })
  },

  async updateProgress(next) {
    await saveProgress(next)
    set({ progress: next })
  },

  async saveReport(trackId, report) {
    const cur = (await getProgress(trackId)) ?? freshProgress(trackId)
    const reports = [report, ...(cur.reports ?? [])].slice(0, 20)
    const next = { ...cur, reports }
    await saveProgress(next)
    set((s) => ({
      reportsByTrack: { ...s.reportsByTrack, [trackId]: reports },
      // Keep the active track's in-memory progress in step so a later setup save doesn't
      // clobber the reports we just wrote.
      progress: s.progress?.trackId === trackId ? next : s.progress,
    }))
  },

  async ensureSourceUrl(trackId) {
    const cached = get().sourceUrls[trackId]
    if (cached) return cached
    const track = await getTrack(trackId)
    if (!track?.videoBlobKey) return null
    const blob = await getVideo(track.videoBlobKey)
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    set((s) => ({ sourceUrls: { ...s.sourceUrls, [trackId]: url } }))
    return url
  },

  async openMixEditor(existing) {
    // Warm the source URLs for an existing mix so its preview plays right away.
    if (existing) {
      for (const id of [...new Set(existing.clips.map((c) => c.sourceTrackId))]) {
        await get().ensureSourceUrl(id)
      }
    }
    set({ activeMix: existing ?? null, screen: 'mixEditor' })
  },

  async openMix(id) {
    set({ status: 'loading', error: null })
    try {
      const mix = await getMix(id)
      if (!mix) throw new Error('Mix not found')
      for (const src of [...new Set(mix.clips.map((c) => c.sourceTrackId))]) {
        await get().ensureSourceUrl(src)
      }
      set({ activeMix: mix, screen: 'mixPractice', status: 'idle' })
    } catch (e) {
      set({ status: 'error', error: errMsg(e) })
    }
  },

  async saveMix(mix) {
    await dbSaveMix(mix)
    set({ mixes: await listMixes(), activeMix: mix })
  },

  async removeMix(id) {
    await dbDeleteMix(id)
    set((s) => ({ mixes: s.mixes.filter((m) => m.id !== id), activeMix: s.activeMix?.id === id ? null : s.activeMix }))
  },

  back() {
    const s = get()
    if (s.activeVideoUrl) URL.revokeObjectURL(s.activeVideoUrl)
    // Free every source-video URL opened for the mix editor/practice.
    for (const url of Object.values(s.sourceUrls)) URL.revokeObjectURL(url)
    set({ screen: 'library', activeTrack: null, activeVideoUrl: null, progress: null, activeMix: null, sourceUrls: {} })
  },

  clearError() {
    set({ error: null, status: 'idle' })
  },
}))

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
