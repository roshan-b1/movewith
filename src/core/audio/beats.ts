// Turn a detected tempo (BPM + where the first beat lands) into the 8-counts that
// drive step-by-step learning. Dance is taught in 8-counts, so each section spans
// `beatsPerSection` beats (default 8) starting from the first beat.

export interface Tempo {
  bpm: number
  /** Seconds from start of audio to the first detected beat. */
  firstBeatSec: number
  /** Convenience: 60 / bpm. */
  beatIntervalSec: number
}

export interface Section {
  index: number
  label: string
  startSec: number
  endSec: number
  /** Beat number (0-based) where the section begins. */
  startBeat: number
}

export function makeTempo(bpm: number, firstBeatSec: number): Tempo {
  const safeBpm = bpm > 0 ? bpm : 120
  return { bpm: safeBpm, firstBeatSec: Math.max(0, firstBeatSec), beatIntervalSec: 60 / safeBpm }
}

export interface SectioningOptions {
  beatsPerSection?: number
  /** Total duration of the source in seconds. */
  durationSec: number
  /** Include the lead-in (before the first beat) as section 0 if it's long enough. */
  includeLeadIn?: boolean
}

/**
 * Build evenly-spaced 8-count sections across the track. The final section is
 * clamped to the track duration so it never runs past the end.
 */
export function buildSections(tempo: Tempo, opts: SectioningOptions): Section[] {
  const beatsPerSection = Math.max(1, opts.beatsPerSection ?? 8)
  const sectionSec = tempo.beatIntervalSec * beatsPerSection
  const sections: Section[] = []

  if (sectionSec <= 0 || opts.durationSec <= 0) return sections

  let index = 0

  // Optional lead-in before beat 1 (e.g. an intro), only if it's at least half a section.
  if (opts.includeLeadIn && tempo.firstBeatSec >= sectionSec * 0.5) {
    sections.push({
      index: index++,
      label: 'Intro',
      startSec: 0,
      endSec: tempo.firstBeatSec,
      startBeat: 0,
    })
  }

  let beat = 0
  let start = tempo.firstBeatSec
  while (start < opts.durationSec - 0.05) {
    const end = Math.min(start + sectionSec, opts.durationSec)
    sections.push({
      index: index,
      label: `8-count #${sections.filter((s) => s.label !== 'Intro').length + 1}`,
      startSec: start,
      endSec: end,
      startBeat: beat,
    })
    index++
    beat += beatsPerSection
    start = end
  }

  return sections
}

/** Which section contains a given time (or null if none). */
export function sectionAt(sections: Section[], t: number): Section | null {
  for (const s of sections) {
    if (t >= s.startSec && t < s.endSec) return s
  }
  return sections.length > 0 && t >= sections[sections.length - 1]!.endSec
    ? sections[sections.length - 1]!
    : null
}
