// The dancer picker depends on association being stable: the person you pick must stay
// the same track across the whole video, and background passers-by must not become
// "dancers". These tests pin that behavior with synthetic detections.

import { describe, expect, it } from 'vitest'
import { associatePeople, type DetectedFrame, type DetectedPerson } from './people'
import { LM, type Landmark } from './types'

/** A person standing at image-x `cx` with torso width/height `size`. */
function person(cx: number, size: number, cy = 0.5): DetectedPerson {
  const lm = (): Landmark => ({ x: cx, y: cy, z: 0, visibility: 1 })
  const image: Landmark[] = Array.from({ length: 33 }, lm)
  image[LM.leftShoulder] = { x: cx - size / 2, y: cy - size / 2, z: 0, visibility: 1 }
  image[LM.rightShoulder] = { x: cx + size / 2, y: cy - size / 2, z: 0, visibility: 1 }
  image[LM.leftHip] = { x: cx - size / 3, y: cy + size / 2, z: 0, visibility: 1 }
  image[LM.rightHip] = { x: cx + size / 3, y: cy + size / 2, z: 0, visibility: 1 }
  return { world: image.map((l) => ({ ...l })), image }
}

const frame = (t: number, ...people: DetectedPerson[]): DetectedFrame => ({ t, people })

describe('associatePeople', () => {
  it('keeps two side-by-side dancers as two stable tracks', () => {
    // Left dancer sways around x=0.3, right dancer around x=0.7, 40 samples.
    const frames = Array.from({ length: 40 }, (_, i) =>
      frame(i * 0.1, person(0.3 + 0.02 * Math.sin(i), 0.2), person(0.7 + 0.02 * Math.cos(i), 0.15)),
    )
    const tracks = associatePeople(frames)
    expect(tracks).toHaveLength(2)
    // Track 0 = most prominent (bigger torso) = the left dancer.
    expect(tracks[0]!).toHaveLength(40)
    expect(tracks[1]!).toHaveLength(40)
    const xs0 = tracks[0]!.map((f) => f.image[LM.leftShoulder]!.x)
    expect(Math.max(...xs0)).toBeLessThan(0.5) // never jumps to the right-hand person
  })

  it('detection order per frame does not matter', () => {
    const frames = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? frame(i * 0.1, person(0.3, 0.2), person(0.7, 0.15))
        : frame(i * 0.1, person(0.7, 0.15), person(0.3, 0.2)), // swapped order
    )
    const tracks = associatePeople(frames)
    expect(tracks).toHaveLength(2)
    for (const tr of tracks) {
      const xs = tr.map((f) => f.image[LM.leftShoulder]!.x)
      const spread = Math.max(...xs) - Math.min(...xs)
      expect(spread).toBeLessThan(0.1) // each track stayed on one person
    }
  })

  it('tolerates a person missing for a few samples', () => {
    const frames = Array.from({ length: 30 }, (_, i) =>
      i >= 10 && i < 14 ? frame(i * 0.1, person(0.3, 0.2)) : frame(i * 0.1, person(0.3, 0.2), person(0.7, 0.15)),
    )
    const tracks = associatePeople(frames)
    expect(tracks).toHaveLength(2) // the gap did not split the right dancer into two tracks
    expect(tracks[1]!.length).toBe(26)
  })

  it('drops fleeting background people', () => {
    const frames = Array.from({ length: 30 }, (_, i) => {
      const ppl = [person(0.5, 0.2)]
      if (i === 4 || i === 5) ppl.push(person(0.9, 0.05)) // someone walks past for 2 frames
      return frame(i * 0.1, ...ppl)
    })
    const tracks = associatePeople(frames)
    expect(tracks).toHaveLength(1)
  })

  it('handles a single dancer and empty input', () => {
    const solo = Array.from({ length: 10 }, (_, i) => frame(i * 0.1, person(0.5, 0.2)))
    expect(associatePeople(solo)).toHaveLength(1)
    expect(associatePeople([])).toHaveLength(0)
  })
})
