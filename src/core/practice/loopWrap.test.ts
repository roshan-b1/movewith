import { describe, it, expect } from 'vitest'
import { loopWrapAction, type WrapState } from './loopWrap'

const base: WrapState = { takeActive: false, recordRun: false, segMode: 'watch', repsSoFar: 0, repLimit: Infinity }

describe('loopWrapAction', () => {
  it('grades a recorded take, whatever the stage says', () => {
    expect(loopWrapAction({ ...base, takeActive: true, segMode: 'test' })).toBe('finishTake')
    // The take outranks every other mode — it owns the pass it's recording.
    expect(loopWrapAction({ ...base, takeActive: true, segMode: 'runthrough' })).toBe('finishTake')
    expect(loopWrapAction({ ...base, takeActive: true, segMode: 'replay' })).toBe('finishTake')
  })

  it('ends a record-my-run pass after one loop, sending it to watch-back', () => {
    expect(loopWrapAction({ ...base, recordRun: true, segMode: 'recordrun' })).toBe('finishRecordRun')
    // A rep limit is a drilling concept; it must not cut a record pass short differently.
    expect(loopWrapAction({ ...base, recordRun: true, segMode: 'recordrun', repLimit: 1 })).toBe('finishRecordRun')
  })

  it('holds at the end of a side-by-side replay', () => {
    expect(loopWrapAction({ ...base, segMode: 'replay' })).toBe('hold')
  })

  it('keeps the full run-through cycling until the dancer says Got it', () => {
    expect(loopWrapAction({ ...base, segMode: 'runthrough' })).toBe('repeat')
    // A rep limit belongs to segment drilling; it must not cut the run-through short.
    expect(loopWrapAction({ ...base, segMode: 'runthrough', repLimit: 1, repsSoFar: 9 })).toBe('repeat')
  })

  it('loops forever while drilling with no rep limit', () => {
    expect(loopWrapAction(base)).toBe('repeat')
    expect(loopWrapAction({ ...base, repsSoFar: 99 })).toBe('repeat')
  })

  it('stops drilling once the requested reps are done', () => {
    expect(loopWrapAction({ ...base, repLimit: 3, repsSoFar: 0 })).toBe('repeat')
    expect(loopWrapAction({ ...base, repLimit: 3, repsSoFar: 1 })).toBe('repeat')
    expect(loopWrapAction({ ...base, repLimit: 3, repsSoFar: 2 })).toBe('repsDone') // 3rd pass
    expect(loopWrapAction({ ...base, repLimit: 1, repsSoFar: 0 })).toBe('repsDone')
  })
})
