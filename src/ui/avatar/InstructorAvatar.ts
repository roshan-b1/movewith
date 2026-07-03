// Just-Dance-style 3D instructor: a rigged humanoid avatar (VRM) driven per-frame by the
// same 33 BlazePose world landmarks every routine stores — so it works for the bundled demo
// and ANY uploaded song alike. Landmarks are solved to humanoid bone rotations with
// Kalidokit, applied with slerp smoothing (which doubles as interpolation between ~30fps
// pose data and 60fps rendering), and rendered with three.js.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm'
import * as Kalidokit from 'kalidokit'
import { LM, type Landmark } from '../../core/pose/types'
import type { ReferenceFrame } from '../../core/reference/types'

export type AvatarStatus = 'loading' | 'ready' | 'error'

const MODEL_URL = '/models/instructor.vrm'

// Smoothing rates (frame-rate independent): slerp factor = 1 - e^(-K·dt).
// K_ROT ≈ the classic 0.3-per-30fps-frame Kalidokit demo feel; K_POS is much heavier
// damping because hip position is the noisiest signal.
const K_ROT = 12
const K_POS = 3

interface KEuler {
  x: number
  y: number
  z: number
  rotationOrder?: string
}
interface KPoseResult {
  Hips: { position: { x: number; y: number; z: number }; rotation?: KEuler }
  Spine: KEuler
  LeftUpperArm: KEuler
  LeftLowerArm: KEuler
  RightUpperArm: KEuler
  RightLowerArm: KEuler
  LeftHand: KEuler
  RightHand: KEuler
  LeftUpperLeg: KEuler
  LeftLowerLeg: KEuler
  RightUpperLeg: KEuler
  RightLowerLeg: KEuler
}
const solvePose = Kalidokit.Pose.solve as (
  lm3d: unknown,
  lm2d: unknown,
  opts: { runtime: 'mediapipe'; enableLegs: boolean },
) => KPoseResult | undefined

/**
 * Kalidokit needs image-space (0..1) landmarks alongside world ones (it reads them for hip
 * placement and offscreen checks). Uploaded routines store them; the synthetic demo doesn't,
 * so approximate them from world space. The framing is deliberately tight (scale 0.35,
 * centered slightly high): Kalidokit treats landmarks near the frame edges (y > ~0.9) as
 * offscreen and resets those limbs to a rest pose — the feet must stay clear of that.
 */
function synthImageLandmarks(world: Landmark[]): Landmark[] {
  return world.map((l) => ({
    x: 0.5 + l.x * 0.35,
    y: 0.45 + l.y * 0.35,
    z: l.z,
    visibility: l.visibility ?? 1,
  }))
}

export class InstructorAvatar {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private lastMs = performance.now()
  private vrm: VRM | null = null
  private raf = 0
  private disposed = false
  private ro: ResizeObserver
  private canvas: HTMLCanvasElement

  /** Target bone rotations; the render loop slerps toward these every frame. */
  private targets = new Map<VRMHumanBoneName, THREE.Quaternion>()
  private posTarget = new THREE.Vector3()
  private tmpEuler = new THREE.Euler()

