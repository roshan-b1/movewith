import { describe, it, expect } from 'vitest'
import { pushEdit, undoEdit, redoEdit, emptyHistory, HISTORY_LIMIT, type EditSnapshot } from './history'

const snap = (bounds: number[], cuts: Array<[number, number]> = []): EditSnapshot => ({
  trimStart: 0,
  trimEnd: 20,
  moveBounds: bounds,
  cuts,
})

describe('edit history', () => {
  it('undoes back to the state before an edit', () => {
    const before = snap([5, 10])
    const h = pushEdit(emptyHistory, before)
    const after = snap([5, 10, 15])
    const u = undoEdit(h, after)!
    expect(u.state.moveBounds).toEqual([5, 10])
  })

  it('redoes the edit it just undid', () => {
    const before = snap([5])
    const after = snap([5, 10])
    const h = pushEdit(emptyHistory, before)
    const u = undoEdit(h, after)!
    const r = redoEdit(u.history, u.state)!
    expect(r.state.moveBounds).toEqual([5, 10])
  })

  it('walks back through several edits in order', () => {
    let h = pushEdit(emptyHistory, snap([]))
    h = pushEdit(h, snap([5]))
    h = pushEdit(h, snap([5, 10]))
    const u1 = undoEdit(h, snap([5, 10, 15]))!
    expect(u1.state.moveBounds).toEqual([5, 10])
    const u2 = undoEdit(u1.history, u1.state)!
    expect(u2.state.moveBounds).toEqual([5])
    const u3 = undoEdit(u2.history, u2.state)!
    expect(u3.state.moveBounds).toEqual([])
    expect(undoEdit(u3.history, u3.state)).toBeNull()
  })

  it('restores a deleted part on undo', () => {
    const h = pushEdit(emptyHistory, snap([5, 10], []))
    const u = undoEdit(h, snap([5, 10], [[5, 10]]))!
    expect(u.state.cuts).toEqual([])
  })

  it('drops the redo stack once you make a new edit', () => {
    const h = pushEdit(emptyHistory, snap([5]))
    const u = undoEdit(h, snap([5, 10]))!
    expect(u.history.future).toHaveLength(1)
    const h2 = pushEdit(u.history, u.state)
    expect(h2.future).toHaveLength(0)
    expect(redoEdit(h2, snap([5]))).toBeNull()
  })

  it('does not record a no-op as a step', () => {
    const h = pushEdit(emptyHistory, snap([5]))
    const same = pushEdit(h, snap([5]))
    expect(same.past).toHaveLength(1)
  })

  it('forgets the oldest steps past the limit', () => {
    let h = emptyHistory
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = pushEdit(h, snap([i]))
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    expect(h.past[0]!.moveBounds).toEqual([10])
  })

  it('has nothing to undo or redo when empty', () => {
    expect(undoEdit(emptyHistory, snap([]))).toBeNull()
    expect(redoEdit(emptyHistory, snap([]))).toBeNull()
  })
})
