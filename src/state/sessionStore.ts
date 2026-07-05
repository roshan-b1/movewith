// Session/UI state and the async data operations (library, import, progress). The
// 30fps live loop deliberately does NOT live here — it runs imperatively in the
// practice screen to avoid re-rendering React on every frame.

import { create } from 'zustand'
import type { ReferenceTrack, DanceProgress } from '../core/reference/types'
import { generateDemoDance, DEMO_TRACK_ID, OLD_DEMO_TRACK_IDS } from '../core/demo/demoDance'

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

export interface SessionState {
  screen: Screen
  tracks: ReferenceTrack[]
  activeTrack: ReferenceTrack | null
  activeVideoUrl: string | null
  progress: DanceProgress | null
  status: 'idle' | 'loading' | 'extracting' | 'error'
  extract: ExtractProgress | null
  error: string | null

  init: () => Promise<void>
  openTrack: (id: string) => Promise<void>
  importVideo: (file: File, name: string, playbackOnly?: boolean) => Promise<void>
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
  status: 'idle',
  extract: null,
  error: null,

  async init() {
    set({ status: 'loading', error: null })
    try {
      // Ensure the bundled demo exists so the app is usable on first open. Older
      // generator versions and removed bundled routines are cleaned up.
      for (const old of [...OLD_DEMO_TRACK_IDS, ...REMOVED_TRACK_IDS]) {
        if (await getTrack(old)) await deleteTrack(old)
      }
      if (!(await getTrack(DEMO_TRACK_ID))) {
        await saveTrack(generateDemoDance(Date.now()))
      }
      set({ tracks: await listTracks(), status: 'idle' })
    } catch (e) {
      set({ status: 'error', error: errMsg(e) })
    }
  },

  async openTrack(id) {
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
      set({ activeTrack: track, activeVideoUrl: url, progress, screen: 'practice', status: 'idle' })
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
