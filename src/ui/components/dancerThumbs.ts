// Snapshot each dancer's face/body out of the tutorial video so the "which dancer?" picker
// shows WHO you're picking instead of an anonymous "Dancer 2". Decoding happens in a
// throwaway <video> so the one on screen never moves — the picker must not disturb the
// playhead the dancer left it at.

import { dancerBoundsAt, pickShowcaseTime } from '../../core/reference/preview'
import type { ReferenceFrame } from '../../core/reference/types'

const THUMB_W = 132
const THUMB_H = 168

/** Crop one dancer out of an already-seeked video frame. Null when they aren't on screen. */
function cropDancer(video: HTMLVideoElement, frames: ReferenceFrame[], t: number): string | null {
  const box = dancerBoundsAt(frames, t)
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!box || !vw || !vh) return null

  // Match the thumbnail's aspect so bodies aren't squashed: widen the crop if needed.
  const want = THUMB_W / THUMB_H
  let sw = box.w * vw
  let sh = box.h * vh
  let sx = box.x * vw
  let sy = box.y * vh
  if (sw / sh < want) {
    const grow = sh * want - sw
    sx = Math.max(0, sx - grow / 2)
    sw = Math.min(vw - sx, sw + grow)
  } else {
    const grow = sw / want - sh
    sy = Math.max(0, sy - grow / 2)
    sh = Math.min(vh - sy, sh + grow)
  }

  const canvas = document.createElement('canvas')
  canvas.width = THUMB_W
  canvas.height = THUMB_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  try {
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, THUMB_W, THUMB_H)
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return null // tainted or not decodable — the picker falls back to color dots
  }
}

/**
 * Data-URL snapshots of every dancer, taken at a moment where the most of them are on
 * screen together. Entries are null for dancers who can't be snapshotted. Never throws —
 * the picker degrades to plain color chips.
 */
export async function captureDancerThumbs(
  videoUrl: string,
  dancers: ReferenceFrame[][],
  startSec: number,
  endSec: number,
): Promise<(string | null)[]> {
  const empty = dancers.map(() => null)
  if (!videoUrl || dancers.length === 0) return empty

  const video = document.createElement('video')
  video.src = videoUrl
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'

  const settle = (event: 'loadeddata' | 'seeked') =>
    new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean) => { if (!done) { done = true; cleanup(); resolve(ok) } }
      const onOk = () => finish(true)
      const onErr = () => finish(false)
      const timer = window.setTimeout(() => finish(false), 6000)
      function cleanup() {
        window.clearTimeout(timer)
        video.removeEventListener(event, onOk)
        video.removeEventListener('error', onErr)
      }
      video.addEventListener(event, onOk)
      video.addEventListener('error', onErr)
    })

  try {
    if (!(await settle('loadeddata'))) return empty
    const t = pickShowcaseTime(dancers, startSec, endSec)
    video.currentTime = t
    if (!(await settle('seeked'))) return empty
    return dancers.map((frames) => cropDancer(video, frames, t))
  } catch {
    return empty
  } finally {
    // Release the decoder rather than leaving a second stream alive behind the picker.
    video.removeAttribute('src')
    video.load()
  }
}
