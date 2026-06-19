// Thin wrapper around getUserMedia for the webcam. Front camera, no audio
// (we never record you — frames are analysed in-memory and discarded).

export interface CameraHandle {
  stream: MediaStream
  stop: () => void
}

export async function startCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support camera access.')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  })
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  await video.play()
  return {
    stream,
    stop: () => {
      for (const track of stream.getTracks()) track.stop()
      video.srcObject = null
    },
  }
}
