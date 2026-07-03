// Just-Dance-style 3D dancer: a featureless male mannequin (Mixamo X Bot) driven per-frame
// by the same 33 BlazePose world landmarks every routine stores — so it performs the bundled
// demo and ANY uploaded song alike. Landmarks are solved to humanoid rotations with
// Kalidokit (VRM-normalized space: identity rest pose, world-aligned axes), retargeted onto
// the mannequin's Mixamo skeleton via rest-pose quaternions, applied with slerp smoothing
// (which doubles as interpolation between ~30fps pose data and 60fps rendering), and
// rendered with three.js on a lit stage with real shadows.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import * as Kalidokit from 'kalidokit'
import { LM, type Landmark } from '../../core/pose/types'
import type { ReferenceFrame } from '../../core/reference/types'

export type AvatarStatus = 'loading' | 'ready' | 'error'

const MODEL_URL = '/models/instructor.glb'

// Smoothing rates (frame-rate independent): slerp factor = 1 - e^(-K·dt).
// K_ROT ≈ the classic 0.3-per-30fps-frame Kalidokit demo feel; K_POS is much heavier
// damping because hip position is the noisiest signal.
const K_ROT = 12
const K_POS = 3

/** The humanoid parts we drive → the mannequin's Mixamo bone names. */
const BONE_MAP = {
  hips: 'mixamorig:Hips',
  spine: 'mixamorig:Spine',
  chest: 'mixamorig:Spine1',
  leftUpperArm: 'mixamorig:LeftArm',
  leftLowerArm: 'mixamorig:LeftForeArm',
  rightUpperArm: 'mixamorig:RightArm',
  rightLowerArm: 'mixamorig:RightForeArm',
  leftUpperLeg: 'mixamorig:LeftUpLeg',
  leftLowerLeg: 'mixamorig:LeftLeg',
  rightUpperLeg: 'mixamorig:RightUpLeg',
  rightLowerLeg: 'mixamorig:RightLeg',
} as const
type BoneKey = keyof typeof BONE_MAP

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

/** A driven bone: the scene node plus its (and its parent's) rest-pose world rotation. */
interface DrivenBone {
  node: THREE.Object3D
  restWorld: THREE.Quaternion
  parentRestWorld: THREE.Quaternion
  /** Slerp target, in the bone's LOCAL space (already retargeted). */
  target: THREE.Quaternion
  hasTarget: boolean
}

export class InstructorAvatar {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private lastMs = performance.now()
  private model: THREE.Object3D | null = null
  private bones = new Map<BoneKey, DrivenBone>()
  private raf = 0
  private disposed = false
  private ro: ResizeObserver
  private canvas: HTMLCanvasElement

  private posTarget = new THREE.Vector3()
  private tmpEuler = new THREE.Euler()
  private tmpQuat = new THREE.Quaternion()

