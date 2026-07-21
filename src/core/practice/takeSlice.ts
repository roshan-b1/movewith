// "Test my skills" is ONE continuous pass of the whole dance, not a stop-start take per
// segment. To still give a part-by-part recap, the single take is cut back up by instructor
// time. Every recorded frame carries the routine position it was danced against, so slicing
// is exact even when playback jumped over parts marked skip. Pure + testable.

export interface TimedFrame {
  /** Instructor time (seconds) this frame was danced against. */
  t: number
  angles: number[]
}

export interface SegmentRange {
  index: number
  startSec: number
  endSec: number
}

/**
 * Split one continuous take into the frames belonging to each segment. Ranges are
 * half-open [start, end) so a frame on a boundary belongs to exactly one segment and is
 * never double-counted. Segments the dancer never reached come back empty.
 */
export function sliceTakeBySegments(
  take: readonly TimedFrame[],
  segments: readonly SegmentRange[],
): { index: number; angles: number[][] }[] {
  return segments.map((seg) => ({
    index: seg.index,
    angles: take.filter((f) => f.t >= seg.startSec && f.t < seg.endSec).map((f) => f.angles),
  }))
}
