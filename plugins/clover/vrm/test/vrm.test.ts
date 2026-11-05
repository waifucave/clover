import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, type VRM } from "@pixiv/three-vrm";
import type { Mesh } from "three";
import { FACE_TARGETS, PLACEHOLDER_NAME, makePlaceholderVrm } from "../src/placeholder/model";
import { GltfBuilder, glbJson } from "../src/vrm/glb";
import { VRM_BUDGETS, validateVrm } from "../src/vrm/validate";
import { AvatarScene, clampStep, SPRING_MAX_STEP, type AvatarRenderer } from "../src/vrm/scene";
import { idlePose } from "../src/motion/idle";
import { SHUT } from "../src/lipsync/visemes";

const COMMITTED = join(import.meta.dir, "..", "..", "..", "alpha", "assets", "alpha.vrm");
const bytes = () => new Uint8Array(readFileSync(COMMITTED));
const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

async function parse(b: Uint8Array): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buffer(b), "");
  return gltf.userData.vrm as VRM;
}

/** Where two JSON values differ, numbers allowed a float's last bits (and values within a millionth of zero). */
function differences(a: unknown, b: unknown, at = "$"): string[] {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-6 + 1e-5 * Math.max(Math.abs(a), Math.abs(b)) ? [] : [`${at}: ${a} ≠ ${b}`];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [`${at}: ${a.length} items ≠ ${b.length}`];
    return a.flatMap((item, i) => differences(item, b[i], `${at}[${i}]`));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`));
  }
  return a === b ? [] : [`${at}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
}

describe("Alpha's placeholder model", () => {
  test("the committed file is what the code makes (run `bun run placeholder` after a change)", () => {
    // Equal but for the last bits of a float: Math.sin and friends may round differently from one machine to another.
    const made = makePlaceholderVrm();
    const committed = bytes();
    expect(differences(glbJson(made), glbJson(committed))).toEqual([]);
    // The BIN chunks, each from its own offset (a JSON number printed a digit longer moves it).
    const bin = (glb: Uint8Array) => {
      const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
      const start = 28 + view.getUint32(12, true);
      return new DataView(glb.buffer, glb.byteOffset + start, glb.byteLength - start);
    };
    const a = bin(made);
    const b = bin(committed);
    expect(a.byteLength).toBe(b.byteLength);
    let differing = 0;
    for (let at = 0; at + 4 <= a.byteLength; at += 4) {
      if (a.getUint32(at, true) === b.getUint32(at, true)) continue;
      const x = a.getFloat32(at, true);
      const y = b.getFloat32(at, true);
      expect(Math.abs(x - y), `BIN byte ${at}`).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(x)));
      differing++;
    }
    expect(differing).toBeLessThan(a.byteLength / 4 / 100);
  });

  test("passes the structural check, and says it is a placeholder", () => {
    const check = validateVrm(bytes());
    if (!check.ok) throw new Error(check.detail);
    expect(check.meta).toMatchObject({
      title: PLACEHOLDER_NAME,
      version: "1.0",
      placeholder: true,
      creditRequired: false,
      commercialUse: "allowed",
      redistribution: "allowed",
      otherLicenceUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    });
    expect(check.stats.vertices).toBeLessThan(VRM_BUDGETS.vertices / 10);
    expect(check.stats.images).toBe(0);
  });

  test("three-vrm reads it: every required bone, the mouth shapes, the blinks, the springs", async () => {
    const vrm = await parse(bytes());
    for (const bone of ["hips", "spine", "head", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm", "rightHand", "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot"]) {
      expect(vrm.humanoid.getRawBoneNode(bone as never), bone).toBeTruthy();
    }
    const names = vrm.expressionManager!.expressions.map((e) => e.expressionName);
    for (const name of ["aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight", "happy", "surprised"]) expect(names).toContain(name);
    expect(vrm.springBoneManager!.joints.size).toBeGreaterThan(0);
    expect(vrm.meta.metaVersion).toBe("1");
  });

  test("an expression moves the face's morph targets", async () => {
    const vrm = await parse(bytes());
    const faces: Mesh[] = [];
    vrm.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length === FACE_TARGETS.length) faces.push(mesh);
    });
    expect(faces.length).toBeGreaterThan(0);
    vrm.expressionManager!.setValue("aa", 1);
    vrm.update(1 / 60);
    const aa = FACE_TARGETS.indexOf("aa");
    expect(faces.some((m) => m.morphTargetInfluences![aa] === 1)).toBe(true);
    // The mouth's own target really moves it: its deltas are not all zero.
    const json = glbJson(bytes()) as { meshes: { name: string; primitives: { material: number; targets?: { POSITION: number }[] }[] }[]; accessors: { max?: number[]; min?: number[] }[]; materials: { name: string }[] };
    const face = json.meshes.find((m) => m.name === "Face")!;
    const mouth = face.primitives.find((p) => json.materials[p.material]!.name === "mouth")!;
    const delta = json.accessors[mouth.targets![aa]!.POSITION]!;
    expect(Math.max(...delta.max!.map(Math.abs), ...delta.min!.map(Math.abs))).toBeGreaterThan(0.005);
  });
});

