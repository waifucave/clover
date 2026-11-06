import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, type VRM } from "@pixiv/three-vrm";
import type { Mesh } from "three";
import { FACE_TARGETS, PLACEHOLDER_NAME, makePlaceholderVrm } from "../src/placeholder/model";
import { GltfBuilder, glbJson, withJson, withoutAnimations } from "../src/vrm/glb";
import { MAX_VRM_BYTES, VRM_BUDGETS, validateVrm } from "../src/vrm/validate";
import { AvatarScene, clampStep, SPRING_MAX_STEP, type AvatarRenderer } from "../src/vrm/scene";
import { idlePose } from "../src/motion/idle";
import { SHUT } from "../src/lipsync/visemes";

const COMMITTED = join(import.meta.dir, "..", "..", "..", "..", "alpha", "assets", "alpha.vrm");
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
      // One licence story: the VRM Public License 1.0 in both fields.
      licenceUrl: "https://vrm.dev/licenses/1.0/",
      otherLicenceUrl: "https://vrm.dev/licenses/1.0/",
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

/** A PNG's first 33 bytes: the signature and its IHDR, which is all the check reads. */
function pngHeader(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(out.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  return out;
}

/** A GLB by hand: its JSON, its BIN, and the header's claims (to lie with). */
function glb(json: unknown, bin = new Uint8Array(0), claims: { version?: number; total?: number; jsonLength?: number } = {}): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = (text.length + 3) & ~3;
  const binLength = (bin.length + 3) & ~3;
  const total = 12 + 8 + jsonLength + (bin.length > 0 ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, claims.version ?? 2, true);
  v.setUint32(8, claims.total ?? total, true);
  v.setUint32(12, claims.jsonLength ?? jsonLength, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (bin.length > 0) {
    v.setUint32(20 + jsonLength, binLength, true);
    v.setUint32(24 + jsonLength, 0x004e4942, true);
    out.set(bin, 28 + jsonLength);
  }
  return out;
}

describe("the structural check refuses, for every reason", () => {
  const VRM1 = { specVersion: "1.0", meta: { name: "M", authors: ["A"], licenseUrl: "https://vrm.dev/licenses/1.0/" }, humanoid: { humanBones: {} } };
  /** A VRM made with the builder, then `edit`ed: the budgets' cases. */
  const vrm = (edit: (b: GltfBuilder) => void) => {
    const b = new GltfBuilder("test");
    b.json.extensions.VRMC_vrm = structuredClone(VRM1);
    b.use("VRMC_vrm");
    edit(b);
    return b.toGlb();
  };
  /** An accessor with no bufferView: the loader makes a zero-filled array of count × element size. */
  const empty = (b: GltfBuilder, type: string, count: number) => (b.json.accessors.push({ componentType: 5126, type, count }), b.json.accessors.length - 1);
  const reason = (bytes: Uint8Array) => {
    const check = validateVrm(bytes);
    return check.ok ? "ok" : `${check.reason}: ${check.detail}`;
  };

  test("too-large: over the file cap, before anything is read", () => {
    expect(reason(new Uint8Array(MAX_VRM_BYTES + 1))).toStartWith("too-large");
  });

  test("not-glb: not a binary glTF, or not version 2", () => {
    expect(reason(new TextEncoder().encode("hello, world"))).toStartWith("not-glb");
    expect(reason(glb({ asset: { version: "2.0" } }, undefined, { version: 1 }))).toStartWith("not-glb");
  });

  test("malformed: lengths that disagree, JSON that does not parse, views and accessors outside the file", () => {
    expect(reason(glb({}, undefined, { total: 999 }))).toStartWith("malformed");
    expect(reason(glb({}, undefined, { jsonLength: 4000 }))).toStartWith("malformed");
    const broken = glb({ a: 1 });
    broken[20] = 0x7b;
    broken[21] = 0x7b;
    expect(reason(broken)).toStartWith("malformed");
    expect(reason(vrm((b) => (b.json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: 64 }), b.view(new Uint8Array(4)))))).toStartWith("malformed");
    expect(reason(vrm((b) => b.json.accessors.push({ bufferView: b.view(new Float32Array(3)), componentType: 5126, type: "VEC3", count: 2 })))).toStartWith("malformed");
    expect(reason(vrm((b) => (b.node({}), (b.json.nodes[0]!.children = [0]))))).toStartWith("malformed");
    expect(reason(vrm((b) => ((b.json as Record<string, unknown>).textures = [{ source: 3 }])))).toStartWith("malformed");
  });

  test("not-vrm: a glTF without a VRM extension", () => {
    expect(reason(tinyGltf())).toStartWith("not-vrm");
  });

  test("unsupported-extension: a required extension it cannot draw, an image that is neither PNG nor JPEG", () => {
    expect(reason(vrm((b) => (b.json.extensionsRequired = ["KHR_draco_mesh_compression"])))).toStartWith("unsupported-extension");
    expect(reason(vrm((b) => ((b.json as Record<string, unknown>).images = [{ bufferView: b.view(new TextEncoder().encode("GIF89a........")), mimeType: "image/gif" }])))).toStartWith("unsupported-extension");
  });

  test("external-reference: a buffer or an image that points outside the file", () => {
    expect(reason(vrm((b) => ((b.json as Record<string, unknown>).images = [{ uri: "https://example.com/x.png" }])))).toStartWith("external-reference");
    const json = { asset: { version: "2.0" }, extensions: { VRMC_vrm: VRM1 }, buffers: [{ uri: "data:application/octet-stream;base64,AAAA", byteLength: 3 }] };
    expect(reason(glb(json))).toStartWith("external-reference");
  });

  test("unaccepted-licence: a VRM 1.0 under any licence but the VRM Public License 1.0, in a sentence", () => {
    const check = validateVrm(vrm((b) => ((b.json.extensions.VRMC_vrm as { meta: Record<string, unknown> }).meta.licenseUrl = "https://example.com/my-licence")));
    expect(!check.ok && check.reason).toBe("unaccepted-licence");
    expect(!check.ok && check.detail).toContain("https://vrm.dev/licenses/1.0/");
    // Without the trailing slash three-vrm refuses it too.
    expect(reason(vrm((b) => ((b.json.extensions.VRMC_vrm as { meta: Record<string, unknown> }).meta.licenseUrl = "https://vrm.dev/licenses/1.0")))).toStartWith("unaccepted-licence");
  });

  test("over-budget: the JSON, the node forest, meshes and primitives, skins and joints", () => {
    expect(reason(glb({}, undefined, { jsonLength: VRM_BUDGETS.jsonBytes + 4 }))).toStartWith("over-budget");
    expect(reason(vrm((b) => { for (let i = 0; i <= VRM_BUDGETS.nodes; i++) b.node({}); }))).toStartWith("over-budget");
    expect(reason(vrm((b) => { let parent = b.node({}); for (let i = 0; i < VRM_BUDGETS.nodeDepth; i++) parent = b.node({}, parent); }))).toStartWith("over-budget");
    const position = (b: GltfBuilder) => b.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", { bounds: true });
    expect(reason(vrm((b) => { const p = position(b); for (let i = 0; i <= VRM_BUDGETS.meshes; i++) b.mesh({ primitives: [{ attributes: { POSITION: p } }] }); }))).toStartWith("over-budget");
    expect(reason(vrm((b) => { const p = position(b); b.mesh({ primitives: Array.from({ length: VRM_BUDGETS.primitives + 1 }, () => ({ attributes: { POSITION: p } })) }); }))).toStartWith("over-budget");
    expect(reason(vrm((b) => ((b.json as Record<string, unknown>).skins = Array.from({ length: VRM_BUDGETS.skins + 1 }, () => ({ joints: [] })))))).toStartWith("over-budget");
    expect(reason(vrm((b) => { const n = b.node({}); (b.json as Record<string, unknown>).skins = [{ joints: Array.from({ length: VRM_BUDGETS.jointsPerSkin + 1 }, () => n) }]; }))).toStartWith("over-budget");
  });

  test("over-budget: what the accessors decode to, a bufferView or not (the review's 708-byte, 3 GiB file)", () => {
    const bomb = vrm((b) => {
      const p = b.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", { bounds: true });
      b.mesh({ primitives: [{ attributes: { POSITION: p, NORMAL: empty(b, "VEC3", 2 ** 28) } }] });
    });
    expect(bomb.byteLength).toBeLessThan(2048);
    expect(reason(bomb)).toStartWith("over-budget");
    // Nobody uses it: it still decodes.
    expect(reason(vrm((b) => empty(b, "MAT4", 4_000_000)))).toStartWith("over-budget");
  });

  test("over-budget: vertices count by a primitive's widest attribute, every time it is drawn", () => {
    expect(reason(vrm((b) => {
      const p = b.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", { bounds: true });
      b.mesh({ primitives: [{ attributes: { POSITION: p, TEXCOORD_0: empty(b, "VEC2", VRM_BUDGETS.vertices + 1) } }] });
    }))).toStartWith("over-budget");
    expect(reason(vrm((b) => {
      const p = empty(b, "VEC3", 300_000);
      b.mesh({ primitives: [1, 2, 3, 4].map(() => ({ attributes: { POSITION: p } })) });
    }))).toStartWith("over-budget");
  });

  test("over-budget: morph targets, per primitive and over the whole model (the review's 512 × 128 file)", () => {
    expect(reason(vrm((b) => {
      const p = b.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", { bounds: true });
      b.mesh({ primitives: [{ attributes: { POSITION: p }, targets: Array.from({ length: VRM_BUDGETS.morphTargetsPerPrimitive + 1 }, () => ({ POSITION: p })) }] });
    }))).toStartWith("over-budget");
    const many = vrm((b) => {
      const p = empty(b, "VEC3", 1_500);
      const targets = Array.from({ length: VRM_BUDGETS.morphTargetsPerPrimitive }, () => ({ POSITION: p, NORMAL: p }));
      b.mesh({ primitives: Array.from({ length: 64 }, () => ({ attributes: { POSITION: p }, targets })) });
    });
    expect(many.byteLength).toBeLessThan(1024 * 1024);
    expect(reason(many)).toStartWith("over-budget");
  });

  test("over-budget: images by count, by size, by pixels over every texture that uploads them, and textures by count", () => {
    const images = (b: GltfBuilder, sizes: [number, number][]) => ((b.json as Record<string, unknown>).images = sizes.map(([w, h]) => ({ bufferView: b.view(pngHeader(w, h)), mimeType: "image/png" })));
    expect(reason(vrm((b) => images(b, Array.from({ length: VRM_BUDGETS.images + 1 }, () => [4, 4]))))).toStartWith("over-budget");
    expect(reason(vrm((b) => images(b, [[VRM_BUDGETS.imageDimension + 1, 4]])))).toStartWith("over-budget");
    expect(reason(vrm((b) => images(b, [[4096, 4096], [4096, 4096], [4096, 4096], [4096, 4096], [2048, 2048]])))).toStartWith("over-budget");
    // One 2048² image, uploaded by twenty textures.
    expect(reason(vrm((b) => {
      images(b, [[2048, 2048]]);
      (b.json as Record<string, unknown>).textures = Array.from({ length: 20 }, () => ({ source: 0 }));
    }))).toStartWith("over-budget");
    expect(reason(vrm((b) => {
      images(b, [[4, 4]]);
      (b.json as Record<string, unknown>).textures = Array.from({ length: VRM_BUDGETS.textures + 1 }, () => ({ source: 0 }));
    }))).toStartWith("over-budget");
  });

  test("over-budget: EXT_mesh_gpu_instancing, by instances and by the vertices they draw", () => {
    const instanced = (instances: number, vertices: number) =>
      vrm((b) => {
        const mesh = b.mesh({ primitives: [{ attributes: { POSITION: empty(b, "VEC3", vertices) } }] });
        b.node({ mesh, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: empty(b, "VEC3", instances) } } } });
        b.use("EXT_mesh_gpu_instancing");
      });
    expect(reason(instanced(4, 1_000))).toBe("ok");
    expect(reason(instanced(VRM_BUDGETS.instances + 1, 3))).toStartWith("over-budget");
    expect(reason(instanced(200, 10_000))).toStartWith("over-budget");
  });

  test("over-budget: a mesh counts again for every node that draws it (the review's 1,900-node file)", () => {
    const reused = (vertices: number, nodes: number) =>
      vrm((b) => {
        const mesh = b.mesh({ primitives: [{ attributes: { POSITION: empty(b, "VEC3", vertices) } }] });
        for (let i = 0; i < nodes; i++) b.node({ mesh });
      });
    // One 900k-vertex mesh named by 1,900 nodes: 1.7 billion vertices a frame.
    const bomb = reused(900_000, 1_900);
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    expect(reason(bomb)).toStartWith("over-budget");
    expect(reason(bomb)).toContain("drawn");
    const fine = validateVrm(reused(1_000, 10));
    expect(fine.ok && fine.stats.vertices).toBe(10_000);
    // Nodes and instances add up: 4 nodes of 64 instances each draw a 4,000-vertex mesh 256 times.
    expect(reason(vrm((b) => {
      const mesh = b.mesh({ primitives: [{ attributes: { POSITION: empty(b, "VEC3", 4_000) } }] });
      for (let i = 0; i < 4; i++) b.node({ mesh, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: empty(b, "VEC3", 64) } } } });
      b.use("EXT_mesh_gpu_instancing");
    }))).toStartWith("over-budget");
    expect(reason(vrm((b) => b.node({ mesh: 3 })))).toStartWith("malformed");
  });

  test("over-budget: animations by channel, each counting its own copy of the keyframes (the review's 21 KB file)", () => {
    /** One normalized byte VEC4 output of `keys` keyframes, named by `channels` channels (the review's probe). */
    const animated = (keys: number, channels: number) =>
      vrm((b) => {
        const node = b.node({ mesh: b.mesh({ primitives: [{ attributes: { POSITION: b.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", { bounds: true }) } }] }) });
        b.json.accessors.push({ componentType: 5126, count: keys, type: "SCALAR", min: [0], max: [1] });
        const input = b.json.accessors.length - 1;
        b.json.accessors.push({ componentType: 5121, normalized: true, count: keys, type: "VEC4" });
        const output = b.json.accessors.length - 1;
        (b.json as Record<string, unknown>).animations = [
          { samplers: [{ input, output, interpolation: "LINEAR" }], channels: Array.from({ length: channels }, () => ({ sampler: 0, target: { node, path: "rotation" } })) },
        ];
      });
    // 9M keyframes reused by 400 channels: GLTFLoader would copy about 54 GiB of Float32.
    const bomb = animated(9_000_000, 400);
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    expect(reason(bomb)).toStartWith("over-budget");
    expect(reason(bomb)).toContain("keyframes");
    // The review's measured case: 500k keyframes by 40 channels, about 305 MiB of copies.
    expect(reason(animated(500_000, 40))).toContain("keyframes");
    expect(reason(animated(30, VRM_BUDGETS.animationChannels + 1))).toContain("animation channels");
    const fine = validateVrm(animated(30, 4));
    expect(fine.ok && fine.stats.animationChannels).toBe(4);
    expect(fine.ok && fine.stats.animationBytes).toBe(4 * (30 + 30 * 4) * 4);
    expect(reason(vrm((b) => ((b.json as Record<string, unknown>).animations = [{ samplers: [], channels: [{ sampler: 0, target: { path: "rotation" } }] }])))).toStartWith("malformed");
  });

  test("passes a model within every budget, and reports what it measured", () => {
    const check = validateVrm(vrm((b) => {
      const p = b.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", { bounds: true });
      b.node({ mesh: b.mesh({ primitives: [{ attributes: { POSITION: p }, targets: [{ POSITION: p }] }] }) });
      (b.json as Record<string, unknown>).images = [{ bufferView: b.view(pngHeader(512, 256)), mimeType: "image/png" }];
      (b.json as Record<string, unknown>).textures = [{ source: 0 }, { source: 0 }];
    }));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.stats.vertices).toBe(3);
    expect(check.stats.accessorBytes).toBe(36);
    expect(check.stats.morphElements).toBe(3);
    expect(check.stats.imagePixels).toBe(512 * 256 * 2);
  });

  test("a title or an author loses the characters that could reorder or hide what the screen shows", () => {
    const check = validateVrm(vrm((b) => {
      const meta = (b.json.extensions.VRMC_vrm as { meta: Record<string, unknown> }).meta;
      meta.name = "Al\u202Eahpla\u200B\u2066x\u2069";
      meta.authors = ["Sam\u200F"];
    }));
    expect(check.ok && check.meta.title).toBe("Alahplax");
    expect(check.ok && check.meta.author).toBe("Sam");
  });
});

function tinyGltf(): Uint8Array {
  const b = new GltfBuilder("test");
  b.node({ mesh: b.mesh({ primitives: [{ attributes: { POSITION: b.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", { bounds: true }) } }] }) });
  return b.toGlb();
}

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

/** Alpha's placeholder with one small glTF clip added (keyframes with no bufferView: zero-filled). */
function animatedPlaceholder(): Uint8Array {
  return withJson(bytes(), (json) => {
    const accessors = json.accessors as Record<string, unknown>[];
    accessors.push({ componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] });
    accessors.push({ componentType: 5126, count: 2, type: "VEC4" });
    json.animations = [{ samplers: [{ input: accessors.length - 2, output: accessors.length - 1 }], channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }] }];
  });
}

describe("the loader never sees a glTF clip", () => {
  test("the clips leave the JSON and nothing else changes", async () => {
    const animated = animatedPlaceholder();
    const check = validateVrm(animated);
    expect(check.ok && check.stats.animationChannels).toBe(1);
    const stripped = withoutAnimations(animated);
    expect(glbJson(stripped).animations).toBeUndefined();
    expect(validateVrm(stripped).ok).toBe(true);
    // The JSON is all that changed: the BIN chunk is byte for byte the same.
    const tail = (b: Uint8Array) => b.subarray(20 + new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(12, true));
    expect(Buffer.from(tail(stripped)).equals(Buffer.from(tail(animated)))).toBe(true);
    const { animations, ...rest } = glbJson(animated);
    expect(animations).toBeDefined();
    expect(differences(glbJson(stripped), rest)).toEqual([]);
    const loader = new GLTFLoader();
    expect((await loader.parseAsync(buffer(animated), "")).animations.length).toBe(1);
    expect((await loader.parseAsync(buffer(stripped), "")).animations.length).toBe(0);
    // A file with no clips is handed back as it came.
    const plain = bytes();
    expect(withoutAnimations(plain)).toBe(plain);
  });

  test("the avatar's scene loads a model with clips, and hands the loader none", async () => {
    const seen: unknown[] = [];
    const parseAsync = GLTFLoader.prototype.parseAsync;
    GLTFLoader.prototype.parseAsync = function (data, path) {
      seen.push(glbJson(new Uint8Array(data as ArrayBuffer)).animations);
      return parseAsync.call(this, data, path);
    };
    try {
      const scene = new AvatarScene(document.createElement("canvas"), { createRenderer: fakeRenderer().create });
      const loaded = await scene.load(buffer(animatedPlaceholder()));
      expect(loaded.meta.placeholder).toBe(true);
      scene.dispose();
    } finally {
      GLTFLoader.prototype.parseAsync = parseAsync;
    }
    expect(seen).toEqual([undefined]);
  });
});

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
