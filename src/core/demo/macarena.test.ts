import { describe, expect, it } from 'vitest'
import { generateMacarena, MACARENA_TRACK_ID } from './macarena'
import { LANDMARK_COUNT, LM } from '../pose/types'

describe('generateMacarena', () => {
  const track = generateMacarena(1234)

  it('builds a well-formed bundled track', () => {
    expect(track.id).toBe(MACARENA_TRACK_ID)
    expect(track.source.type).toBe('bundled')
    expect(track.source.durationSec).toBeCloseTo((64 * 60) / 103, 2)
    expect(track.frames.length).toBeGreaterThan(800)
    expect(track.tempo.bpm).toBe(103)
  })

  it('every frame has finite full-body landmarks', () => {
    for (const f of track.frames) {
      expect(f.world).toHaveLength(LANDMARK_COUNT)
      for (const lm of f.world) {
        expect(Number.isFinite(lm.x + lm.y + (lm.z ?? 0))).toBe(true)
      }
    }
  })

  it('is deterministic for a fixed createdAt', () => {
    const again = generateMacarena(1234)
    expect(again.frames[100]!.world).toEqual(track.frames[100]!.world)
  })

  it('runs the phrase at four facings (quarter-turn after each 16 counts)', () => {
    // Same phrase-relative moment (count 1, right arm out front), one phrase apart —
    // facing front the arm reaches toward the camera (-z), facing left it reaches +x.
    const beatSec = 60 / 103
    const at = (sec: number) => track.frames[Math.round(sec * track.source.fps)]!
    const front = at(1.2 * beatSec)
    const turned = at((16 + 1.2) * beatSec)
    const frontWrist = front.world[LM.rightWrist]!
    const turnedWrist = turned.world[LM.rightWrist]!
    expect(frontWrist.z ?? 0).toBeLessThan(-0.3) // reaches toward camera
    expect(Math.abs(turnedWrist.z ?? 0)).toBeLessThan(0.25) // no longer toward camera
    expect(Math.abs(turnedWrist.x)).toBeGreaterThan(0.3) // now reaches sideways in world
  })

  it('keeps the dancer roughly upright through the turns (head above hips)', () => {
    for (let i = 0; i < track.frames.length; i += 24) {
      const f = track.frames[i]!
      const nose = f.world[LM.nose]!
      const hip = f.world[LM.leftHip]!
      expect(nose.y).toBeLessThan(hip.y) // y is down: head is above hips
    }
  })
})
