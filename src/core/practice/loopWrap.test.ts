import { describe, it, expect } from 'vitest'
import { loopWrapAction, type WrapState } from './loopWrap'

const base: WrapState = { takeActive: false, segMode: 'watch', repsSoFar: 0, repLimit: Infinity }

describe('loopWrapAction', () => {
  it('grades a recorded take, whatever the stage says', () => {
    expect(loopWrapAction({ ...base, takeActive: true, segMode: 'test' })).toBe('finishTake')
    // The take outranks every other mode — it owns the pass it's recording.
    expect(loopWrapAction({ ...base, takeActive: true, segMode: 'runthrough' })).toBe('finishTake')
    expect(loopWrapAction({ ...base, takeActive: true, segMode: 'replay' })).toBe('finishTake')
  })

  it('holds at the end of a side-by-side replay', () => {
    expect(loopWrapAction({ ...base, segMode: 'replay' })).toBe('hold')
  })

  it('ends the final practice pass instead of looping it', () => {
    expect(loopWrapAction({ ...base, segMode: 'runthrough' })).toBe('finishRun')
    // Even with reps configured: the run-through is one pass, not a drill.
    expect(loopWrapAction({ ...base, segMode: 'runthrough', repLimit: 5 })).toBe('finishRun')
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