  constructor(canvas: HTMLCanvasElement, onStatus: (s: AvatarStatus) => void) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping

    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 20)
    this.camera.position.set(0, 1.05, 4.4)
    this.camera.lookAt(0, 0.95, 0)

    // Studio environment so the mannequin's shell picks up believable reflections.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()

    // Concert-style lighting: a white key from the front-top (casts the ground shadow)
    // and two colored rims from behind — brand pink and cyan — that catch the dancer's
    // edges, the classic "dance silhouette" look.
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(0.8, 3.2, 3.0)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.left = -1.6
    key.shadow.camera.right = 1.6
    key.shadow.camera.top = 2.4
    key.shadow.camera.bottom = -0.4
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 10
    key.shadow.bias = -0.0004
    this.scene.add(key)
    const rimPink = new THREE.DirectionalLight(0xff2e88, 4.5)
    rimPink.position.set(-2.4, 1.6, -2.0)
    this.scene.add(rimPink)
    const rimCyan = new THREE.DirectionalLight(0x22d3ee, 4.5)
    rimCyan.position.set(2.4, 1.8, -1.8)
    this.scene.add(rimCyan)
    this.scene.add(new THREE.AmbientLight(0x8890b8, 0.35))

    // Stage floor. Lit PBR floors wash out here — the studio environment map reflects
    // across the disc at grazing angles no matter the albedo — so the disc is UNLIT with
    // a baked radial gradient (exact colors, every time), and a separate transparent
    // ShadowMaterial catcher above it receives the dancer's soft shadow.
    const grad = document.createElement('canvas')
    grad.width = grad.height = 256
    const g = grad.getContext('2d')!
    const radial = g.createRadialGradient(128, 128, 8, 128, 128, 128)
    radial.addColorStop(0, '#232841')
    radial.addColorStop(0.65, '#121524')
    radial.addColorStop(1, '#0a0c16')
    g.fillStyle = radial
    g.fillRect(0, 0, 256, 256)
    const floorTex = new THREE.CanvasTexture(grad)
    floorTex.colorSpace = THREE.SRGBColorSpace
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.25, 64),
      new THREE.MeshBasicMaterial({ map: floorTex }),
    )
    floor.rotation.x = -Math.PI / 2
    this.scene.add(floor)
    const shadowCatcher = new THREE.Mesh(
      new THREE.CircleGeometry(1.25, 64),
      new THREE.ShadowMaterial({ opacity: 0.45 }),
    )
    shadowCatcher.rotation.x = -Math.PI / 2
    shadowCatcher.position.y = 0.001
    shadowCatcher.receiveShadow = true
    this.scene.add(shadowCatcher)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.19, 1.25, 96),
      new THREE.MeshBasicMaterial({
        color: 0xff2e88,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.002
    this.scene.add(ring)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()

    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__mwAvatar = this

    onStatus('loading')
    void this.load()
      .then(() => { if (!this.disposed) onStatus('ready') })
      .catch(() => { if (!this.disposed) onStatus('error') })

    this.raf = requestAnimationFrame(this.tick)
  }

  private async load() {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL)
    const model = gltf.scene
    // The whole figure is one sleek OBSIDIAN SILHOUETTE: glossy near-black everywhere,
    // outlined by the colored rim lights — the classic dance-silhouette look.
    const silhouette = new THREE.MeshPhysicalMaterial({
      color: 0x0d0f1a,
      metalness: 0.75,
      roughness: 0.35,
      clearcoat: 0.7,
      clearcoatRoughness: 0.22,
    })
    model.traverse((o) => {
      // Skinned bounds are wrong mid-dance; never cull the dancer's limbs.
      o.frustumCulled = false
      const mesh = o as THREE.Mesh
      if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
        mesh.castShadow = true
        mesh.material = silhouette
      }
    })

    // Capture each driven bone with its REST-pose world rotation (the model loads in a
    // T-pose). Kalidokit's rotations live in VRM-normalized space — identity rest pose with
    // world-aligned axes — so a Mixamo local target is R_parentRest⁻¹ · q_kalidokit · R_boneRest.
    model.updateWorldMatrix(true, true)
    const byName = new Map<string, THREE.Object3D>()
    model.traverse((o) => byName.set(o.name, o))
    for (const [key, mixamoName] of Object.entries(BONE_MAP) as [BoneKey, string][]) {
      // Bone names sometimes lose the "mixamorig:" colon in exports — try both.
      const node = byName.get(mixamoName) ?? byName.get(mixamoName.replace(':', ''))
      if (!node) continue
      const restWorld = node.getWorldQuaternion(new THREE.Quaternion())
      const parentRestWorld = node.parent
        ? node.parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion()
      this.bones.set(key, { node, restWorld, parentRestWorld, target: new THREE.Quaternion(), hasTarget: false })
    }
    if (!this.bones.has('hips')) throw new Error('mannequin rig not found')

    if (this.disposed) return
    this.scene.add(model)
    this.model = model
  }

  /**
   * Feed the landmark frame at the current playback time (call at data rate, ~30fps).
   * Solves landmarks → bone rotation targets; the render loop smooths toward them.
   */
  setFrame(frame: ReferenceFrame | null) {
    if (!frame || !this.model || frame.world.length === 0) return
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

    // Kalidokit is built for MIRRORED webcam views: its "Left*" outputs are computed from
    // the person's RIGHT landmarks (see calcArms: UpperArm.l ← lm[12]) with side-specific
    // sign handling baked in. The instructor here is shown face-on (unmirrored, matching
    // the video/2D paths — the Mirror button flips the canvas), so paired limbs SWAP SIDES
    // on application, and the central bones un-mirror by negating y/z. Verified empirically
    // against known choreography (rest / arms-up / one-arm) — see the calibration in git
    // history before changing any of this.
    const unmirror = (e: KEuler | undefined): KEuler | undefined =>
      e ? { x: e.x, y: -e.y, z: -e.z } : undefined
    this.setRot('hips', unmirror(pose.Hips.rotation), 0.7)
    // Split the solved spine rotation across spine + chest (the classic Kalidokit split).
    this.setRot('spine', unmirror(pose.Spine), 0.45)
    this.setRot('chest', unmirror(pose.Spine), 0.25)
    this.setRot('leftUpperArm', pose.RightUpperArm)
    this.setRot('leftLowerArm', pose.RightLowerArm)
    this.setRot('rightUpperArm', pose.LeftUpperArm)
    this.setRot('rightLowerArm', pose.LeftLowerArm)
    this.setRot('leftUpperLeg', pose.RightUpperLeg)
    this.setRot('leftLowerLeg', pose.RightLowerLeg)
    this.setRot('rightUpperLeg', pose.LeftUpperLeg)
    this.setRot('rightLowerLeg', pose.LeftLowerLeg)
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

  private setRot(key: BoneKey, r: KEuler | undefined, damp = 1) {
    if (!r) return
    const bone = this.bones.get(key)
    if (!bone) return
    const x = r.x * damp
    const y = r.y * damp
    const z = r.z * damp
    if (!Number.isFinite(x + y + z)) return
    // Kalidokit rotation (VRM-normalized space) → this bone's local space.
    this.tmpQuat.setFromEuler(this.tmpEuler.set(x, y, z, 'XYZ'))
    bone.target
      .copy(bone.parentRestWorld)
      .invert()
      .multiply(this.tmpQuat)
      .multiply(bone.restWorld)
    bone.hasTarget = true
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
    const model = this.model
    if (!model) return
    const sRot = 1 - Math.exp(-K_ROT * delta)
    const sPos = 1 - Math.exp(-K_POS * delta)
    for (const bone of this.bones.values()) {
      if (bone.hasTarget) bone.node.quaternion.slerp(bone.target, sRot)
    }
    model.position.lerp(this.posTarget, sPos)
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    if (this.model) {
      this.scene.remove(this.model)
      this.model.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
        mesh.geometry?.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mats.forEach((m) => m?.dispose())
      })
      this.model = null
    }
    this.renderer.dispose()
  }
}
