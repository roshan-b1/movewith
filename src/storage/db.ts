// Local persistence. Everything stays on-device: reference tracks, the original video
// blobs, and per-dance progress. Three object stores, schema-versioned so future shape
// changes can migrate instead of wiping saved dances.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ReferenceTrack, DanceProgress } from '../core/reference/types'
import type { Mix } from '../core/mix/timeline'

interface MoveWithDB extends DBSchema {
  tracks: { key: string; value: ReferenceTrack }
  videos: { key: string; value: Blob }
  progress: { key: string; value: DanceProgress }
  // v2: mixes (medleys). A mix references source tracks' videos by id — it stores no video
  // blob of its own, so deleting a mix never touches the source dances.
  mixes: { key: string; value: Mix }
}

const DB_NAME = 'movewith'
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase<MoveWithDB>> | null = null

function db(): Promise<IDBPDatabase<MoveWithDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MoveWithDB>(DB_NAME, DB_VERSION, {
      // idb runs upgrade with the OLD version's stores present; create only what's missing
      // so a v1 user keeps their tracks/videos/progress and just gains the mixes store.
      upgrade(database) {
        if (!database.objectStoreNames.contains('tracks')) database.createObjectStore('tracks')
        if (!database.objectStoreNames.contains('videos')) database.createObjectStore('videos')
        if (!database.objectStoreNames.contains('progress')) database.createObjectStore('progress')
        if (!database.objectStoreNames.contains('mixes')) database.createObjectStore('mixes')
      },
    })
  }
  return dbPromise
}

// --- Tracks ---------------------------------------------------------------

export async function saveTrack(track: ReferenceTrack): Promise<void> {
  await (await db()).put('tracks', track, track.id)
}

export async function getTrack(id: string): Promise<ReferenceTrack | undefined> {
  return (await db()).get('tracks', id)
}

export async function listTracks(): Promise<ReferenceTrack[]> {
  const all = await (await db()).getAll('tracks')
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteTrack(id: string): Promise<void> {
  const track = await getTrack(id)
  const database = await db()
  await database.delete('tracks', id)
  await database.delete('progress', id)
  if (track?.videoBlobKey) await database.delete('videos', track.videoBlobKey)
}

// --- Video blobs ----------------------------------------------------------

export async function saveVideo(key: string, blob: Blob): Promise<void> {
  await (await db()).put('videos', blob, key)
}

export async function getVideo(key: string): Promise<Blob | undefined> {
  return (await db()).get('videos', key)
}

// --- Progress -------------------------------------------------------------

export async function getProgress(trackId: string): Promise<DanceProgress | undefined> {
  return (await db()).get('progress', trackId)
}

export async function saveProgress(progress: DanceProgress): Promise<void> {
  await (await db()).put('progress', progress, progress.trackId)
}

// --- Mixes (medleys) ------------------------------------------------------

export async function saveMix(mix: Mix): Promise<void> {
  await (await db()).put('mixes', mix, mix.id)
}

export async function getMix(id: string): Promise<Mix | undefined> {
  return (await db()).get('mixes', id)
}

export async function listMixes(): Promise<Mix[]> {
  const all = await (await db()).getAll('mixes')
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteMix(id: string): Promise<void> {
  await (await db()).delete('mixes', id)
}
