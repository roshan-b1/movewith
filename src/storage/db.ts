// Local persistence. Everything stays on-device: reference tracks, the original video
// blobs, and per-dance progress. Three object stores, schema-versioned so future shape
// changes can migrate instead of wiping saved dances.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ReferenceTrack, DanceProgress } from '../core/reference/types'

interface MoveWithDB extends DBSchema {
  tracks: { key: string; value: ReferenceTrack }
  videos: { key: string; value: Blob }
  progress: { key: string; value: DanceProgress }
}

const DB_NAME = 'movewith'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<MoveWithDB>> | null = null

function db(): Promise<IDBPDatabase<MoveWithDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MoveWithDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('tracks')) database.createObjectStore('tracks')
        if (!database.objectStoreNames.contains('videos')) database.createObjectStore('videos')
        if (!database.objectStoreNames.contains('progress')) database.createObjectStore('progress')
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