describe("the structural check", () => {
  const tiny = (vrm: boolean, extra: (b: GltfBuilder) => void = () => {}) => {
    const b = new GltfBuilder("test");
    const position = b.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", { bounds: true });
    b.node({ mesh: b.mesh({ primitives: [{ attributes: { POSITION: position } }] }) });
    if (vrm) {
      b.json.extensions.VRMC_vrm = { specVersion: "1.0", meta: { name: "Tiny", authors: ["Sam"], licenseUrl: "https://vrm.dev/licenses/1.0/", creditNotation: "required" }, humanoid: { humanBones: {} } };
      b.use("VRMC_vrm");
    }
    extra(b);
    return b.toGlb();
  };

  test("a small VRM passes and its licence asks for credit", () => {
    const check = validateVrm(tiny(true));
    expect(check.ok && check.meta.creditRequired).toBe(true);
    expect(check.ok && check.meta.placeholder).toBe(false);
  });

  test("refuses what is not a binary glTF, a glTF that is not a VRM, and a file reaching outside itself", () => {
    expect(validateVrm(new TextEncoder().encode("hello")).ok).toBe(false);
    const plain = validateVrm(tiny(false));
    expect(!plain.ok && plain.reason).toBe("not-vrm");
    const outside = validateVrm(tiny(true, (b) => (b.json.images = [{ uri: "https://example.com/x.png" }])));
    expect(!outside.ok && outside.reason).toBe("external-reference");
    const cut = tiny(true).subarray(0, 40);
    expect(validateVrm(cut).ok).toBe(false);
  });

  test("refuses an extension it can't draw", () => {
    const check = validateVrm(tiny(true, (b) => (b.json.extensionsRequired = ["KHR_draco_mesh_compression"])));
    expect(!check.ok && check.reason).toBe("unsupported-extension");
  });
});

/** A renderer that only counts. */
function fakeRenderer() {
  const calls = { render: 0, setSize: [] as [number, number][], disposed: false };
  const renderer: AvatarRenderer = {
    setPixelRatio: () => {},
    setSize: (w, h) => void calls.setSize.push([w, h]),
    render: () => void calls.render++,
    dispose: () => void (calls.disposed = true),
  };
  return { calls, create: () => renderer };
}

describe("the avatar's scene", () => {
  test("loads, frames the head and shoulders, poses, drives the face, and lets go of everything", async () => {
    const fake = fakeRenderer();
    const scene = new AvatarScene(document.createElement("canvas"), { createRenderer: fake.create });
    const loaded = await scene.load(buffer(bytes()));
    expect(loaded.meta.placeholder).toBe(true);
    scene.setSize(400, 520);
    // The bust frame looks at the face's height, from in front.
    expect(scene.camera.position.z).toBeGreaterThan(0.5);
    expect(loaded.focus.y).toBeGreaterThan(1);
    scene.draw(idlePose(0.4), { visemes: { ...SHUT, aa: 0.7 }, blink: 1 }, 1 / 60);
    expect(fake.calls.render).toBe(1);
    expect(scene.expression("aa")).toBeCloseTo(0.7, 6);
    expect(scene.expression("blink")).toBe(1);
    scene.settle(idlePose(0.4), { visemes: SHUT, blink: 0 }, 0.5);
    expect(fake.calls.render).toBe(1);
    scene.dispose();
    expect(fake.calls.disposed).toBe(true);
  });

  test("refuses bad bytes with a sentence", async () => {
    const scene = new AvatarScene(document.createElement("canvas"), { createRenderer: fakeRenderer().create });
    await expect(scene.load(new TextEncoder().encode("nope").buffer as ArrayBuffer)).rejects.toThrow("Not a binary glTF");
  });

  test("the springs never take a long step", () => {
    expect(clampStep(1)).toBe(SPRING_MAX_STEP);
    expect(clampStep(-1)).toBe(0);
    expect(clampStep(Number.NaN)).toBe(0);
    expect(clampStep(0.01)).toBe(0.01);
  });
});
