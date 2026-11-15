// Everything three.js about one avatar: its renderer, camera, lights and the loaded VRM. Load order follows
// daydreamers' AvatarManager: check the bytes, parse with three-vrm, turn a VRM 0.x model to face the camera,
// combine skeletons and morphs. Each frame poses the normalised bones, writes the expressions, then updates the
// VRM (spring bones with a clamped step) and draws. Nothing above this class touches three.js, and the renderer
// is a seam, so the rest is testable without a GPU.

import { AmbientLight, Box3, Color, DirectionalLight, Object3D, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import type { VisemeWeights } from "../lipsync/visemes";
import type { Pose } from "../motion/idle";
import { withoutAnimations } from "./glb";
import { validateVrm, type AssetRejection, type VrmMeta } from "./validate";

/** Why an avatar file could not be shown: a stable reason (worded through `t()` for the screen) and the check's
 *  detail (for the log). */
export class AvatarError extends Error {
  constructor(
    readonly reason: AssetRejection | "unreadable" | "closed",
    readonly detail: string,
  ) {
    super(detail);
  }
}

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

/** `bust`: head and shoulders; `waist`: down to the thighs (a figure that stands in front of grass or a desk); `full`: the whole figure. */
export type Framing = "bust" | "waist" | "full";
/** A layout's own crop of the figure: `show` of the figure's height from the top of her head down, with `headroom` of air above it (both fractions of her height). */
export interface Crop { show: number; headroom: number }

/** Light intensities at an exposure of 1. */
export const LIGHT = { key: 1.8, fill: 0.45, rim: 1.0, ambient: 0.4 } as const;

export interface FaceState {
  visemes: VisemeWeights;
  /** 0 open, 1 shut. */
  blink: number;
  happy?: number;
  surprised?: number;
  /** More preset expressions by name (a cue's: `angry`, `sad`, `relaxed`, …), each 0 to 1. */
  expressions?: Readonly<Record<string, number>>;
}

/** The expression presets a cue may ask for: the VRM presets that show a mood (`blink` and the mouth's shapes are the avatar's own). */
export const MOOD_EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised"] as const;

/** Where the figure stands in the canvas's own pixels (top left origin). */
export interface FigureLayout {
  figure: { x: number; y: number; width: number; height: number };
  headTop?: { x: number; y: number };
  face?: { x: number; y: number };
  mouth?: { x: number; y: number };
  chest?: { x: number; y: number };
}

export interface LoadedAvatar {
  meta: VrmMeta;
  /** Where the camera looks, and from how far, for this model and framing. */
  focus: { x: number; y: number; z: number };
}

/** The most outfit parts a model may name; a model marking more has the first this many. */
export const OUTFIT_PARTS_MAX = 32;
// eslint-disable-next-line no-control-regex
const OUTFIT_NAME = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,64}$/;

/**
 * A model's outfit parts: the nodes its author marks in the glTF node's `extras` with `"clover": { "outfit": "<name>" }`
 * (several nodes may carry one name: a dress's bodice, skirt and sleeves switch together). A part shows as the file draws
 * it, unless the mark also says `"on": false`, when it starts hidden (an alternative outfit). Switching a part only shows or
 * hides its nodes; nothing else in the model changes. By name, in the order the model first names them.
 */
export function outfitParts(root: Object3D): Map<string, Object3D[]> {
  const parts = new Map<string, Object3D[]>();
  root.traverse((o) => {
    const mark = (o.userData as { clover?: { outfit?: unknown; on?: unknown } } | undefined)?.clover;
    const name = mark?.outfit;
    if (typeof name !== "string" || !OUTFIT_NAME.test(name)) return;
    if (!parts.has(name) && parts.size >= OUTFIT_PARTS_MAX) return;
    if (mark?.on === false) o.visible = false;
    parts.set(name, [...(parts.get(name) ?? []), o]);
  });
  return parts;
}

