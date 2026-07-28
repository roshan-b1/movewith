// What a loop wrap MEANS depends on what the stage is doing. The playhead jumping back to
// the start of the region is the one signal that "that pass finished", and four different
// flows read it differently: a scored take is done, a side-by-side replay should hold, the
// final practice pass is over, and plain drilling should just loop again (until the rep
// limit). Pure so the branching is testable — the live tick can't be, it needs playback.

export type WrapMode = 'watch' | 'runthrough' | 'recordrun' | 'menu' | 'test' | 'results' | 'summary' | 'replay'

export type WrapAction =
  /** A recorded, scored take played once through: grade it. */
  | 'finishTake'
  /** A recorded (unscored) practice pass played once through: go watch it back. */
  | 'finishRecordRun'
  /** Side-by-side replay: stop at the end and wait for ▶ Replay. */
  | 'hold'
  /** Drilling: wait the break, then run the segment again. */
  | 'repeat'
  /** Drilling: the requested number of reps is done. */
  | 'repsDone'

export interface WrapState {
  /** A scored take is being recorded (rater). Outranks segMode — the take owns the pass. */
  takeActive: boolean
  /** An unscored practice pass is being recorded to watch back. Also owns its pass. */
  recordRun: boolean
  segMode: WrapMode
  /** Reps completed BEFORE this wrap. */
  repsSoFar: number
  /** Requested reps; Infinity = loop until they move on. */
  repLimit: number
}

/** Decide what a loop wrap means for the current stage state. */
export function loopWrapAction(s: WrapState): WrapAction {
  if (s.takeActive) return 'finishTake'
  // A record-my-run pass is a single take too: one pass, then straight to watch-back.
  if (s.recordRun) return 'finishRecordRun'
  if (s.segMode === 'replay') return 'hold'
  // The full run-through keeps cycling until the dancer says they've got it — a pass
  // ending is never "done", so a rep limit doesn't apply to it either.
  if (s.segMode === 'runthrough') return 'repeat'
  const done = s.repsSoFar + 1
  return s.repLimit !== Infinity && done >= s.repLimit ? 'repsDone' : 'repeat'
}
