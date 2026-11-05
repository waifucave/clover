// Everything three.js about one avatar: its renderer, camera, lights and the loaded VRM. Load order follows
// daydreamers' AvatarManager: check the bytes, parse with three-vrm, turn a VRM 0.x model to face the camera,
// combine skeletons and morphs. Each frame poses the normalised bones, writes the expressions, then updates the
// VRM (spring bones with a clamped step) and draws. Nothing above this class touches three.js, and the renderer
// is a seam, so the rest is testable without a GPU.

import { AmbientLight, Color, DirectionalLight, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import type { VisemeWeights } from "../lipsync/visemes";
import type { Pose } from "../motion/idle";
import { validateVrm, type VrmMeta } from "./validate";

/** three-vrm clamps its step nowhere; a long frame would throw the hair. */
export const SPRING_MAX_STEP = 0.05;

export function clampStep(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds, SPRING_MAX_STEP);
}

/** What draws: a WebGLRenderer, or a test's stand-in. */
export interface AvatarRenderer {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: Scene, camera: PerspectiveCamera): void;
  dispose(): void;
}

export type RendererFactory = (canvas: HTMLCanvasElement) => AvatarRenderer;

export const webGLRenderer: RendererFactory = (canvas) => {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: "low-power" });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  return renderer;
};

/** The stage's light, from the theme's `avatar.*` tokens. */
export interface StageLights {
  key: string;
  fill: string;
  rim: string;
  exposure: number;
}

export const DEFAULT_LIGHTS: StageLights = { key: "#FFFFFF", fill: "#FFF1F8", rim: "#FFFFFF", exposure: 1 };

export type Framing = "bust" | "full";

export interface FaceState {
  visemes: VisemeWeights;
  /** 0 open, 1 shut. */
  blink: number;
  happy?: number;
  surprised?: number;
}

export interface LoadedAvatar {
  meta: VrmMeta;
  /** Where the camera looks, and from how far, for this model and framing. */
  focus: { x: number; y: number; z: number };
}

