// Just-Dance-style 3D dancer: a featureless male mannequin (Mixamo Y Bot) driven per-frame
// by the same 33 BlazePose world landmarks every routine stores — so it performs the bundled
// routines and ANY uploaded song alike.
//
// The pose solver is DIRECTION-EXACT: every limb bone is aligned to the actual landmark
// bone vector (shoulder→elbow, elbow→wrist, hip→knee, knee→ankle), the hips/torso follow
// a full orientation basis built from the hip and shoulder lines (works through full-body
// turns), and the head follows the face landmarks. This places hands and feet exactly
// where the data says — including folds behind the body that heuristic solvers clamp
// away. Targets are applied with slerp smoothing, which doubles as
// interpolation between ~30fps pose data and 60fps rendering.
//
// Landmark space: x = person's left, y = down, z = toward camera NEGATIVE (hip-centered).
// three.js world: x = viewer's right, y = up, z = toward camera POSITIVE. The map is
// (x, -y, -z); the mannequin faces +z, so the person's left hand appears on the viewer's
// right — exactly like watching a dancer face you.

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { LM, type Landmark } from '../../core/pose/types'
import { torsoAnchor, travelBaseline, stageTravel, type TorsoAnchor } from '../../core/pose/travel'
import type { ReferenceFrame } from '../../core/reference/types'

export type AvatarStatus = 'loading' | 'ready' | 'error'

const MODEL_URL = '/models/instructor.glb'

// Smoothing rates (frame-rate independent): slerp factor = 1 - e^(-K·dt).
// K_ROT is deliberately fast (~0.2s settle) so dance hits land crisp — heavier smoothing
// blurs one move into the next at real song tempos.
const K_ROT = 20
const K_POS = 4

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
} as const
type BoneKey = keyof typeof BONE_MAP

/** Limb segments driven by direction alignment, hierarchical order (parents first).
 *  Person's left drives the mannequin's left (true view — see the header note). */
const LIMB_SEGMENTS: Array<{ key: BoneKey; from: number; to: number }> = [
  { key: 'leftUpperArm', from: LM.leftShoulder, to: LM.leftElbow },
  { key: 'leftLowerArm', from: LM.leftElbow, to: LM.leftWrist },
  { key: 'rightUpperArm', from: LM.rightShoulder, to: LM.rightElbow },
  { key: 'rightLowerArm', from: LM.rightElbow, to: LM.rightWrist },
  { key: 'leftUpperLeg', from: LM.leftHip, to: LM.leftKnee },
  { key: 'leftLowerLeg', from: LM.leftKnee, to: LM.leftAnkle },
  { key: 'rightUpperLeg', from: LM.rightHip, to: LM.rightKnee },
  { key: 'rightLowerLeg', from: LM.rightKnee, to: LM.rightAnkle },
]

// Relaxed finger curl (degrees per segment 1→3) baked at load — a dancer's hands are
// soft, not the rig's stiff splayed T-pose fingers. Pose landmarks are too coarse to
// articulate fingers live without jitter.
const FINGER_CURL: Record<string, [number, number, number]> = {
  Thumb: [4, 7, 9],
  Index: [10, 18, 14],
  Middle: [13, 21, 16],
  Ring: [15, 23, 17],
  Pinky: [17, 25, 19],
}

interface DrivenBone {
  node: THREE.Object3D
  restWorld: THREE.Quaternion
  parentRestWorld: THREE.Quaternion
  /** Slerp target in the bone's local space (world-aligned bones: hips/spine/head/...). */
  target: THREE.Quaternion
  hasTarget: boolean
  /** For limb segments: the bone's rest direction and the current target direction. */
  restDir?: THREE.Vector3
  dirTarget?: THREE.Vector3
  hasDir?: boolean
}

/** Landmark → three.js world direction/point. */
function lmToWorld(l: Landmark, out: THREE.Vector3): THREE.Vector3 {
  return out.set(l.x, -l.y, -(l.z ?? 0))
}

export class InstructorAvatar {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private lastMs = performance.now()
  private model: THREE.Object3D | null = null
  /** Outer pivot that carries the stage translation (side-steps, crouch, travel). */
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
  private tmpQuat3 = new THREE.Quaternion()
  private tmpMat = new THREE.Matrix4()
  private tmpVec = new THREE.Vector3()
  private tmpVec2 = new THREE.Vector3()
  private tmpVec3 = new THREE.Vector3()
  private tmpVec4 = new THREE.Vector3()
  /** Current body orientation (world deviation from rest) — reused by head/shrug. */
  private hipsQuat = new THREE.Quaternion()
  /** Foot-bone height when standing flat — the "soles on the floor" reference. */
  private restFootY = 0.06
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

