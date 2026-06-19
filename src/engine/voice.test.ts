import { describe, it, expect } from 'vitest'
import { parseVoiceCommand } from './voice'

describe('parseVoiceCommand', () => {
  it('matches bare commands', () => {
    expect(parseVoiceCommand('pause')).toBe('pause')
    expect(parseVoiceCommand('play')).toBe('play')
    expect(parseVoiceCommand('rewind')).toBe('restart')
    expect(parseVoiceCommand('mirror')).toBe('toggleMirror')
    expect(parseVoiceCommand('loop')).toBe('toggleLoop')
  })

  it('matches commands behind a wake word', () => {
    expect(parseVoiceCommand('hey movewith pause')).toBe('pause')
    expect(parseVoiceCommand('hey move, rewind that')).toBe('restart')
    expect(parseVoiceCommand('movewith go slower')).toBe('slower')
  })

  it('prefers the more specific phrase', () => {
    // "start over" should be restart even though it contains "start" (play).
    expect(parseVoiceCommand('start over')).toBe('restart')
    // "normal speed" should not be read as "slower"/"faster".
    expect(parseVoiceCommand('back to normal speed')).toBe('normalSpeed')
  })

  it('handles punctuation and casing', () => {
    expect(parseVoiceCommand('Pause!')).toBe('pause')
    expect(parseVoiceCommand('  SLOW   DOWN  ')).toBe('slower')
  })

  it('returns null when nothing matches', () => {
    expect(parseVoiceCommand('what a great song')).toBeNull()
    expect(parseVoiceCommand('')).toBeNull()
  })

  it('does not match a command embedded in a larger word', () => {
    // "display" contains "play" but should not trigger play.
    expect(parseVoiceCommand('display')).toBeNull()
  })
})