export class AvatarScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(24, 1, 0.05, 20);
  private readonly renderer: AvatarRenderer;
  private vrm: VRM | null = null;
  private readonly key = new DirectionalLight(0xffffff, 2.2);
  private readonly fill = new DirectionalLight(0xffffff, 0.9);
  private readonly rim = new DirectionalLight(0xffffff, 1.4);
  private readonly ambient = new AmbientLight(0xffffff, 0.55);
  private disposed = false;
  private framing: Framing;
  private size = { width: 1, height: 1 };

  constructor(canvas: HTMLCanvasElement, options: { createRenderer?: RendererFactory; framing?: Framing; lights?: StageLights } = {}) {
    this.renderer = (options.createRenderer ?? webGLRenderer)(canvas);
    this.framing = options.framing ?? "bust";
    this.key.position.set(-0.8, 1.6, 1.6);
    this.fill.position.set(1.2, 0.8, 1.0);
    this.rim.position.set(0.4, 1.4, -1.6);
    this.scene.add(this.key, this.fill, this.rim, this.ambient);
    this.setLights(options.lights ?? DEFAULT_LIGHTS);
  }

  get loaded(): boolean {
    return this.vrm !== null;
  }

  setLights(lights: StageLights): void {
    const exposure = Number.isFinite(lights.exposure) ? Math.min(Math.max(lights.exposure, 0.2), 2) : 1;
    this.key.color = new Color(opaque(lights.key));
    this.fill.color = new Color(opaque(lights.fill));
    this.rim.color = new Color(opaque(lights.rim));
    this.key.intensity = 2.2 * exposure;
    this.fill.intensity = 0.9 * exposure;
    this.rim.intensity = 1.4 * exposure;
    this.ambient.intensity = 0.55 * exposure;
  }

  /** Checks and parses the bytes; replaces any avatar already shown. Throws a sentence a person can read. */
  async load(bytes: ArrayBuffer): Promise<LoadedAvatar> {
    const check = validateVrm(new Uint8Array(bytes));
    if (!check.ok) throw new Error(check.detail);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(bytes, "");
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error("The file has no VRM avatar in it.");
    if (this.disposed) {
      VRMUtils.deepDispose(vrm.scene);
      throw new Error("The avatar was closed while it loaded.");
    }
    VRMUtils.rotateVRM0(vrm);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.combineMorphs(vrm);
    vrm.scene.traverse((o: Object3D) => {
      o.frustumCulled = false;
    });
    this.unload();
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    const focus = this.frame(this.framing);
    return { meta: check.meta, focus };
  }

  /** Points the camera at the head and shoulders, or the whole figure. */
  frame(framing: Framing): { x: number; y: number; z: number } {
    this.framing = framing;
    const head = new Vector3(0, 1.3, 0);
    const node = this.vrm?.humanoid.getRawBoneNode("head");
    if (node) {
      node.updateWorldMatrix(true, false);
      node.getWorldPosition(head);
    }
    const aspect = this.size.width / Math.max(1, this.size.height);
    const fov = framing === "bust" ? 24 : 30;
    // Bust: from the chest to just over the head. Full: the feet to the top of the head.
    const top = head.y + 0.2;
    const bottom = framing === "bust" ? head.y - 0.33 : 0;
    const height = top - bottom;
    const half = (fov * Math.PI) / 360;
    // Fit the height, and on a narrow stage the shoulders' width too.
    const width = framing === "bust" ? 0.5 : 0.7;
    const distance = Math.max(height / 2 / Math.tan(half), width / 2 / (Math.tan(half) * Math.max(aspect, 0.01)));
    const target = { x: 0, y: bottom + height / 2, z: 0 };
    this.camera.fov = fov;
    this.camera.aspect = aspect;
    this.camera.position.set(0, target.y + height * 0.04, distance);
    this.camera.lookAt(target.x, target.y, target.z);
    this.camera.updateProjectionMatrix();
    return target;
  }

  setSize(width: number, height: number, ratio = 1): void {
    this.size = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.size.width, this.size.height, false);
    this.frame(this.framing);
  }

  /** One frame: the pose, the face, the springs (by `dt`), then the picture. */
  draw(pose: Pose, face: FaceState, dt: number): void {
    if (this.vrm) {
      this.apply(pose, face);
      this.vrm.update(clampStep(dt));
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** The pose on the normalised bones and the face's expressions, written before the VRM updates. */
  private apply(pose: Pose, face: FaceState): void {
    const vrm = this.vrm!;
    for (const [name, euler] of Object.entries(pose)) {
      const bone = vrm.humanoid.getNormalizedBoneNode(name as never);
      if (bone && euler) bone.rotation.set(euler[0], euler[1], euler[2]);
    }
    const em = vrm.expressionManager;
    if (!em) return;
    for (const [name, value] of Object.entries(face.visemes)) em.setValue(name, value);
    em.setValue("blink", face.blink);
    em.setValue("happy", face.happy ?? 0);
    em.setValue("surprised", face.surprised ?? 0);
  }

  /** Runs the pose and face for `seconds` without drawing, so a still's spring bones come to rest first. */
  settle(pose: Pose, face: FaceState, seconds: number): void {
    const vrm = this.vrm;
    if (!vrm) return;
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) {
      this.apply(pose, face);
      vrm.update(1 / 60);
    }
  }

  /** The current expression weights (tests). */
  expression(name: string): number {
    return this.vrm?.expressionManager?.getValue(name) ?? 0;
  }

  private unload(): void {
    if (!this.vrm) return;
    this.scene.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }

  dispose(): void {
    this.disposed = true;
    this.unload();
    this.renderer.dispose();
  }
}

/** A colour without its alpha: lights take RGB. */
function opaque(color: string): string {
  const c = color.trim();
  return /^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) : /^#[0-9a-f]{6}$/i.test(c) ? c : "#FFFFFF";
}
