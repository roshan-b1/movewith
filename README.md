# MoveWith 🕺

An AI dance tutorial that **moves with you**. Load (or upload) a routine, and MoveWith
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

On first open it generates a bundled **demo routine** (a synthetic instructor) so you can
try the whole flow with zero setup. Use the upload box to learn your own tutorial videos.

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
- 🎚️ Studio-grade slow-mo via Signalsmith Stretch (WASM).
- 🖥️ Desktop app wrapper (Tauri), accounts, sharing/leaderboards.
