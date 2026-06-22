// Thin wrapper around getUserMedia for the webcam. Front camera, no audio
// (we never record you — frames are analysed in-memory and discarded).

export interface CameraHandle {
  stream: MediaStream
  /** The deviceId actually in use, if the browser reports it. */
  deviceId: string | null
  stop: () => void
}

/** Start the webcam. Pass a deviceId to target a specific camera. */
export async function startCamera(video: HTMLVideoElement, deviceId?: string): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support camera access.')
  }
  const videoConstraints: MediaTrackConstraints = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints })
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  await video.play()

  const track = stream.getVideoTracks()[0]
  const activeId = track?.getSettings().deviceId ?? null
  return {
    stream,
    deviceId: activeId,
    stop: () => {
      for (const t of stream.getTracks()) t.stop()
      video.srcObject = null
    },
  }
}

/** List available video input devices. Labels are only populated after permission. */
export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'videoinput')
}

/** Virtual cameras (OBS, etc.) show placeholder images, not you — deprioritize them. */
export function isVirtualCamera(label: string): boolean {
  return /\b(obs|virtual|droidcam|snap camera|manycam|xsplit|ndi)\b/i.test(label)
}

/**
 * Choose the best real camera to default to: prefer a non-virtual device. Returns the
 * deviceId to use, or null to let the browser decide.
 */
export function preferredCameraId(devices: MediaDeviceInfo[], currentId: string | null): string | null {
  const real = devices.filter((d) => d.deviceId && !isVirtualCamera(d.label))
  // If the current camera is virtual and a real one exists, switch to the real one.
  const current = devices.find((d) => d.deviceId === currentId)
  if (current && isVirtualCamera(current.label) && real.length > 0) return real[0]!.deviceId
  return null
}
