# MoveWith 🕺

A smart dance tutorial that **moves with you**. Load (or upload) a routine, and MoveWith
watches you through your webcam and coaches you **8-count by 8-count** — with slow-mo,
section looping, mirror mode, and live per-limb feedback. No more pausing and rewinding:
loop a section until it turns green, and the next one unlocks.

Everything runs **in your browser**. Your webcam never leaves your device.

## Run it

```bash
npm install
npm run dev      # open the printed http://localhost:5173 in a real browser tab
```

> ⚠️ Open it in a **real, focused browser tab** — the live loop uses `requestAnimationFrame`
> and the webcam (`getUserMedia`), which browsers suspend in hidden/headless tabs. Allow
> camera access when prompted.

On first open it generates a bundled **demo routine** so you can try the whole flow with
zero setup. Use the upload box to learn your own tutorial videos.

The instructor is a **rigged 3D dancer** (Just-Dance style): a matte-black male silhouette
mannequin on a rim-lit stage performs every routine — the demo and anything you upload —
driven frame-by-frame by the tracked pose. Full-body mechanics: head and neck follow the
tracked face, shoulders shrug naturally as arms rise, feet stay planted on the stage, and
he casts a real-time shadow. During practice on an uploaded video, toggle **🕺 3D dancer**
to switch between the dancer and the original footage.

**Controls:** Play/Pause (or **Spacebar**), slow-mo (1× / 0.75× / 0.5×, pitch-preserved),
**Mirror**, **Loop** the current 8-count, and a per-section restart. A live **8-count number**
shows where you are in the phrase, and a hint nudges you to step into frame if the camera
loses you.

### Other commands

```bash
npm run test        # 27 unit tests for the pose/compare/audio core
npm run typecheck   # strict TypeScript check
npm run build       # production build
```

## How it works

| Stage | What happens |
|-------|--------------|
| **Ingest** | An uploaded video is seeked frame-by-frame; **MediaPipe BlazePose** extracts 33 3D landmarks per frame. The audio is analysed for **BPM + first beat** and cut into 8-counts. |
| **Compare** | Poses are reduced to **joint angles** (body-size & camera independent), compared by per-joint error, and DTW-aligned so timing is forgiving. |
| **Coach** | Your webcam is tracked live; limbs turn green/red, a meter shows your match, and each looped take is scored. Cross the threshold → the next 8-count unlocks. |

## Architecture

Strict layers so any piece can change without breaking the rest:

- `src/core/` — pure, framework-free, unit-tested: angles, similarity, DTW, scoring,
  beat→section math, the versioned `ReferenceTrack` schema, and the bundled demo generator.
- `src/providers/` — `PoseProvider` interface + the MediaPipe implementation (swap point).
- `src/engine/` — orchestration: reference extraction, the live `PracticeEngine`, and the
  `PlaybackController` (slow-mo / loop / mirror; the swap point for higher-quality audio).
- `src/ui/avatar/` — the rigged 3D dancer: a Mixamo-rigged silhouette mannequin (three.js)
  driven from stored landmarks via Kalidokit, retargeted through rest-pose quaternions,
  with slerp smoothing between pose frames.
- `src/storage/` — IndexedDB (tracks, video blobs, progress).
- `src/state/` — Zustand session store.
- `src/ui/` — React screens & components (no business logic).

## Roadmap (foundation already supports these)

- 🧩 **Remix mode**: combine sections from multiple tutorials into your own routine, and
  upload your own music track to dance it to. (The `ReferenceTrack` is already a serializable
  list of sections + frames, so stitching is mostly concatenation; the open question is
  re-aligning 8-counts when combined clips have different tempos.)
- 🎭 **Pick a character**: multi-dancer detection plus click-to-follow in group videos.
- 🎬 **Music video mode**: pick a dancer to follow in a music video (uses pick-a-character),
  mirror them through the whole song instead of section-by-section, then play your performance
  back to you. The full-song, perform-it experience on top of the learn-it loop.
- ✅ **Just-Dance-style dancer** — shipped, and upgraded from the planned 2D sprite to a
  full rigged **3D** male silhouette mannequin (three.js + Kalidokit, Mixamo rig) with
  head/neck tracking, shoulder mechanics, and foot planting, performing any routine from
  its stored landmarks on a rim-lit stage with real shadows. Next: an avatar picker
  (multiple characters to choose from), hand/finger detail.
- 💃 **Built-in famous dances**: a library of well-known routines ready to learn out of the
  box (Macarena, etc.), not just user uploads.
- ⏭️ **Auto-detect the dancing parts**: in a tutorial video, tell when the instructor is actually
  dancing vs talking/explaining, and let a mode jump straight to the dance segments (skip the talking).
- 📊 **Practice report** (coaching mode only): after a full run with the song, show a report with the
  timestamps where you matched the tutorial worst, so you know exactly which moments to drill next.
- 🔁 **Smarter segment drilling**: per-segment replay count the user sets (or auto-repeat ~5×), a
  manual "mark segment complete" so it stops resurfacing, then a full run-through "real practice"
  mode with slow-down unlocked after you have learned the whole thing.
- 🔄 **Front and back view**: show the instructor from the front and the back (toggle), so a
  learner can follow whichever orientation matches how they are facing.
- 🎚️ Studio-grade slow-mo via Signalsmith Stretch (WASM).
- 🖥️ Desktop app wrapper (Tauri), accounts, sharing/leaderboards.
