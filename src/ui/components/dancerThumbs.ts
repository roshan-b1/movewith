// Snapshot each dancer's face/body out of the tutorial video so the "which dancer?" picker
// shows WHO you're picking instead of an anonymous "Dancer 2". Decoding happens in a
// throwaway <video> so the one on screen never moves — the picker must not disturb the
// playhead the dancer left it at.

import { dancerPortraitAt, pickShowcaseTime } from '../../core/reference/preview'
import type { ReferenceFrame } from '../../core/reference/types'

const THUMB_W = 132
const THUMB_H = 168

/** Crop one dancer out of an already-seeked video frame. Null when they aren't on screen. */
function cropDancer(video: HTMLVideoElement, frames: ReferenceFrame[], t: number): string | null {
  const box = dancerPortraitAt(frames, t)
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!box || !vw || !vh) return null

  const sx = box.x * vw
  const sy = box.y * vh
  const sw = box.w * vw
  const sh = box.h * vh

  const canvas = document.createElement('canvas')
  canvas.width = THUMB_W
  canvas.height = THUMB_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  try {
    // FIT the person inside the chip (letterbox), never widen the source rect to fill it.
    // Widening is what made two dancers standing side by side crop to the same picture:
    // each crop grew sideways until it swallowed the neighbour.
    const scale = Math.min(THUMB_W / sw, THUMB_H / sh)
    const dw = sw * scale
    const dh = sh * scale
    ctx.fillStyle = '#12121c'
    ctx.fillRect(0, 0, THUMB_W, THUMB_H)
    ctx.drawImage(video, sx, sy, sw, sh, (THUMB_W - dw) / 2, (THUMB_H - dh) / 2, dw, dh)
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
