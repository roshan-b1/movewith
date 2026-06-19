import { describe, it, expect } from 'vitest'
import { makeTempo, buildSections, sectionAt } from './beats'

describe('makeTempo', () => {
  it('derives the beat interval from bpm', () => {
    const t = makeTempo(120, 0.5)
    expect(t.beatIntervalSec).toBeCloseTo(0.5, 6)
    expect(t.firstBeatSec).toBe(0.5)
  })
  it('falls back to 120 bpm for nonsense input', () => {
    expect(makeTempo(0, 0).bpm).toBe(120)
  })
})

describe('buildSections', () => {
  it('cuts a track into 8-count sections of the right length', () => {
    // 120 bpm => 0.5s/beat => 4s per 8-count. First beat at 0. 16s track => 4 sections.
    const tempo = makeTempo(120, 0)
    const sections = buildSections(tempo, { durationSec: 16, beatsPerSection: 8 })
    expect(sections).toHaveLength(4)
    expect(sections[0]!.startSec).toBe(0)
    expect(sections[0]!.endSec).toBeCloseTo(4, 6)
    expect(sections[3]!.endSec).toBeCloseTo(16, 6)
  })

  it('clamps the final section to the track duration', () => {
    const tempo = makeTempo(120, 0)
    const sections = buildSections(tempo, { durationSec: 10, beatsPerSection: 8 })
    expect(sections[sections.length - 1]!.endSec).toBeCloseTo(10, 6)
  })

  it('adds an Intro lead-in when the first beat is late', () => {
    const tempo = makeTempo(120, 3) // first beat 3s in; section length 4s
    const sections = buildSections(tempo, { durationSec: 16, beatsPerSection: 8, includeLeadIn: true })
    expect(sections[0]!.label).toBe('Intro')
    expect(sections[0]!.startSec).toBe(0)
    expect(sections[0]!.endSec).toBe(3)
  })
})

describe('sectionAt', () => {
  it('finds the section containing a time', () => {
    const tempo = makeTempo(120, 0)
    const sections = buildSections(tempo, { durationSec: 16, beatsPerSection: 8 })
    expect(sectionAt(sections, 5)!.index).toBe(1)
    expect(sectionAt(sections, 0)!.index).toBe(0)
  })
})
