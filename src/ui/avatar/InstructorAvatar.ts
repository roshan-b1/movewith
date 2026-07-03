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
import { torsoAnchor, travelBaseline, stageTravel, type TorsoAnchor } from '../../core/pose/travel'
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
  neck: 'mixamorig:Neck',
  head: 'mixamorig:Head',
  leftShoulder: 'mixamorig:LeftShoulder',
  rightShoulder: 'mixamorig:RightShoulder',
  leftUpperArm: 'mixamorig:LeftArm',
  leftLowerArm: 'mixamorig:LeftForeArm',
  rightUpperArm: 'mixamorig:RightArm',
  rightLowerArm: 'mixamorig:RightForeArm',
  leftUpperLeg: 'mixamorig:LeftUpLeg',
  leftLowerLeg: 'mixamorig:LeftLeg',
  rightUpperLeg: 'mixamorig:RightUpLeg',
  rightLowerLeg: 'mixamorig:RightLeg',
  leftFoot: 'mixamorig:LeftFoot',
  rightFoot: 'mixamorig:RightFoot',
  leftHand: 'mixamorig:LeftHand',
  rightHand: 'mixamorig:RightHand',
} as const
type BoneKey = keyof typeof BONE_MAP

// Relaxed finger curl (degrees per segment 1→3). A dancer's hands are soft, not the rig's
// stiff splayed T-pose fingers. Applied once at load; landmark data is too coarse to
// articulate individual fingers live without jitter.
const FINGER_CURL: Record<string, [number, number, number]> = {
  Thumb: [4, 7, 9],
  Index: [10, 18, 14],
  Middle: [13, 21, 16],
  Ring: [15, 23, 17],
  Pinky: [17, 25, 19],
}

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
  /** Outer pivot that carries the stage translation (side-steps, crouch). */
  private root: THREE.Group | null = null
  private bones = new Map<BoneKey, DrivenBone>()
  private raf = 0
  private disposed = false
  private ro: ResizeObserver
  private canvas: HTMLCanvasElement

  private posTarget = new THREE.Vector3()
  private tmpEuler = new THREE.Euler()
  private tmpQuat = new THREE.Quaternion()
  private tmpQuat2 = new THREE.Quaternion()
  private tmpMat = new THREE.Matrix4()
  /** The routine's median torso size/position in image space — see calibrate(). */
  private travelBase: TorsoAnchor | null = null

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
    // Generous bounds: the dancer can travel ±1m laterally and toward/away from camera.
    key.shadow.camera.left = -2.4
    key.shadow.camera.right = 2.4
    key.shadow.camera.top = 2.8
    key.shadow.camera.bottom = -1.6
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 12
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
    // Sized so the dancer stays on the stage across the full travel range (±1m).
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.55, 64),
      new THREE.MeshBasicMaterial({ map: floorTex }),
    )
    floor.rotation.x = -Math.PI / 2
    this.scene.add(floor)
    const shadowCatcher = new THREE.Mesh(
      new THREE.CircleGeometry(1.55, 64),
      new THREE.ShadowMaterial({ opacity: 0.45 }),
    )
    shadowCatcher.rotation.x = -Math.PI / 2
    shadowCatcher.position.y = 0.001
    shadowCatcher.receiveShadow = true
    this.scene.add(shadowCatcher)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.48, 1.55, 96),
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
    // The retarget math needs the captured rest pose to be a clean T-POSE. Some rigs ship
    // with animation clips and a non-T default pose — if the file provides an explicit
    // T-pose clip, pose the skeleton with it before capturing rest quaternions.
    // Prefer an explicit T-pose clip; Mixamo static-pose exports are named "mixamo.com".
    // Some files also ship an EMPTY "T-Pose" stub (0 tracks) — require real tracks, and
    // among matches take the shortest (a static pose clip is a fraction of a second).
    const tPose = (gltf.animations ?? [])
      .filter((c) => c.tracks.length > 0 && /t[- ]?pose|mixamo\.com/i.test(c.name))
      .sort((a, b) => a.duration - b.duration)[0]
    if (tPose) {
      const mixer = new THREE.AnimationMixer(model)
      mixer.clipAction(tPose).play()
      mixer.update(0)
      // Deliberately NOT stopping the action: stopAllAction() would restore the nodes to
      // their pre-clip default pose. The mixer is simply dropped; the T-pose values stay.
    }
    // The whole figure is one MATTE BLACK SILHOUETTE — soft charcoal body, no chrome —
    // with just enough sheen for the colored rim lights to define the edges. The classic
    // dance-silhouette look, in 3D.
    const silhouette = new THREE.MeshPhysicalMaterial({
      color: 0x0c0e14,
      metalness: 0.1,
      roughness: 0.6,
      clearcoat: 0.3,
      clearcoatRoughness: 0.55,
    })
    silhouette.envMapIntensity = 0.35
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

    // Soften the hands: bake a relaxed curl into every finger chain (palms face down in
    // the T-pose, so curling is a world-z rotation — negative for the left hand's +x
    // fingers, positive for the right's). One-time pose; fingers aren't driven live.
    const D2R = Math.PI / 180
    for (const side of ['Left', 'Right'] as const) {
      const sign = side === 'Left' ? -1 : 1
      for (const [finger, curls] of Object.entries(FINGER_CURL)) {
        for (let seg = 1; seg <= 3; seg++) {
          const name = `mixamorig:${side}Hand${finger}${seg}`
          const node = byName.get(name) ?? byName.get(name.replace(':', ''))
          if (!node?.parent) continue
          const rw = node.getWorldQuaternion(new THREE.Quaternion())
          const pw = node.parent.getWorldQuaternion(new THREE.Quaternion())
          this.tmpQuat.setFromEuler(this.tmpEuler.set(0, 0, sign * curls[seg - 1]! * D2R, 'XYZ'))
          node.quaternion.copy(pw.invert().multiply(this.tmpQuat).multiply(rw))
        }
      }
    }

    // NORMALIZE SCALE + POSITION from the SKELETON (bounding boxes lie for skinned meshes:
    // they report bind-pose geometry, not the posed bones). Mixamo exports are often in
    // centimeters and/or offset from the origin — measure head→foot from bone positions,
    // scale to human height, put the hips over the origin and the feet on the floor.
    const headPos = this.bones.get('head')?.node.getWorldPosition(new THREE.Vector3())
    const footPos = this.bones.get('leftFoot')?.node.getWorldPosition(new THREE.Vector3())
    const hipsPos = this.bones.get('hips')!.node.getWorldPosition(new THREE.Vector3())
    if (headPos && footPos) {
      const span = headPos.y - footPos.y
      if (span > 0.01) {
        const s = 1.62 / span // head BONE sits below the crown; ≈1.75m figure overall
        model.scale.setScalar(s)
        model.position.set(-hipsPos.x * s, -(footPos.y - 0.035 * span) * s, -hipsPos.z * s)
      }
    }

    if (this.disposed) return
    const root = new THREE.Group()
    root.add(model)
    this.scene.add(root)
    this.root = root
    this.model = model
  }

  /**
   * Calibrate camera-relative stage travel against the whole routine. World landmarks are
   * hip-centered, so walking toward the camera / across the frame only shows in the
   * IMAGE-SPACE landmarks — travel is measured against the routine's median torso size
   * and position. No-op for routines without image landmarks (the synthetic demo).
   */
  calibrate(frames: ReadonlyArray<{ image?: Landmark[] }>) {
    this.travelBase = travelBaseline(frames)
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

    // WRISTS — z only (the Kalidokit-demo convention: x/y from these landmarks is mostly
    // noise), gated on the hand landmarks being real: index and pinky must be distinct
    // points, which the synthetic demo's stub hands are not. Same side-swap as the arms;
    // Kalidokit's LeftHand comes from the person's right-hand landmarks.
    const handOK = (i: number, p: number) => {
      const a = lm3d[i]
      const b = lm3d[p]
      return !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)) > 0.008
    }
    const wristZ = (e: KEuler): KEuler => ({
      x: 0,
      y: 0,
      z: THREE.MathUtils.clamp(e.z, -0.7, 0.7),
    })
    if (handOK(LM.leftIndex, LM.leftPinky)) this.setRot('leftHand', wristZ(pose.RightHand), 0.6)
    if (handOK(LM.rightIndex, LM.rightPinky)) this.setRot('rightHand', wristZ(pose.LeftHand), 0.6)
    // Hands are skipped: hand landmarks are too coarse in dance footage (and synthetic in
    // the demo), so driving wrists from them adds jitter without adding readability.

    // HEAD + NECK — solved directly from the face landmarks (Kalidokit's Pose solver
    // doesn't cover the head, and head motion is what sells the figure as human).
    // Build the head's world basis from the ear line (lateral) and the eyes-vs-ears
    // offset (forward). Landmark space is x-right / y-down / z-toward-camera-negative;
    // three.js is x-right / y-up / z-toward-camera-positive.
    this.solveHead(lm3d)

    // SHOULDERS — a natural shrug assist: clavicles rise as the arm goes past horizontal.
    // Person's left arm drives the mannequin's left clavicle (true face-on view).
    this.solveShrug('leftShoulder', lm3d[LM.leftShoulder], lm3d[LM.leftElbow], 1)
    this.solveShrug('rightShoulder', lm3d[LM.rightShoulder], lm3d[LM.rightElbow], -1)

    // Body translation on the stage, from two complementary signals:
    // • world hip midpoint — side-steps and crouches for the synthetic demo (real videos
    //   are hip-centered, ≈0). World y is down; three.js up.
    // • image-space travel — real videos ONLY: the instructor walking toward/away from
    //   the camera (apparent torso size) and across the frame (hip midpoint), measured
    //   against the routine's calibrated median. See calibrate() / core/pose/travel.ts.
    if (lh && rh) {
      const hx = (lh.x + rh.x) / 2
      const hy = (lh.y + rh.y) / 2
      if (Number.isFinite(hx) && Number.isFinite(hy)) {
        let tx = 0
        let tz = 0
        if (this.travelBase) {
          const anchor = torsoAnchor(frame.image)
          if (anchor) {
            const t = stageTravel(anchor, this.travelBase)
            tx = t.x
            tz = t.z
          }
        }
        this.posTarget.set(
          THREE.MathUtils.clamp(hx, -0.6, 0.6) + tx,
          THREE.MathUtils.clamp(-hy, -0.45, 0.2),
          tz,
        )
      }
    }
  }

  /** Head/neck orientation from ears + eyes, split neck 35% / head 65%. */
  private solveHead(lm: Landmark[]) {
    const le = lm[LM.leftEar]
    const re = lm[LM.rightEar]
    const ley = lm[LM.leftEye]
    const rey = lm[LM.rightEye]
    if (!le || !re || !ley || !rey) return
    // Lateral axis: right ear → left ear (person's left = +x when facing the camera).
    const R = new THREE.Vector3(le.x - re.x, -(le.y - re.y), -((le.z ?? 0) - (re.z ?? 0)))
    // Forward axis: ear midpoint → eye midpoint (eyes sit in front of ears, at ear height).
    const F = new THREE.Vector3(
      (ley.x + rey.x - le.x - re.x) / 2,
      -(ley.y + rey.y - le.y - re.y) / 2,
      -((ley.z ?? 0) + (rey.z ?? 0) - (le.z ?? 0) - (re.z ?? 0)) / 2,
    )
    if (R.lengthSq() < 1e-6 || F.lengthSq() < 1e-6) return
    R.normalize()
    F.normalize()
    // Guard: only drive the head while it faces roughly forward — degenerate/rear-facing
    // face landmarks (occlusions, spins) would otherwise whip the head around.
    if (F.z < 0.15) return
    const U = new THREE.Vector3().crossVectors(F, R)
    if (U.lengthSq() < 1e-6 || U.y < 0.2) return
    U.normalize()
    const R2 = new THREE.Vector3().crossVectors(U, F).normalize()
    this.tmpMat.makeBasis(R2, U, F)
    this.tmpQuat.setFromRotationMatrix(this.tmpMat)
    if (!Number.isFinite(this.tmpQuat.x + this.tmpQuat.w)) return
    // Distribute the rotation: a real head turn is shared between neck and head.
    this.setRotQuat('neck', this.tmpQuat, 0.35)
    this.setRotQuat('head', this.tmpQuat, 0.65)
  }

  /** Clavicle rise once the upper arm passes horizontal — reads as a natural shrug. */
  private solveShrug(key: BoneKey, shoulder: Landmark | undefined, elbow: Landmark | undefined, sign: 1 | -1) {
    if (!shoulder || !elbow) return
    const vx = elbow.x - shoulder.x
    const vy = elbow.y - shoulder.y // y down
    const len = Math.hypot(vx, vy)
    if (len < 1e-4) return
    // 0 = arm straight down, 180 = straight up.
    const elev = (Math.acos(THREE.MathUtils.clamp(vy / len, -1, 1)) * 180) / Math.PI
    const amt = THREE.MathUtils.clamp((elev - 100) / 80, 0, 1) * (12 * Math.PI / 180)
    // +z about world rotates the +x (left) side up; mirror for the right clavicle.
    this.tmpQuat.setFromEuler(this.tmpEuler.set(0, 0, sign * amt, 'XYZ'))
    this.setRotQuat(key, this.tmpQuat, 1)
  }

  /** Apply a world-aligned rotation (optionally scaled toward identity) to a bone target. */
  private setRotQuat(key: BoneKey, q: THREE.Quaternion, weight: number) {
    const bone = this.bones.get(key)
    if (!bone) return
    this.tmpQuat2.identity().slerp(q, weight)
    bone.target
      .copy(bone.parentRestWorld)
      .invert()
      .multiply(this.tmpQuat2)
      .multiply(bone.restWorld)
    bone.hasTarget = true
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
    this.root?.position.lerp(this.posTarget, sPos)
    // FOOT PLANTING: after the legs settle, keep each foot level and pointing forward
    // (its rest world orientation) instead of inheriting the shin's tilt — feet stay flat
    // on the stage the way a real dancer's do, rather than dangling like a puppet's.
    for (const key of ['leftFoot', 'rightFoot'] as const) {
      const foot = this.bones.get(key)
      if (!foot?.node.parent) continue
      foot.node.parent.getWorldQuaternion(this.tmpQuat)
      this.tmpQuat2.copy(this.tmpQuat).invert().multiply(foot.restWorld)
      foot.node.quaternion.slerp(this.tmpQuat2, 0.85)
    }
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    if (this.model) {
      if (this.root) this.scene.remove(this.root)
      this.model.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
        mesh.geometry?.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mats.forEach((m) => m?.dispose())
      })
      this.model = null
      this.root = null
    }
    this.renderer.dispose()
  }
}
