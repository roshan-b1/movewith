// Cutting a routine up is fiddly: you drag a divider a bit too far, delete the wrong part,
// re-cut, delete again. Without a way back, every mistake costs you the whole pass. This is
// the undo/redo stack for the segment editor — a plain past/future pair over snapshots of
// the editable state. Pure, so the screen just calls it and re-renders.

/** Everything the segment editor can change. One snapshot = one undo step. */
export interface EditSnapshot {
  trimStart: number
  trimEnd: number
  /** Internal cut times between segments. */
  moveBounds: number[]
  /** Stretches deleted out of the routine. */
  cuts: Array<[number, number]>
}

export interface EditHistory {
  past: EditSnapshot[]
  future: EditSnapshot[]
}

/** How many steps back the editor remembers. Deep enough for a full pass, bounded so a
 *  long editing session can't grow without limit. */
export const HISTORY_LIMIT = 60

export const emptyHistory: EditHistory = { past: [], future: [] }

function sameNums(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < 1e-6)
}

/** Two snapshots are the same edit state (so we don't record a no-op as an undo step). */
export function sameSnapshot(a: EditSnapshot, b: EditSnapshot): boolean {
  return (
    Math.abs(a.trimStart - b.trimStart) < 1e-6 &&
    Math.abs(a.trimEnd - b.trimEnd) < 1e-6 &&
    sameNums(a.moveBounds, b.moveBounds) &&
    a.cuts.length === b.cuts.length &&
    a.cuts.every((c, i) => Math.abs(c[0] - b.cuts[i]![0]) < 1e-6 && Math.abs(c[1] - b.cuts[i]![1]) < 1e-6)
  )
}

/**
 * Record the state as it was BEFORE an edit. Called at the start of each edit, so `past`
 * always holds states you can return to. A fresh edit invalidates anything you had redone
 * past, which is the standard contract and keeps the timeline linear.
 */
export function pushEdit(h: EditHistory, before: EditSnapshot): EditHistory {
  const last = h.past[h.past.length - 1]
  if (last && sameSnapshot(last, before) && h.future.length === 0) return h
  const past = [...h.past, before]
  return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [] }
}

/** Step back one edit. `current` is pushed onto the redo stack. Null when there's nothing to undo. */
export function undoEdit(h: EditHistory, current: EditSnapshot): { history: EditHistory; state: EditSnapshot } | null {
  const prev = h.past[h.past.length - 1]
  if (!prev) return null
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future] }, state: prev }
}

/** Step forward one edit. Null when there's nothing to redo. */
export function redoEdit(h: EditHistory, current: EditSnapshot): { history: EditHistory; state: EditSnapshot } | null {
  const next = h.future[0]
  if (!next) return null
  return { history: { past: [...h.past, current], future: h.future.slice(1) }, state: next }
}
