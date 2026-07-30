// A "mix" is a routine stitched from parts of several dances — a medley. Each clip points
// at a slice [startSec, endSec) of a source track's video. On the mix's own timeline the
// clips play back to back, so clip 0 occupies [0, len0), clip 1 [len0, len0+len1), and so
// on. Everything here is pure timeline math on that model: durations, the running offsets,
// mapping a global mix-time to the clip playing at that instant, and list edits (insert,
// move, remove). The DOM playback engine (engine/mixPlayback.ts) sits on top of this.

export interface MixClip {
  /** Stable id within the mix (so React keys and drag targets are stable across reorders). */
  id: string
  /** The dance this slice comes from. */
  sourceTrackId: string
  /** Cached source name, so the editor/labels don't need the track loaded. */
  sourceName: string
  /** Slice of the source video, in seconds. Always startSec < endSec. */
  startSec: number
  endSec: number
}

export const MIX_VERSION = 1 as const

export interface Mix {
  version: typeof MIX_VERSION
  id: string
  name: string
  /** Epoch millis. Passed in (not generated) so this stays deterministic/testable. */
  createdAt: number
  /** Clips in play order. */
  clips: MixClip[]
}

/** Length of one clip on the timeline (seconds). Never negative. */
export function clipDuration(clip: MixClip): number {
  return Math.max(0, clip.endSec - clip.startSec)
}

/** Total length of the whole mix (seconds). */
export function mixDuration(clips: readonly MixClip[]): number {
  return clips.reduce((sum, c) => sum + clipDuration(c), 0)
}

/**
 * Running start time of each clip on the mix timeline. `offsets[i]` is where clip `i`
 * begins; there's a trailing entry equal to the total duration, so `offsets[i+1]` is where
 * clip `i` ends. Length is `clips.length + 1`.
 */
export function clipOffsets(clips: readonly MixClip[]): number[] {
  const out: number[] = [0]
  for (const c of clips) out.push(out[out.length - 1]! + clipDuration(c))
  return out
}

export interface MixLocation {
  /** Index of the clip playing at the queried time. */
  index: number
  clip: MixClip
  /** Seconds into that clip on the mix timeline (0 at the clip's start). */
  offsetSec: number
  /** The matching time in the SOURCE video (clip.startSec + offsetSec). */
  sourceSec: number
}

/**
 * Which clip is playing at global mix-time `t`, and where inside it. Half-open per clip
 * ([start, end)), so a time exactly on a boundary belongs to the later clip — except the
 * very end of the mix, which clamps to the last clip so the final frame still resolves.
 * Returns null for an empty mix, negative time, or time past the end.
 */
export function mapMixTime(clips: readonly MixClip[], t: number): MixLocation | null {
  if (clips.length === 0 || t < 0) return null
  const offsets = clipOffsets(clips)
  const total = offsets[offsets.length - 1]!
  if (t > total) return null
  // Clamp the exact end onto the last non-empty clip.
  if (t >= total) {
    for (let i = clips.length - 1; i >= 0; i--) {
      if (clipDuration(clips[i]!) > 0) {
        const clip = clips[i]!
        return { index: i, clip, offsetSec: clipDuration(clip), sourceSec: clip.endSec }
      }
    }
    return null
  }
  for (let i = 0; i < clips.length; i++) {
    if (t >= offsets[i]! && t < offsets[i + 1]!) {
      const clip = clips[i]!
      const offsetSec = t - offsets[i]!
      return { index: i, clip, offsetSec, sourceSec: clip.startSec + offsetSec }
    }
  }
  return null
}

/** The [start, end) span of clip `index` on the mix timeline. */
export function clipSpan(clips: readonly MixClip[], index: number): { startSec: number; endSec: number } | null {
  if (index < 0 || index >= clips.length) return null
  const offsets = clipOffsets(clips)
  return { startSec: offsets[index]!, endSec: offsets[index + 1]! }
}

/** Insert `clip` at `atIndex` (clamped). Returns a new array; never mutates the input. */
export function insertClip(clips: readonly MixClip[], clip: MixClip, atIndex: number): MixClip[] {
  const i = Math.max(0, Math.min(atIndex, clips.length))
  const out = clips.slice()
  out.splice(i, 0, clip)
  return out
}

/** Remove the clip with `id`. Returns a new array. */
export function removeClip(clips: readonly MixClip[], id: string): MixClip[] {
  return clips.filter((c) => c.id !== id)
}

/**
 * Move the clip at `from` so it lands at position `to` in the final array (like dragging a
 * timeline block to a new slot). `to` is interpreted against the list AFTER removal, then
 * clamped, so moving right or left both do the intuitive thing. Returns a new array.
 */
export function moveClip(clips: readonly MixClip[], from: number, to: number): MixClip[] {
  if (from < 0 || from >= clips.length) return clips.slice()
  const out = clips.slice()
  const [moved] = out.splice(from, 1)
  if (!moved) return out
  const dest = Math.max(0, Math.min(to, out.length))
  out.splice(dest, 0, moved)
  return out
}
