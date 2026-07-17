// Session/UI state and the async data operations (library, import, progress). The
// 30fps live loop deliberately does NOT live here — it runs imperatively in the
// practice screen to avoid re-rendering React on every frame.

import { create } from 'zustand'
import type { ReferenceTrack, DanceProgress } from '../core/reference/types'
import { generateDemoDance, DEMO_TRACK_ID, OLD_DEMO_TRACK_IDS } from '../core/demo/demoDance'

// The generated demo routine rides on the 3D dancer, which isn't presentable yet, so the
// library shows only real uploads for now. The generator stays intact (see generateDemoDance
// below) — flip this to true to seed it again.
const ENABLE_DEMO_TRACK = false

// Bundled routines that no longer exist — cleaned out of returning users' libraries.
const REMOVED_TRACK_IDS = ['macarena-v1']
import { extractReferenceFromVideo, type ExtractProgress } from '../engine/extractReference'
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
} from '../storage/db'

export type Screen = 'library' | 'practice'
/** Why the practice screen was opened: to learn/drill, or to be scored by the rater. */
export type OpenIntent = 'practice' | 'rate'

export interface SessionState {
  screen: Screen
  tracks: ReferenceTrack[]
  activeTrack: ReferenceTrack | null
  activeVideoUrl: string | null
  progress: DanceProgress | null
  /** What the practice screen should open into (drilling vs "Test my skills"). */
  openIntent: OpenIntent
  status: 'idle' | 'loading' | 'extracting' | 'error'
  extract: ExtractProgress | null
  error: string | null

  init: () => Promise<void>
  openTrack: (id: string, intent?: OpenIntent) => Promise<void>
  importVideo: (file: File, name: string, playbackOnly?: boolean) => Promise<void>
  renameTrack: (id: string, name: string) => Promise<void>
  removeTrack: (id: string) => Promise<void>
  updateProgress: (next: DanceProgress) => Promise<void>
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
  openIntent: 'practice',
  status: 'idle',
  extract: null,
  error: null,

  async init() {
    set({ status: 'loading', error: null })
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
      set({ tracks: await listTracks(), status: 'idle' })
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

  async importVideo(file, name, playbackOnly = false) {
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
      set({ tracks: await listTracks(), status: 'idle', extract: null })
      await get().openTrack(track.id)
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

  async removeTrack(id) {
    await deleteTrack(id)
    set({ tracks: await listTracks() })
  },

  async updateProgress(next) {
    await saveProgress(next)
    set({ progress: next })
  },

  back() {
    const prev = get().activeVideoUrl
    if (prev) URL.revokeObjectURL(prev)
    set({ screen: 'library', activeTrack: null, activeVideoUrl: null, progress: null })
  },

  clearError() {
    set({ error: null, status: 'idle' })
  },
}))

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
