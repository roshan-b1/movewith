// A single shared pose provider for the whole app (extraction + live practice reuse
// the same loaded models). The MediaPipe implementation (and its sizable JS) is loaded
// lazily via dynamic import, so it stays OUT of the initial bundle — the Library screen
// paints without paying for the tracking engine until you actually start a dance.

import type { PoseProvider } from './poseProvider'

let instancePromise: Promise<PoseProvider> | null = null

export function getPoseProvider(): Promise<PoseProvider> {
  if (!instancePromise) {
    instancePromise = import('./mediapipePose').then(
      ({ MediaPipePoseProvider }) => new MediaPipePoseProvider({ delegate: 'GPU' }),
    )
  }
  return instancePromise
}
