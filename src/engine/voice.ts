// Hands-free voice control. You're across the room dancing, not at the keyboard, so you
// can say "pause", "rewind", "slower", "loop", "next" and it just happens. Uses the
// browser's Web Speech API (Chrome/Edge). The command PARSER is a pure function so it can
// be unit-tested without a microphone.
//
// Privacy note: browser speech recognition streams audio to the browser vendor's speech
// service while listening. It is strictly opt-in (you toggle it on) and off by default,
// unlike the camera which is always fully local.

export type VoiceCommand =
  | 'play'
  | 'pause'
  | 'restart'
  | 'slower'
  | 'faster'
  | 'normalSpeed'
  | 'toggleLoop'
  | 'toggleMirror'
  | 'next'
  | 'prev'
  | 'toggleSkeleton'

/** Phrase patterns, checked top to bottom. More specific phrases come first so e.g.
 *  "start over" maps to restart, not play. */
const PATTERNS: ReadonlyArray<{ cmd: VoiceCommand; words: readonly string[] }> = [
  { cmd: 'restart', words: ['rewind', 'restart', 'start over', 'from the top', 'again', 'reset', 'over again'] },
  { cmd: 'normalSpeed', words: ['normal speed', 'full speed', 'regular speed', 'normal'] },
  { cmd: 'faster', words: ['faster', 'speed up', 'quicker'] },
  { cmd: 'slower', words: ['slower', 'slow down', 'slow mo', 'slow motion', 'half speed'] },
  { cmd: 'next', words: ['next', 'unlock next', 'move on', 'forward'] },
  { cmd: 'prev', words: ['previous', 'go back', 'last one', 'back a section'] },
  { cmd: 'toggleLoop', words: ['loop', 'repeat'] },
  { cmd: 'toggleMirror', words: ['mirror', 'flip'] },
  { cmd: 'toggleSkeleton', words: ['skeleton', 'bones', 'overlay'] },
  { cmd: 'pause', words: ['pause', 'stop', 'freeze', 'hold on', 'wait'] },
  { cmd: 'play', words: ['play', 'go', 'start', 'resume', 'continue', 'begin'] },
]

/** Wake words that may optionally prefix a command (stripped before matching). */
const WAKE_WORDS = ['hey movewith', 'movewith', 'hey move', 'okay movewith', 'yo movewith']

/**
 * Parse a heard phrase into a command, or null if nothing matched.
 * Tolerant: the command word can appear anywhere in the phrase, with or without a
 * wake word ("hey movewith, pause" and bare "pause" both work).
 */
export function parseVoiceCommand(phrase: string): VoiceCommand | null {
  let p = ` ${phrase.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()} `
  for (const w of WAKE_WORDS) {
    const idx = p.indexOf(w)
    if (idx >= 0) {
      p = ' ' + p.slice(idx + w.length).trim() + ' '
      break
    }
  }
  for (const { cmd, words } of PATTERNS) {
    for (const w of words) {
      if (p.includes(` ${w} `)) return cmd
    }
  }
  return null
}

// ---- Minimal Web Speech API typings (not in lib.dom for all targets) ----
interface SpeechRecognitionAlternativeLike {
  transcript: string
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike
  isFinal: boolean
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [i: number]: SpeechRecognitionResultLike }
}
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export type VoiceStatus = 'listening' | 'stopped' | 'error'

export interface VoiceControllerOptions {
  onCommand: (cmd: VoiceCommand, heard: string) => void
  onStatus?: (status: VoiceStatus, detail?: string) => void
  /** Optional: surface raw transcripts for a "heard: ..." readout. */
  onHeard?: (text: string) => void
}

export class VoiceController {
  private rec: SpeechRecognitionLike | null = null
  private enabled = false
  private lastCmd: { cmd: VoiceCommand; at: number } | null = null

  constructor(private opts: VoiceControllerOptions) {}

  static isSupported(): boolean {
    return getRecognitionCtor() !== null
  }

  start() {
    if (this.enabled) return
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      this.opts.onStatus?.('error', 'Voice control needs Chrome or Edge.')
      return
    }
    this.enabled = true
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = 'en-US'

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (!r || !r.isFinal) continue
        const text = r[0].transcript.trim()
        if (text) this.opts.onHeard?.(text)
        const cmd = parseVoiceCommand(text)
        if (cmd) this.fire(cmd, text)
      }
    }
    rec.onerror = (ev) => {
      // 'no-speech' / 'aborted' are routine; surface only real problems.
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.opts.onStatus?.('error', 'Microphone permission was blocked.')
        this.enabled = false
      }
    }
    rec.onend = () => {
      // The engine stops itself periodically; restart while still enabled.
      if (this.enabled) {
        try {
          rec.start()
        } catch {
          /* already starting */
        }
      } else {
        this.opts.onStatus?.('stopped')
      }
    }

    this.rec = rec
    try {
      rec.start()
      this.opts.onStatus?.('listening')
    } catch {
      this.opts.onStatus?.('error', 'Could not start the microphone.')
      this.enabled = false
    }
  }

  stop() {
    this.enabled = false
    if (this.rec) {
      this.rec.onend = null
      try {
        this.rec.abort()
      } catch {
        /* noop */
      }
      this.rec = null
    }
    this.opts.onStatus?.('stopped')
  }

  /** Debounce identical commands so one spoken phrase fires once. */
  private fire(cmd: VoiceCommand, heard: string) {
    const now = performance.now()
    if (this.lastCmd && this.lastCmd.cmd === cmd && now - this.lastCmd.at < 1200) return
    this.lastCmd = { cmd, at: now }
    this.opts.onCommand(cmd, heard)
  }
}
