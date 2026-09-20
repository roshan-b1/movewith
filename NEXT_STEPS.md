# MoveWith — Next Steps

Ideas captured while building, parked for later. Nothing here is built yet; each is a
deliberate "do later" so the current app stays focused.

## Practice / learning flow

- **Smarter segment auto-generation.** Auto-detect now cuts on *distinct-movement* changes: a
  pose self-similarity novelty curve (Foote checkerboard, kernel ≈ one target segment) fires
  only where the body's pose content shifts into a new phrase, and repeated motion is left
  whole because a repeat looks self-similar (low novelty). Cuts snap to the beat when a tempo
  is known; playback-only tracks fall back to a beat/even split. Result: each segment is a
  short phrase of a few moves, not a time slice, and a move done several times isn't chopped.
  Next level: name/classify the actual step in each segment (below). The manual segment creator
  (tap to place cuts) stays the primary path. Tuning knobs in `segment.ts`: `CONTRAST_FLOOR`
  (raise = fewer/coarser cuts) and `MIN_DISTINCT_DEG` (how many degrees of joint movement
  separate "same move, jittered" from "new move") — worth revisiting against real footage.
- **Thorough step-direction detection — BUILT but NOT SHOWN.** `core/reference/describe.ts`
  derives a kinematic character per segment: which limbs carry the move (Arms / Footwork /
  Full body), whether it travels across the frame, and a repeat count from pose
  self-matching. It was surfaced on the practice badge and as rater tooltips, and pulled
  back out: labels like "Arms · travels" are too vague to be worth the clutter while you're
  trying to learn a move. The module and its tests stay for when there's something worth
  saying. That needs real step NAMING (grapevine, bodyroll, …), which needs a labeled move
  dataset — the honest blocker.
- **Auto-detect dancing vs talking — BUILT.** Sustained stretches where the legs sit
  near-still read as explanation, not dancing (`core/reference/talking.ts`); auto-detect
  DELETES those parts outright (with an undo toast), so they leave a visible hole you can
  tap to put back. Validated: an all-dance real video gets zero false positives. Future: a
  "jump straight to the dancing" control on first open.
- **Deleting parts, and undo/redo — BUILT.** ✕ on a segment removes that stretch from the
  routine for good rather than merging its time into a neighbour: the moves either side
  stay separate, everything renumbers, and playback jumps the gap (including mid-routine
  holes). Deleted time is kept as ranges in `PracticeSetup.cuts`, subtracted from the
  segment list by `buildMovesFromBounds` — old saves that stored skipped segment INDICES
  are migrated to ranges on open. The whole editor is undoable (`core/practice/history.ts`,
  ⌘Z / ⇧⌘Z), one step per gesture rather than per drag frame. Double-clicking a divider
  joins two segments without losing time. Future: drag a selection to cut an arbitrary
  range, rather than only whole segments.
- **Smarter segment drilling — MOSTLY BUILT.** Practice ends with a camera-free full
  run-through that LOOPS (with speed + mirror) until you tap Got it, which hands off to Test
  my skills. Combo practice loops 2 or 3 consecutive segments together so the join between
  moves gets rehearsed, and Got it marks the whole combo. Test my skills is one continuous
  pass of the whole dance to the music, sliced back up by instructor time for a part-by-part
  recap. Still future: graded slow-down across the run (start at 0.5x and work up
  automatically), and combos that span a chosen range rather than N-consecutive.

## Content / modes

- **Mix / medley mode — BUILT.** Stitch parts of several dances into one routine (medleys,
  wedding/showcase performances that jump between songs). See `MIX.md` for the architecture.
  Shipped: "Make a mix" on the library → editor where you switch to any uploaded dance in
  any order, set an in/out on it, and drag (or tap ＋) the part onto an always-visible mix
  track; reorder by drag or ‹ ›, delete with ✕, live-preview the whole medley, name + save.
  Saved mixes live in "Your mixes" and practice like a dance: drill each part on a loop
  (slow / mirror), then a full run-through, with the same "got every part → run it through"
  beat as normal practice. Data model: `Mix = { clips: {sourceTrackId,startSec,endSec}[] }`
  referencing source tracks' video blobs (no blob of its own; deleting a mix never touches
  the sources). Tempos need not align. No camera/scoring on mixes (deliberate).
  - **Future on top of this:** camera scoring for mixes; sub-segmenting a part into smaller
    drill chunks; crossfading audio at the seams; and combining across clips is done, but a
    "remix from segments you already cut in practice" shortcut could be added.
- **Music-video mode.** Pick a dancer to follow through a full music video (depends on
  pick-a-character multi-dancer select), mirror them the whole song, then play your run back.
- **Built-in famous dances.** A library of known routines (Macarena, etc.) ready to learn,
  not just user uploads.
- **Front and back view.** Show the instructor from front AND back (toggle) so the learner
  can follow whichever way is easier.

## Visual / onboarding

- **Onboarding tutorial video.** A short "watch this first" walkthrough that plays for
  first-time users before they start.

## Platform / infra

- **Pick a character — BUILT (and now multi-select).** Multi-dancer videos let you tap ONE
  dancer (solo) or SEVERAL in "Test my skills", so a group can dance together: the live
  webcam tracks up to 4 people, each matched to their chosen reference dancer by on-screen
  position (left → right, mirrored), each scored separately with color-matched skeletons and
  a per-dancer recap. Future: name the people instead of "Dancer 1 / Dancer 2", and handle
  dancers who swap places mid-song (matching is positional per frame, not identity-based).
- **Signalsmith Stretch** for studio-grade pitch-preserved slow-mo (current slow-mo uses the
  browser's native `preservesPitch`).
- **Desktop app (Tauri)** wrapper for the smoothest playback, accounts, and cloud sharing /
  leaderboards.

---

Everything runs client-side today: your webcam never leaves the device, and tracks +
segments + progress live in IndexedDB.