    // Studio environment so the mannequin picks up believable reflections.
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

    // Stage floor: a dark radial-gradient disc (unlit, so it stays deep) with a separate
    // shadow-catcher on top for the dancer's soft shadow, edged with a glowing ring.
    // Sized for the full travel range.
    const floorCanvas = document.createElement('canvas')
    floorCanvas.width = floorCanvas.height = 256
    const fctx = floorCanvas.getContext('2d')!
    const grad = fctx.createRadialGradient(128, 128, 8, 128, 128, 128)
    grad.addColorStop(0, '#262b45')
    grad.addColorStop(0.55, '#141830')
    grad.addColorStop(1, '#0a0c16')
    fctx.fillStyle = grad
    fctx.fillRect(0, 0, 256, 256)
    const floorTex = new THREE.CanvasTexture(floorCanvas)
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
    // with animation clips and a non-T default pose — prefer an explicit T-pose clip;
    // Mixamo static-pose exports are named "mixamo.com". Some files also ship an EMPTY
    // "T-Pose" stub (0 tracks) — require real tracks, take the shortest match.
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

    // JUST-DANCE-STYLE SILHOUETTE: one flat, unlit color over the whole figure — no
    // shading at all, so the rig's segmented "robot" surface detail disappears into a
    // single clean dancer shape — plus a glowing fresnel edge that outlines him against
    // the stage, like the game's coaches. (Emissive-only: the black diffuse ignores the
    // scene lights; they only exist for the ground shadow.)
    const silhouette = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xb01fd6,
      emissiveIntensity: 0.9,
      roughness: 1,
      metalness: 0,
    })
    silhouette.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Fresnel edge glow: brighter toward grazing angles = a glowing outline.
        float fres = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 2.2);
        totalEmissiveRadiance += vec3(1.0, 0.45, 0.95) * fres * 1.4;`,
      )
    }
    model.traverse((o) => {
      // Skinned bounds are wrong mid-dance; never cull the dancer's limbs.
      o.frustumCulled = false
      const mesh = o as THREE.Mesh
      if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
        mesh.castShadow = true
        mesh.material = silhouette
      }
    })

    // Capture each driven bone with its (and its parent's) REST-pose world rotation.
    // World-aligned solver rotations map to a bone's local space via
    // R_parentRest⁻¹ · q · R_boneRest.
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

    // Limb segments additionally need their rest DIRECTION (bone joint → child joint).
    const childOf: Partial<Record<BoneKey, BoneKey | 'handL' | 'handR'>> = {
      leftUpperArm: 'leftLowerArm',
      rightUpperArm: 'rightLowerArm',
      leftUpperLeg: 'leftLowerLeg',
      rightUpperLeg: 'rightLowerLeg',
      leftLowerLeg: 'leftFoot',
      rightLowerLeg: 'rightFoot',
    }
    const jointPos = (name: string) => {
      const node = byName.get(name) ?? byName.get(name.replace(':', ''))
      return node?.getWorldPosition(new THREE.Vector3()) ?? null
    }
    for (const seg of LIMB_SEGMENTS) {
      const bone = this.bones.get(seg.key)
      if (!bone) continue
      const childKey = childOf[seg.key]
      const childPos = childKey
        ? this.bones.get(childKey as BoneKey)?.node.getWorldPosition(new THREE.Vector3()) ?? null
        : // Lower arms end at the hand bone (not in BONE_MAP — fingers are static).
          jointPos(seg.key === 'leftLowerArm' ? 'mixamorig:LeftHand' : 'mixamorig:RightHand')
      const selfPos = bone.node.getWorldPosition(new THREE.Vector3())
      if (!childPos) continue
      const dir = childPos.sub(selfPos)
      if (dir.lengthSq() < 1e-8) continue
      bone.restDir = dir.normalize()
      bone.dirTarget = bone.restDir.clone()
      bone.hasDir = false
    }

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

    // The flat-standing foot height — the ground clamp in tick() keeps feet at or above
    // this, so crouches and steps can never push the dancer through the stage.
    model.updateWorldMatrix(true, true)
    const lfY = this.bones.get('leftFoot')?.node.getWorldPosition(this.tmpVec).y
    const rfY = this.bones.get('rightFoot')?.node.getWorldPosition(this.tmpVec2).y
    if (lfY !== undefined && rfY !== undefined) this.restFootY = Math.min(lfY, rfY)

    // FRONT MARKER: glowing cyan visor "eyes" across the face — the silhouette is
    // otherwise front/back ambiguous at a glance.
    const head = this.bones.get('head')?.node
    if (head) {
      const ws = head.getWorldScale(this.tmpVec).x || 1
      const visor = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.02 / ws, 0.1 / ws, 4, 12),
        new THREE.MeshStandardMaterial({
          color: 0x061014,
          emissive: 0x22d3ee,
          emissiveIntensity: 1.8,
          roughness: 0.35,
        }),
      )
      visor.frustumCulled = false
      head.add(visor)
      const headWorldQuat = head.getWorldQuaternion(this.tmpQuat)
      const target = head.getWorldPosition(this.tmpVec).add(this.tmpVec2.set(0, 0.075, 0.1))
      visor.position.copy(head.worldToLocal(target))
      visor.quaternion
        .copy(headWorldQuat)
        .invert()
        .multiply(this.tmpQuat2.setFromEuler(this.tmpEuler.set(0, 0, Math.PI / 2, 'XYZ')))
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
   * and position. No-op for routines without image landmarks (the bundled ones).
   */
  calibrate(frames: ReadonlyArray<{ image?: Landmark[] }>) {
    this.travelBase = travelBaseline(frames)
  }

  /**
   * Feed the landmark frame at the current playback time (call at data rate, ~30fps).
   * Solves landmarks → bone targets; the render loop smooths toward them.
   */
  setFrame(frame: ReferenceFrame | null) {
    if (!frame || !this.model || frame.world.length === 0) return
    // Hip-center the world landmarks (real extractions already are; the bundled routines
    // move their hips) and keep the raw hip offset for stage translation below.
    const lhRaw = frame.world[LM.leftHip]
    const rhRaw = frame.world[LM.rightHip]
    let lm: Landmark[] = frame.world
    if (lhRaw && rhRaw) {
      const cx = (lhRaw.x + rhRaw.x) / 2
      const cy = (lhRaw.y + rhRaw.y) / 2
      const cz = ((lhRaw.z ?? 0) + (rhRaw.z ?? 0)) / 2
      lm = frame.world.map((l) => ({
        x: l.x - cx,
        y: l.y - cy,
        z: (l.z ?? 0) - cz,
        visibility: l.visibility ?? 1,
      }))
    }

    const vis = (i: number) => lm[i]?.visibility ?? 0

    // ---- HIPS + TORSO: full orientation basis from the hip and shoulder lines ----
    const lh = lm[LM.leftHip]
    const rh = lm[LM.rightHip]
    const ls = lm[LM.leftShoulder]
    const rs = lm[LM.rightShoulder]
    if (lh && rh && ls && rs) {
      // Hip line (person's right→left) in world space, and torso-up.
      const H = lmToWorld(lh, this.tmpVec).sub(lmToWorld(rh, this.tmpVec2))
      const U = lmToWorld(ls, this.tmpVec3)
        .add(lmToWorld(rs, this.tmpVec4))
        .multiplyScalar(0.5) // shoulders midpoint; hips midpoint is the origin (centered)
      if (H.lengthSq() > 1e-6 && U.lengthSq() > 1e-6) {
        H.normalize()
        U.normalize()
        const F = this.tmpVec2.crossVectors(H, U) // forward = right→left × up (faces +z at rest)
        if (F.lengthSq() > 1e-6) {
          F.normalize()
          const U2 = this.tmpVec4.crossVectors(F, H).normalize()
          this.tmpMat.makeBasis(H, U2, F)
          this.hipsQuat.setFromRotationMatrix(this.tmpMat)
          if (Number.isFinite(this.hipsQuat.x + this.hipsQuat.w)) {
            this.setRotQuat('hips', this.hipsQuat, 1)

            // Torso twist/tilt: the shoulder line expressed in the hips frame gives how
            // far the upper body yaws/rolls relative to the pelvis; spread it up the spine.
            const S = lmToWorld(ls, this.tmpVec).sub(lmToWorld(rs, this.tmpVec3))
            if (S.lengthSq() > 1e-6) {
              S.normalize().applyQuaternion(this.tmpQuat.copy(this.hipsQuat).invert())
              const yawT = Math.atan2(-S.z, S.x)
              const rollT = Math.atan2(S.y, S.x)
              const bend = (w: number) =>
                this.tmpQuat2
                  .copy(this.hipsQuat)
                  .multiply(this.tmpQuat3.setFromEuler(this.tmpEuler.set(0, yawT * w, rollT * w, 'YZX')))
              this.setRotQuat('spine', bend(0.35), 1)
              this.setRotQuat('chest', bend(0.75), 1)
            }
          }
        }
      }
    }

    // ---- LIMBS: direction-exact bone alignment (applied hierarchically in tick) ----
    for (const seg of LIMB_SEGMENTS) {
      const bone = this.bones.get(seg.key)
      if (!bone?.restDir || !bone.dirTarget) continue
      const a = lm[seg.from]
      const b = lm[seg.to]
      if (!a || !b || vis(seg.from) < 0.35 || vis(seg.to) < 0.35) {
        // Not confidently visible: relax toward the rest direction.
        bone.dirTarget.copy(bone.restDir)
        bone.hasDir = true
        continue
      }
      const dir = lmToWorld(b, this.tmpVec).sub(lmToWorld(a, this.tmpVec2))
      if (dir.lengthSq() < 1e-6 || !Number.isFinite(dir.x + dir.y + dir.z)) continue
      bone.dirTarget.copy(dir.normalize())
      bone.hasDir = true
    }

    // ---- HEAD + NECK from the face landmarks (falls back to following the body) ----
    this.solveHead(lm)

    // ---- SHOULDERS: clavicles rise as the arm passes horizontal (measured in the
    // body's own frame so it works mid-turn) ----
    this.solveShrug('leftShoulder', lm[LM.leftShoulder], lm[LM.leftElbow], 1)
    this.solveShrug('rightShoulder', lm[LM.rightShoulder], lm[LM.rightElbow], -1)

    // ---- STAGE TRANSLATION ----
    // • world hip midpoint — side-steps and crouches for the bundled routines (real
    //   videos are hip-centered, ≈0). World y is down; three.js up.
    // • image-space travel — real videos ONLY: toward/away from camera (apparent torso
    //   size) and across the frame (hip midpoint) vs the calibrated routine median.
    if (lhRaw && rhRaw) {
      const hx = (lhRaw.x + rhRaw.x) / 2
      const hy = (lhRaw.y + rhRaw.y) / 2
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

  /** Head/neck orientation from ears + eyes, split neck 35% / head 65%. When the face
   *  isn't usable (turned away, occluded), the head follows the body instead. */
  private solveHead(lm: Landmark[]) {
    const le = lm[LM.leftEar]
    const re = lm[LM.rightEar]
    const ley = lm[LM.leftEye]
    const rey = lm[LM.rightEye]
    let applied = false
    if (le && re && ley && rey) {
      // Lateral axis: right ear → left ear; forward: ear midpoint → eye midpoint.
      const R = lmToWorld(le, this.tmpVec).sub(lmToWorld(re, this.tmpVec2))
      const F = this.tmpVec3.set(
        (ley.x + rey.x - le.x - re.x) / 2,
        -(ley.y + rey.y - le.y - re.y) / 2,
        -((ley.z ?? 0) + (rey.z ?? 0) - (le.z ?? 0) - (re.z ?? 0)) / 2,
      )
      if (R.lengthSq() > 1e-6 && F.lengthSq() > 1e-6) {
        R.normalize()
        F.normalize()
        // Face must roughly agree with the body's facing — otherwise the landmarks are
        // occlusion noise and would whip the head around.
        const bodyF = this.tmpVec4.set(0, 0, 1).applyQuaternion(this.hipsQuat)
        if (F.dot(bodyF) > 0.2) {
          const U = this.tmpVec4.crossVectors(F, R)
          if (U.lengthSq() > 1e-6 && U.y > 0.2) {
            U.normalize()
            const R2 = this.tmpVec2.crossVectors(U, F).normalize()
            this.tmpMat.makeBasis(R2, U, F)
            this.tmpQuat.setFromRotationMatrix(this.tmpMat)
            if (Number.isFinite(this.tmpQuat.x + this.tmpQuat.w)) {
              // Targets are ABSOLUTE world orientations: the head gets the full face
              // orientation, the neck splits the difference from the body — so a turn
              // shared by the whole body doesn't count twice (or get counter-rotated).
              this.tmpQuat2.copy(this.hipsQuat).slerp(this.tmpQuat, 0.5)
              this.setRotQuat('neck', this.tmpQuat2, 1)
              this.setRotQuat('head', this.tmpQuat, 1)
              applied = true
            }
          }
        }
      }
    }
    if (!applied) {
      // Follow the body through turns rather than freezing at the last good pose.
      this.setRotQuat('neck', this.hipsQuat, 1)
      this.setRotQuat('head', this.hipsQuat, 1)
    }
  }

  /** Clavicle rise once the upper arm passes horizontal — a natural shrug. Elevation is
   *  measured in the body frame so it stays correct when the dancer turns. */
  private solveShrug(key: BoneKey, shoulder: Landmark | undefined, elbow: Landmark | undefined, sign: 1 | -1) {
    if (!shoulder || !elbow) return
    const v = lmToWorld(elbow, this.tmpVec).sub(lmToWorld(shoulder, this.tmpVec2))
    const len = v.length()
    if (len < 1e-4) return
    v.applyQuaternion(this.tmpQuat.copy(this.hipsQuat).invert())
    // 0 = arm straight down, 180 = straight up (body frame; y is up here).
    const elev = (Math.acos(THREE.MathUtils.clamp(-v.y / len, -1, 1)) * 180) / Math.PI
    const amt = THREE.MathUtils.clamp((elev - 100) / 80, 0, 1) * (12 * Math.PI / 180)
    this.tmpQuat2
      .copy(this.hipsQuat)
      .multiply(this.tmpQuat3.setFromEuler(this.tmpEuler.set(0, 0, sign * amt, 'XYZ')))
    this.setRotQuat(key, this.tmpQuat2, 1)
  }

  /** Apply a world-aligned rotation (optionally scaled toward identity) to a bone target. */
  private setRotQuat(key: BoneKey, q: THREE.Quaternion, weight: number) {
    const bone = this.bones.get(key)
    if (!bone) return
    const w = weight >= 1 ? q : this.tmpQuat3.identity().slerp(q, weight)
    bone.target
      .copy(bone.parentRestWorld)
      .invert()
      .multiply(w)
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

    // 1) World-aligned bones (hips, spine chain, head, clavicles).
    for (const bone of this.bones.values()) {
      if (bone.hasTarget) bone.node.quaternion.slerp(bone.target, sRot)
    }
    this.root?.position.lerp(this.posTarget, sPos)

    // 2) Limb segments: align each bone to its landmark direction, parents first so a
    //    child's local target is computed against the parent's fresh orientation.
    for (const seg of LIMB_SEGMENTS) {
      const bone = this.bones.get(seg.key)
      if (!bone?.hasDir || !bone.restDir || !bone.dirTarget || !bone.node.parent) continue
      bone.node.parent.getWorldQuaternion(this.tmpQuat)
      // Minimal world rotation taking the rest direction to the target direction.
      this.tmpQuat2.setFromUnitVectors(bone.restDir, bone.dirTarget)
      // desired world = align · restWorld; local = parentWorld⁻¹ · desired.
      this.tmpQuat3.copy(this.tmpQuat2).multiply(bone.restWorld)
      this.tmpQuat.invert().multiply(this.tmpQuat3)
      bone.node.quaternion.slerp(this.tmpQuat, sRot)
    }

    // 3) FOOT PLANTING: keep each foot level and pointing forward (its rest world
    //    orientation) instead of inheriting the shin's tilt.
    for (const key of ['leftFoot', 'rightFoot'] as const) {
      const foot = this.bones.get(key)
      if (!foot?.node.parent) continue
      foot.node.parent.getWorldQuaternion(this.tmpQuat)
      this.tmpQuat2.copy(this.tmpQuat).invert().multiply(foot.restWorld)
      foot.node.quaternion.slerp(this.tmpQuat2, 0.85)
    }

    // 4) GROUND CLAMP: hip-drop (crouches) lowers the whole body, but bent knees don't
    //    shorten the legs by exactly the same amount — if the lower foot dips below its
    //    flat-standing height, lift the root so the sole stays ON the stage. Only ever
    //    lifts, so jumps still work.
    if (this.root) {
      const lf = this.bones.get('leftFoot')
      const rf = this.bones.get('rightFoot')
      if (lf && rf) {
        const ly = lf.node.getWorldPosition(this.tmpVec).y
        const ry = rf.node.getWorldPosition(this.tmpVec2).y
        const penetration = Math.min(ly, ry) - this.restFootY
        if (penetration < 0) this.root.position.y -= penetration
      }
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
