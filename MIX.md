# Mixes (medley mode)

Stitch parts of several dances into one routine and practice it. Built for medleys and
performances that jump between songs — and for the common case where the dance you want to
learn has **no tutorial**, just a raw clip you'd otherwise rewind to death.

A mix references parts of dances you've already uploaded. It stores **no video of its own**:
each clip points at a slice of a source track's stored video. Deleting a mix never touches
the source dances; deleting a source dance leaves its blob referenced only by that dance.

## The flow

1. **Library → "Make a mix"** (`openMixEditor()`), shown once you have at least one uploaded
   dance with a video.
2. **Editor** (`ui/screens/MixEditor.tsx`) — DaVinci-style, cut then arrange on one screen:
   - **Cut a dance into parts.** Pick any uploaded dance (switch freely). Trim the range with
     the `Scrubber`, then cut it into blocks exactly like the practice segment-creator: play it
     and tap **✂ Cut here** at each move (0.5 / 0.75 / 1× speed), or **↻ Auto-detect**
     (`autoMoveBounds`); **↺ Clear** starts over; drag a cut divider to nudge a boundary; tap a
     block to preview-loop it. Each source keeps its own cut state when you switch away and back.
   - **Drag a block straight down onto the mix timeline.** The cut blocks and the mix blocks are
     the SAME object — no button. A tap previews; a drag drops it in. Repeat with any dance.
   - **The mix timeline.** Every part is a block on a fixed time scale (`PPS` px/second, so width
     = duration). Drag a block's middle to reorder (or ‹ › nudges); drag either end to trim its
     in/out, clamped to the source's real length; ✕ removes it. **▶ Preview** plays the whole
     medley across sources.
   - Name it and **Save** → into practicing it.
3. **Practice** (`ui/screens/MixPractice.tsx`): the parts are the segments. Drill one on a
   loop (speed 0.5/0.75/1×, mirror), tap **✓ Got it** to advance, and once every part is got,
   a nudge sends you into the **full run-through**. No camera or scoring on a mix.

## Modules

| File | Responsibility |
| --- | --- |
| `core/mix/timeline.ts` | Pure model + math: `Mix`, `MixClip`, durations, `clipOffsets`, `mapMixTime` (global mix-time → source clip + time), and immutable `insertClip`/`moveClip`/`removeClip`. Fully unit-tested (`timeline.test.ts`). |
| `engine/mixPlayback.ts` | `MixPlaybackController`: drives ONE `<video>`, swapping its `src` at each clip boundary and seeking to the clip's in-point. Exposes one continuous mix-time via `onTick`, plus `play`/`pause`/`seek`/`seekToClip`/`setLoopClip`/`setRate`/`setMirror`. |
| `storage/db.ts` | DB **v2**: a `mixes` object store (migration just adds the store; v1 data is untouched), with `saveMix`/`getMix`/`listMixes`/`deleteMix`. |
| `state/sessionStore.ts` | `mixes` list, `activeMix`, `sourceUrls` (source-video object URLs, cached on demand and revoked on `back()`), and actions `openMixEditor`/`openMix`/`ensureSourceUrl`/`saveMix`/`removeMix`. Screens `mixEditor` / `mixPractice`. |

## Playback across sources

The one real subtlety: a mix spans several video files, so `MixPlaybackController` keeps a
single `<video>` and swaps `src` + seeks at each clip's out-point (`ensureLoaded` waits for
`loadedmetadata`, with a timeout so a decode stall can't hang the controller). Two modes:
whole-mix play (roll clip to clip, park on the final frame) and single-clip loop (snap back
to the clip's in-point) for drilling a part. All time mapping is delegated to the pure
`core/mix/timeline.ts`, which is where the correctness lives and is tested.

Mirror in practice is a canvas flip (a CSS transform on the `<video>` tears on some
browsers), matching how the main practice screen mirrors.

## Not done yet

Camera scoring on mixes; sub-segmenting a part into finer drill chunks; audio crossfades at
the seams. See `NEXT_STEPS.md`.
