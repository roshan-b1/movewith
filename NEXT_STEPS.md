# MoveWith — Next Steps

Ideas captured while building, parked for later. Nothing here is built yet; each is a
deliberate "do later" so the current app stays focused.

## Practice / learning flow

- **Proper segment auto-generation.** Today's "Auto-detect" is a rough heuristic (it cuts on
  motion lows / pauses). Build a real segmenter that places boundaries on actual move/step
  transitions. The manual segment creator (tap to place cuts) stays the primary path.
- **Thorough step-direction detection.** Recognize the actual dance step in each segment, not
  just split by time. Feeds the auto-generation above.
- **Auto-detect dancing vs talking.** Find the dance parts of a tutorial automatically and a
  mode that jumps straight to them (skips intros/explanations without manual cutting).
- **Smarter segment drilling.** Per-segment replay counts, an explicit "mark complete" beyond
  the auto-unlock, then a final full run-through "real practice" mode with graded slow-down.

## Content / modes

- **Remix mode.** Combine sections from multiple tutorials into a custom routine and dance it
  to your own uploaded music track. (Foundation fits: a ReferenceTrack is a serializable
  segment/frame list, so stitching is mostly concatenation; the open problem is re-aligning
  tempos across clips.)
- **Music-video mode.** Pick a dancer to follow through a full music video (depends on
  pick-a-character multi-dancer select), mirror them the whole song, then play your run back.
- **Built-in famous dances.** A library of known routines (Macarena, etc.) ready to learn,
  not just user uploads.
- **Front and back view.** Show the instructor from front AND back (toggle) so the learner
  can follow whichever way is easier.

## Visual / onboarding

- ✅ **Just-Dance-style rigged dancer — DONE** (and upgraded to full 3D). A rigged VRM
  humanoid rendered with three.js, driven per-frame from any routine's stored landmarks via
  Kalidokit (`src/ui/avatar/InstructorAvatar.ts`). Works for the demo and every upload.
  Follow-ups: avatar picker (multiple characters), hand/finger detail, hip-travel from
  image-space landmarks for uploads, richer stage (shadows, lighting themes).
- **Onboarding tutorial video.** A short "watch this first" walkthrough that plays for
  first-time users before they start.

## Platform / infra

- **Pick a character.** Multi-dancer select when a tutorial has more than one person
  (MediaPipe `numPoses` > 1 + click-to-track).
- **Signalsmith Stretch** for studio-grade pitch-preserved slow-mo (current slow-mo uses the
  browser's native `preservesPitch`).
- **Desktop app (Tauri)** wrapper for the smoothest playback, accounts, and cloud sharing /
  leaderboards.

---

Everything runs client-side today: your webcam never leaves the device, and tracks +
segments + progress live in IndexedDB.