export class AvatarScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(24, 1, 0.05, 20);
  private readonly renderer: AvatarRenderer;
  private vrm: VRM | null = null;
  // MToon lights each surface by every light's colour over π: a key of about π alone would draw the base
  // colours as made. Key, fill and ambient together come to a little under that, so pale colours keep their tint.
  private readonly key = new DirectionalLight(0xffffff, LIGHT.key);
  private readonly fill = new DirectionalLight(0xffffff, LIGHT.fill);
  private readonly rim = new DirectionalLight(0xffffff, LIGHT.rim);
  private readonly ambient = new AmbientLight(0xffffff, LIGHT.ambient);
  /** The figure's height, top and the head's height, measured once it loads. */
  private bounds = { top: 1.45, bottom: 0, head: 1.3, left: -0.3, right: 0.3, z: 0 };
  private lookTarget: Object3D | null = null;
  /** The model's outfit parts (`outfitParts`), by name. */
  private outfits = new Map<string, Object3D[]>();
  private disposed = false;
  private framing: Framing;
  private crop: Crop | undefined;
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
    this.key.intensity = LIGHT.key * exposure;
    this.fill.intensity = LIGHT.fill * exposure;
    this.rim.intensity = LIGHT.rim * exposure;
    this.ambient.intensity = LIGHT.ambient * exposure;
  }

  /** Checks and parses the bytes; replaces any avatar already shown. Throws a sentence a person can read. */
  async load(bytes: ArrayBuffer): Promise<LoadedAvatar> {
    const check = validateVrm(new Uint8Array(bytes));
    if (!check.ok) throw new AvatarError(check.reason, check.detail);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    // The avatar plays no glTF clips: the loader never sees them, so it builds none of their tracks.
    const loadable = withoutAnimations(new Uint8Array(bytes));
    const buffer = loadable.byteOffset === 0 && loadable.byteLength === loadable.buffer.byteLength ? loadable.buffer : loadable.slice().buffer;
    let gltf: Awaited<ReturnType<GLTFLoader["parseAsync"]>>;
    try {
      gltf = await loader.parseAsync(buffer as ArrayBuffer, "");
    } catch (error) {
      throw new AvatarError("malformed", error instanceof Error ? error.message : String(error));
    }
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new AvatarError("not-vrm", "The file has no VRM avatar in it.");
    if (this.disposed) {
      VRMUtils.deepDispose(vrm.scene);
      throw new AvatarError("closed", "The avatar was closed while it loaded.");
    }
    VRMUtils.rotateVRM0(vrm);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.combineMorphs(vrm);
    vrm.scene.traverse((o: Object3D) => {
      o.frustumCulled = false;
    });
    this.unload();
    this.vrm = vrm;
    this.outfits = outfitParts(vrm.scene);
    this.scene.add(vrm.scene);
    this.measure(vrm);
    const focus = this.frame(this.framing);
    return { meta: check.meta, focus };
  }

  /** The figure's top and bottom (its rest pose's box) and where its head bone sits. */
  private measure(vrm: VRM): void {
    vrm.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(vrm.scene);
    const head = new Vector3(0, box.max.y * 0.85, 0);
    const node = vrm.humanoid.getRawBoneNode("head");
    if (node) node.getWorldPosition(head);
    if (Number.isFinite(box.max.y) && box.max.y > box.min.y) this.bounds = { top: box.max.y, bottom: box.min.y, head: head.y, left: box.min.x, right: box.max.x, z: (box.min.z + box.max.z) / 2 };
  }

  /** Points the camera at the head and shoulders, or the whole figure. */
  frame(framing: Framing, crop?: Crop | null): { x: number; y: number; z: number } {
    this.framing = framing;
    if (crop !== undefined) this.crop = crop ?? undefined;
    const cropped = this.crop;
    const aspect = this.size.width / Math.max(1, this.size.height);
    const fov = framing === "bust" ? 24 : framing === "waist" ? 27 : 30;
    const { top: figureTop, bottom: figureBottom, head } = this.bounds;
    const figure = figureTop - figureBottom;
    // Bust: from the chest to a little over the top of the head (hair included). Full: the whole figure.
    // A layout may ask for its own crop (`--clover-avatar-crop`: the share of the figure's height shown below the head's top, and `--clover-avatar-headroom`: the air above it, as a share of the figure's height).
    const top = figureTop + figure * (cropped ? cropped.headroom : 0.03);
    const bottom = cropped ? figureTop - figure * cropped.show : framing === "bust" ? head - (figureTop - head) * 0.95 : framing === "waist" ? figureBottom + figure * 0.3 : figureBottom - figure * 0.02;
    const height = top - bottom;
    const half = (fov * Math.PI) / 360;
    // Fit the height, and on a narrow stage the shoulders' width too.
    // A layout's own crop fits the height; on a narrow stage the sides may be cut rather than the figure made small.
    const width = cropped ? 0.36 : framing === "bust" ? 0.5 : framing === "waist" ? 0.6 : 0.7;
    const distance = Math.max(height / 2 / Math.tan(half), width / 2 / (Math.tan(half) * Math.max(aspect, 0.01)));
    // On a tall, narrow stage the width decides the distance and more of the figure shows: keep the top of the
    // head where it is and let the extra show below.
    const visible = 2 * distance * Math.tan(half);
    const target = { x: 0, y: top - visible / 2, z: 0 };
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
    for (const [name, value] of Object.entries(face.expressions ?? {})) em.setValue(name, value);
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

  /** The mood presets this model has (`MOOD_EXPRESSIONS` it carries). */
  expressionNames(): string[] {
    const em = this.vrm?.expressionManager;
    return em ? MOOD_EXPRESSIONS.filter((n) => em.getExpression(n) != null) : [];
  }

  /** The outfit parts this model marks, each with whether it shows now. */
  outfitNames(): { name: string; on: boolean }[] {
    return [...this.outfits].map(([name, nodes]) => ({ name, on: nodes.some((n) => n.visible) }));
  }

  /** Shows or hides an outfit part's nodes; false when the model has no part by that name. */
  setOutfit(name: string, on: boolean): boolean {
    const nodes = this.outfits.get(name);
    if (nodes === undefined) return false;
    for (const n of nodes) n.visible = on;
    return true;
  }

  /** Makes the figure look at a point of the stage in its own square (-1 to 1 from the centre, y down); null: at
   *  nothing in particular. */
  lookAt(point: { x: number; y: number } | null): void {
    const look = this.vrm?.lookAt;
    if (!look) return;
    if (point === null) { look.target = null; return; }
    const half = (this.camera.fov * Math.PI) / 360;
    const distance = Math.max(0.1, this.camera.position.z - this.bounds.z);
    const visibleH = 2 * distance * Math.tan(half);
    const o = this.lookTarget ?? (this.lookTarget = new Object3D());
    o.position.set(point.x * (visibleH * this.camera.aspect) / 2, this.camera.position.y - point.y * visibleH / 2, this.bounds.z + 0.5);
    o.updateMatrixWorld(true);
    look.target = o;
  }

  /** Where the figure stands in the canvas now, from the camera: the figure's rectangle (kept to the canvas) and the
   *  head, face, mouth and chest where they project inside it. A portrait's proportions place the face and mouth from
   *  the head bone and the top. Undefined while nothing is loaded. */
  layout(): FigureLayout | undefined {
    const vrm = this.vrm;
    if (!vrm) return undefined;
    const { width: w, height: h } = this.size;
    this.camera.updateMatrixWorld(true);
    const at = (x: number, y: number, z: number) => {
      const v = new Vector3(x, y, z).project(this.camera);
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    };
    const b = this.bounds;
    const tl = at(b.left, b.top, b.z), br = at(b.right, b.bottom, b.z);
    const x0 = Math.max(0, Math.min(tl.x, br.x)), x1 = Math.min(w, Math.max(tl.x, br.x));
    const y0 = Math.max(0, Math.min(tl.y, br.y)), y1 = Math.min(h, Math.max(tl.y, br.y));
    if (!(x1 > x0 && y1 > y0)) return { figure: { x: 0, y: 0, width: w, height: h } };
    const out: FigureLayout = { figure: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    const head = new Vector3(0, b.head, b.z);
    vrm.humanoid.getRawBoneNode("head")?.getWorldPosition(head);
    const inside = (p: { x: number; y: number }) => (p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h ? p : undefined);
    const above = b.top - head.y;
    const top = inside(at(head.x, b.top, head.z));
    const face = inside(at(head.x, head.y + above * 0.45, head.z));
    const mouth = inside(at(head.x, head.y + above * 0.2, head.z));
    const chestNode = vrm.humanoid.getRawBoneNode("upperChest") ?? vrm.humanoid.getRawBoneNode("chest");
    const chestAt = new Vector3();
    chestNode?.getWorldPosition(chestAt);
    const chest = chestNode ? inside(at(chestAt.x, chestAt.y, chestAt.z)) : undefined;
    if (top) out.headTop = top;
    if (face) out.face = face;
    if (mouth) out.mouth = mouth;
    if (chest) out.chest = chest;
    return out;
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
    this.outfits = new Map();
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
