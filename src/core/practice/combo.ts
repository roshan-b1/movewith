// Learning a routine isn't only about nailing each move — it's about the JOIN between
// them, which drilling one segment at a time never rehearses. Combo practice loops two or
// three consecutive segments together so the transition gets the reps too. Pure.

export interface ComboSegment {
  index: number
  startSec: number
  endSec: number
}

export interface ComboSpan {
  /** Segment indices in the combo, in order (always starts with the requested one). */
  indices: number[]
  startSec: number
  endSec: number
}

/**
 * The time range covering `count` consecutive segments starting at `startIndex`. Deleted
 * stretches never reach here — they are already gone from the segment list — so a combo
 * that straddles a hole covers the moves either side of it and playback jumps the gap.
 * The starting segment is always included; the span just stops early if the routine runs
 * out. `count <= 1` gives the single segment, which is the normal drilling case.
 */
export function comboSpan(
  segments: readonly ComboSegment[],
  startIndex: number,
  count: number,
): ComboSpan | null {
  const startAt = segments.findIndex((s) => s.index === startIndex)
  if (startAt < 0) return null
  const first = segments[startAt]!
  const picked: ComboSegment[] = [first]
  const want = Math.max(1, count)

  for (let i = startAt + 1; i < segments.length && picked.length < want; i++) {
    picked.push(segments[i]!)
  }
  return {
    indices: picked.map((s) => s.index),
    startSec: picked[0]!.startSec,
    endSec: picked[picked.length - 1]!.endSec,
  }
}