  constructor(canvas: HTMLCanvasElement, onStatus: (s: AvatarStatus) => void) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 20)
    this.camera.position.set(0, 0.95, 3.8)
    this.camera.lookAt(0, 0.9, 0)

    // Simple stage: key + fill lights and a floor disc to ground the dancer.
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.85)
    key.position.set(1.5, 2.5, 2.8)
    this.scene.add(key)
    this.scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.4))
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 48),
      new THREE.MeshBasicMaterial({ color: 0x272c42, transparent: true, opacity: 0.9 }),
    )
    floor.rotation.x = -Math.PI / 2
    this.scene.add(floor)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()

    onStatus('loading')
    void this.load()
      .then(() => { if (!this.disposed) onStatus('ready') })
      .catch(() => { if (!this.disposed) onStatus('error') })

    this.raf = requestAnimationFrame(this.tick)
  }

  private async load() {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(MODEL_URL)
    const vrm = gltf.userData.vrm as VRM
    // Official perf passes: fewer draw calls + one combined skeleton.
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.combineMorphs(vrm)
    // VRM0 models face -Z; rotate so the dancer faces the camera like VRM1.
    VRMUtils.rotateVRM0(vrm)
    // Skinned bounds are wrong mid-dance; never cull the dancer's limbs.
    vrm.scene.traverse((o) => { o.frustumCulled = false })
    if (this.disposed) return
    this.scene.add(vrm.scene)
    this.vrm = vrm
  }

  /**
   * Feed the landmark frame at the current playback time (call at data rate, ~30fps).
   * Solves landmarks → bone rotation targets; the render loop smooths toward them.
   */
  setFrame(frame: ReferenceFrame | null) {
    if (!frame || !this.vrm || frame.world.length === 0) return
    // Kalidokit expects MediaPipe-shaped world landmarks: origin at the hip midpoint
    // (its offscreen guards read hip/wrist heights relative to it). Real extractions are
    // already hip-centered; the synthetic demo moves its hips (side-steps, crouches), so
    // re-center here — and keep the raw hip offset to move the dancer on the stage below.
    const lh = frame.world[LM.leftHip]
    const rh = frame.world[LM.rightHip]
    let lm3d: Landmark[] = frame.world
    if (lh && rh) {
      const cx = (lh.x + rh.x) / 2
      const cy = (lh.y + rh.y) / 2
      const cz = ((lh.z ?? 0) + (rh.z ?? 0)) / 2
      lm3d = frame.world.map((l) => ({
        x: l.x - cx,
        y: l.y - cy,
        z: (l.z ?? 0) - cz,
        visibility: l.visibility ?? 1,
      }))
    }
    const lm2d = frame.image ?? synthImageLandmarks(lm3d)
    let pose: KPoseResult | undefined
    try {
      pose = solvePose(lm3d, lm2d, { runtime: 'mediapipe', enableLegs: true })
    } catch {
      return // one bad frame shouldn't kill the dancer
    }
    if (!pose) return

    this.setRot('hips', pose.Hips.rotation, 0.7)
    // Split the solved spine rotation across spine + chest (the classic Kalidokit split).
    this.setRot('spine', pose.Spine, 0.45)
    this.setRot('chest', pose.Spine, 0.25)
    this.setRot('leftUpperArm', pose.LeftUpperArm)
    this.setRot('leftLowerArm', pose.LeftLowerArm)
    this.setRot('rightUpperArm', pose.RightUpperArm)
    this.setRot('rightLowerArm', pose.RightLowerArm)
    this.setRot('leftUpperLeg', pose.LeftUpperLeg)
    this.setRot('leftLowerLeg', pose.LeftLowerLeg)
    this.setRot('rightUpperLeg', pose.RightUpperLeg)
    this.setRot('rightLowerLeg', pose.RightLowerLeg)
    // Hands are skipped: hand landmarks are too coarse in dance footage (and synthetic in
    // the demo), so driving wrists from them adds jitter without adding readability.

    // Body translation (side-steps, squats) from the raw world hip midpoint. World space is
    // hip-centered for real videos (≈0, harmless) but the demo moves its hips — and any
    // motion here reads as the dancer traveling on the stage. World y is down; three.js up.
    if (lh && rh) {
      const hx = (lh.x + rh.x) / 2
      const hy = (lh.y + rh.y) / 2
      if (Number.isFinite(hx) && Number.isFinite(hy)) {
        this.posTarget.set(
          THREE.MathUtils.clamp(hx, -0.6, 0.6),
          THREE.MathUtils.clamp(-hy, -0.45, 0.2),
          0,
        )
      }
    }
  }

  private setRot(bone: VRMHumanBoneName, r: KEuler | undefined, damp = 1) {
    if (!r) return
    const x = r.x * damp
    const y = r.y * damp
    const z = r.z * damp
    if (!Number.isFinite(x + y + z)) return
    let q = this.targets.get(bone)
    if (!q) {
      q = new THREE.Quaternion()
      this.targets.set(bone, q)
    }
    q.setFromEuler(this.tmpEuler.set(x, y, z, 'XYZ'))
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect()
    const w = Math.max(2, Math.round(r.width))
    const h = Math.max(2, Math.round(r.height))
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private tick = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.tick)
    const now = performance.now()
    const delta = Math.min((now - this.lastMs) / 1000, 0.1)
    this.lastMs = now
    const vrm = this.vrm
    if (!vrm) return
    const sRot = 1 - Math.exp(-K_ROT * delta)
    const sPos = 1 - Math.exp(-K_POS * delta)
    for (const [bone, q] of this.targets) {
      // Normalized bones have identity rest rotations, so Kalidokit's VRM-space rotations
      // apply directly on any model.
      vrm.humanoid.getNormalizedBoneNode(bone)?.quaternion.slerp(q, sRot)
    }
    vrm.scene.position.lerp(this.posTarget, sPos)
    vrm.update(delta) // REQUIRED: syncs normalized bones → mesh + spring bones (hair etc.)
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    if (this.vrm) {
      this.scene.remove(this.vrm.scene)
      VRMUtils.deepDispose(this.vrm.scene)
      this.vrm = null
    }
    this.renderer.dispose()
  }
}
