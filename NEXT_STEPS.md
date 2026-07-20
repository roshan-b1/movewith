# MoveWith — Next Steps

Ideas captured while building, parked for later. Nothing here is built yet; each is a
deliberate "do later" so the current app stays focused.

## Practice / learning flow

- **Smarter segment auto-generation.** Auto-detect now aligns cuts to the song's beat grid
  (~target length in beats) and snaps each to the quietest nearby beat — musical and much
  better than the old even-spacing. Next level: recognize the actual move/step in each segment
  (see below) so boundaries land on real step transitions, not just quiet beats. The manual
  segment creator (tap to place cuts) stays the primary path.
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

- **Just-Dance-style rigged dancer — BUILT, currently HIDDEN.** The implementation exists but
  is switched off (`ENABLE_3D_AVATAR = false` in Practice.tsx) because it isn't presentable
  enough to show yet; the code, the .glb, and the solver all stay so it can be flipped back on
  once it's improved. A matte-black MALE silhouette mannequin (Mixamo Y Bot) rendered with
  three.js on a rim-lit stage with real shadows, driven per-frame from any routine's stored
  landmarks
  (`src/ui/avatar/InstructorAvatar.ts`). The solver is fully CUSTOM and direction-exact
  (Kalidokit was removed — it clamps folds behind the body and hip yaw, so behind-the-head
  moves and full turns came out wrong): every limb bone aligns to its landmark bone vector
  via rest-pose-quaternion retargeting, the hips/torso follow a full orientation basis
  from the hip+shoulder lines (handles 360° turns), plus a head/neck solver from face
  landmarks, clavicle shrug, foot planting, and a ground clamp (feet never dip through the
  stage; jumps still work). NOTES: person's left drives the mannequin's left (true view —
  the person's left hand appears on the viewer's right, like watching a dancer face you).
  The Y Bot GLB's usable T-pose clip is named "mixamo.com"; its "T-Pose" clip is an empty
  stub, and stopping the mixer would reset the pose. Also done: camera-relative stage
  travel for uploads (walks toward/away + across the stage, from image-space torso size
  vs the routine median — `core/pose/travel.ts`, unit-tested) and relaxed finger
  articulation. Follow-ups: avatar picker (multiple characters to choose from), live
  per-finger tracking (needs a hand-landmark model, not pose), lighting themes.
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
