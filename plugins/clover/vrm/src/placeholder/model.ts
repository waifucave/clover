// Alpha's PLACEHOLDER avatar, built in code: a small anime-style figure in Alpha's lavender and mint, made of
// simple solids parented to humanoid bones, with a face whose morph targets carry the five mouth shapes, the
// blinks, happy and surprised; MToon materials; twin tails on spring bones. It stands in until the owned
// model the spec asks for (open question 26) exists, and says so in its own metadata, which the renderer's
// credit line shows. Deterministic: the committed `plugins/alpha/assets/alpha.vrm` is exactly this function's
// output (`placeholder.test.ts`).

import { GltfBuilder } from "../vrm/glb";
import { decalDelta, decalShape, ellipse, ellipsoid, merge, tube, type Decal, type Shape, type Surface, type Vec3 } from "./shapes";

export const PLACEHOLDER_NAME = "Alpha (placeholder model)";

type Rgb = readonly [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** sRGB to linear, as glTF colour factors are. */
const linear = (c: Rgb): Rgb => c.map((v) => round6(v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as unknown as Rgb;
/** Six decimals: a colour prints the same wherever the model is built. */
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

const PALETTE = {
  skin: ["#FFE0CF", "#EDB2A0"],
  hair: ["#B8A5FF", "#7C66DB"],
  dress: ["#FBFAFF", "#D5CCF3"],
  skirt: ["#8E7BF2", "#5E4AC8"],
  mint: ["#5ED6B4", "#2F9F86"],
  stocking: ["#3E3560", "#251E3E"],
  shoe: ["#4D3F94", "#2E2563"],
  eye: ["#2A2145", "#2A2145"],
  iris: ["#3FC7A4", "#2A8F78"],
  pupil: ["#17112D", "#17112D"],
  light: ["#FFFFFF", "#FFFFFF"],
  mouth: ["#6A2840", "#6A2840"],
  blush: ["#FFB7C8", "#FFB7C8"],
  brow: ["#6F5BC6", "#6F5BC6"],
} as const satisfies Record<string, readonly [string, string]>;

type Paint = keyof typeof PALETTE;
const OUTLINE = hex("#3B2E6E");

/** The morph targets on the face, in order; expressions bind them by index. */
export const FACE_TARGETS = ["aa", "ih", "ou", "ee", "oh", "blinkLeft", "blinkRight", "happy", "surprised"] as const;

// The skeleton, in metres, model facing +Z, its left at +X. Every node is unrotated (VRM 1.0's rest pose).
const BONES: readonly [name: string, parent: string | null, at: Vec3][] = [
  ["hips", null, [0, 0.74, 0]],
  ["spine", "hips", [0, 0.84, 0]],
  ["chest", "spine", [0, 0.96, 0]],
  ["neck", "chest", [0, 1.075, 0]],
  ["head", "neck", [0, 1.13, 0]],
  ["leftShoulder", "chest", [0.03, 1.04, 0]],
  ["leftUpperArm", "leftShoulder", [0.095, 1.035, 0]],
  ["leftLowerArm", "leftUpperArm", [0.3, 1.035, 0]],
  ["leftHand", "leftLowerArm", [0.48, 1.035, 0]],
  ["rightShoulder", "chest", [-0.03, 1.04, 0]],
  ["rightUpperArm", "rightShoulder", [-0.095, 1.035, 0]],
  ["rightLowerArm", "rightUpperArm", [-0.3, 1.035, 0]],
  ["rightHand", "rightLowerArm", [-0.48, 1.035, 0]],
  ["leftUpperLeg", "hips", [0.075, 0.7, 0]],
  ["leftLowerLeg", "leftUpperLeg", [0.075, 0.4, 0]],
  ["leftFoot", "leftLowerLeg", [0.075, 0.08, 0]],
  ["rightUpperLeg", "hips", [-0.075, 0.7, 0]],
  ["rightLowerLeg", "rightUpperLeg", [-0.075, 0.4, 0]],
  ["rightFoot", "rightLowerLeg", [-0.075, 0.08, 0]],
];

const HEAD: Surface = { center: [0, 1.255, 0.004], radius: 0.13 };

export function makePlaceholderVrm(): Uint8Array {
  const b = new GltfBuilder("Clover placeholder avatar (plugins/clover/vrm/src/placeholder/model.ts)");
  const world = new Map<string, Vec3>();
  const nodes = new Map<string, number>();
  for (const [name, parent, at] of BONES) {
    const p = parent ? world.get(parent)! : ([0, 0, 0] as Vec3);
    const index = b.node({ name, translation: [at[0] - p[0], at[1] - p[1], at[2] - p[2]] }, parent ? nodes.get(parent) : undefined);
    world.set(name, at);
    nodes.set(name, index);
  }

  // Materials, MToon with a fallback colour for viewers without it.
  const materials = new Map<Paint, number>();
  const decalPaints: Paint[] = ["eye", "iris", "pupil", "light", "mouth", "blush", "brow"];
  for (const paint of Object.keys(PALETTE) as Paint[]) {
    const [base, shade] = PALETTE[paint];
    const decal = decalPaints.includes(paint);
    materials.set(
      paint,
      b.material({
        name: paint,
        pbrMetallicRoughness: { baseColorFactor: [...linear(hex(base)), 1], metallicFactor: 0, roughnessFactor: 1 },
        doubleSided: false,
        extensions: {
          VRMC_materials_mtoon: {
            specVersion: "1.0",
            shadeColorFactor: linear(hex(shade)),
            shadingShiftFactor: decal ? -1 : -0.05,
            shadingToonyFactor: 0.92,
            giEqualizationFactor: 0.9,
            parametricRimColorFactor: decal ? [0, 0, 0] : linear(hex("#FFFFFF")).map((v) => round6(v * 0.12)),
            parametricRimFresnelPowerFactor: 4,
            parametricRimLiftFactor: 0,
            outlineWidthMode: decal ? "none" : "worldCoordinates",
            outlineWidthFactor: decal ? 0 : 0.0016,
            outlineColorFactor: linear(OUTLINE),
            outlineLightingMixFactor: 0.6,
            renderQueueOffsetNumber: decal ? 1 : 0,
          },
        },
      }),
    );
  }
  b.use("VRMC_materials_mtoon");

  /** One mesh node under `bone`: each paint a primitive, every point relative to the bone. */
  const part = (bone: string, name: string, pieces: [Paint, Shape][], targets?: number[][][]): number => {
    const origin = world.get(bone)!;
    const primitives = pieces.map(([paint, shape], p) => {
      const local = shape.positions.map((v, i) => v - origin[i % 3]!);
      const primitive: Record<string, unknown> = {
        attributes: {
          POSITION: b.floats(local, "VEC3", { bounds: true }),
          NORMAL: b.floats(shape.normals, "VEC3"),
        },
        indices: b.indices(shape.indices),
        material: materials.get(paint),
      };
      if (targets) primitive.targets = targets[p]!.map((deltas) => ({ POSITION: b.floats(deltas, "VEC3", { bounds: true }) }));
      return primitive;
    });
    const mesh: Record<string, unknown> = { name, primitives };
    if (targets) mesh.extras = { targetNames: [...FACE_TARGETS] };
    return b.node({ name, mesh: b.mesh(mesh) }, nodes.get(bone));
  };

  // The head and the hair.
  const hc = HEAD.center;
  part("head", "Head", [["skin", ellipsoid(hc, [0.13, 0.127, 0.128], 22, 32)]]);
  const fringe = (x: number) => 0.036 + 0.011 * Math.cos(x * 95);
  const hairCap = ellipsoid([hc[0], hc[1] + 0.008, hc[2] - 0.004], [0.143, 0.14, 0.142], 40, 64, ([x, y, z]) => !(z > -0.03 && y < fringe(x) - 0.008));
  const sideLocks = [1, -1].map((s) => tube([s * 0.118, hc[1] + 0.03, 0.035], [s * 0.112, hc[1] - 0.1, 0.05], 0.024, 0.012, 16));
  const backHair = tube([0, hc[1] - 0.01, -0.07], [0, hc[1] - 0.27, -0.085], 0.125, 0.095, 26, 0.5);
  part("head", "Hair", [["hair", merge(hairCap, ...sideLocks, backHair)]]);
  // Clover hair ties: four mint leaves around a darker heart, one on each tail.
  const tie = (s: number) => {
    const c: Vec3 = [s * 0.128, hc[1] + 0.05, -0.03];
    const leaves = [
      [0, 0.016],
      [0, -0.016],
      [0.016, 0],
      [-0.016, 0],
    ].map(([dy, dz]) => ellipsoid([c[0] + s * 0.012, c[1] + dy!, c[2] + dz!], [0.008, 0.013, 0.013], 8, 12));
    return merge(...leaves);
  };
  part("head", "HairTies", [["mint", merge(tie(1), tie(-1))]]);

  // The face: one mesh, a primitive per paint, every primitive carrying every face target.
  const face = faceParts();
  const faceNode = part(
    "head",
    "Face",
    face.map((f) => [f.paint, merge(...f.decals.map((d) => decalShape(HEAD, d)))]),
    face.map((f) => FACE_TARGETS.map((target) => f.decals.flatMap((d) => decalDelta(HEAD, d, morphDecal(f.paint, d, target))))),
  );

  // The body.
  part("neck", "Neck", [["skin", tube([0, 1.155, -0.004], [0, 1.06, -0.004], 0.029, 0.031, 18)]]);
  part("chest", "Bodice", [
    ["dress", tube([0, 1.07, 0], [0, 0.86, 0], 0.074, 0.064, 26, 0.72, "flat")],
    ["mint", merge(tube([0, 1.074, 0], [0, 1.05, 0], 0.084, 0.094, 26, 0.74, "flat"), ellipsoid([0.02, 1.032, 0.062], [0.018, 0.011, 0.008], 8, 12), ellipsoid([-0.02, 1.032, 0.062], [0.018, 0.011, 0.008], 8, 12))],
  ]);
  part("hips", "Skirt", [
    ["skirt", tube([0, 0.875, 0], [0, 0.6, 0], 0.066, 0.19, 30, 0.84, "flat")],
    ["mint", tube([0, 0.62, 0], [0, 0.598, 0], 0.183, 0.193, 30, 0.84, "flat")],
  ]);
  for (const s of [1, -1]) {
    const side = s > 0 ? "left" : "right";
    part(`${side}UpperArm`, `${side}Sleeve`, [
      ["dress", ellipsoid([s * 0.108, 1.035, 0], [0.042, 0.034, 0.035], 12, 18)],
      ["skin", tube([s * 0.12, 1.035, 0], [s * 0.3, 1.035, 0], 0.024, 0.021, 16)],
    ]);
    part(`${side}LowerArm`, `${side}Forearm`, [["skin", tube([s * 0.3, 1.035, 0], [s * 0.465, 1.035, 0], 0.021, 0.018, 16)]]);
    part(`${side}Hand`, `${side}Hand`, [["skin", ellipsoid([s * 0.5, 1.033, 0.002], [0.034, 0.02, 0.028], 10, 16)]]);
    part(`${side}UpperLeg`, `${side}Thigh`, [["skin", tube([s * 0.075, 0.72, 0], [s * 0.075, 0.42, 0], 0.05, 0.04, 18)]]);
    part(`${side}LowerLeg`, `${side}Stocking`, [["stocking", tube([s * 0.075, 0.42, 0], [s * 0.075, 0.1, 0], 0.041, 0.031, 18)]]);
    part(`${side}Foot`, `${side}Shoe`, [["shoe", ellipsoid([s * 0.075, 0.05, 0.028], [0.044, 0.04, 0.074], 10, 18)]]);
  }

  // Twin tails on spring bones: a chain of joints under the head, a tapered segment hung from each.
  const springs: Record<string, unknown>[] = [];
  for (const s of [1, -1]) {
    const side = s > 0 ? "Left" : "Right";
    const points: Vec3[] = [
      [s * 0.13, hc[1] + 0.045, -0.035],
      [s * 0.165, hc[1] - 0.1, -0.06],
      [s * 0.18, hc[1] - 0.26, -0.075],
      [s * 0.172, hc[1] - 0.41, -0.07],
    ];
    const radii = [0.042, 0.036, 0.027, 0.008];
    const joints: number[] = [];
    let parentNode = nodes.get("head")!;
    let parentAt = world.get("head")!;
    points.forEach((p, i) => {
      const name = `tail${side}${i}`;
      const node = b.node({ name, translation: [p[0] - parentAt[0], p[1] - parentAt[1], p[2] - parentAt[2]] }, parentNode);
      nodes.set(name, node);
      world.set(name, p);
      joints.push(node);
      parentNode = node;
      parentAt = p;
    });
    for (let i = 0; i < points.length - 1; i++) {
      part(`tail${side}${i}`, `tail${side}Segment${i}`, [["hair", tube(points[i]!, points[i + 1]!, radii[i]!, radii[i + 1]!, 16)]]);
    }
    springs.push({
      name: `Tail${side}`,
      joints: joints.map((node, i) => ({ node, hitRadius: radii[i]! * 0.6, stiffness: 1.1, gravityPower: 0.35, gravityDir: [0, -1, 0], dragForce: 0.45 })),
      colliderGroups: [0],
    });
  }
  b.json.extensions.VRMC_springBone = {
    specVersion: "1.0",
    colliders: [
      { node: nodes.get("head"), shape: { sphere: { offset: [hc[0], hc[1] - 1.13, hc[2]], radius: 0.13 } } },
      { node: nodes.get("chest"), shape: { capsule: { offset: [0, 0.08, -0.01], radius: 0.075, tail: [0, -0.12, -0.01] } } },
    ],
    colliderGroups: [{ name: "Body", colliders: [0, 1] }],
    springs,
  };
  b.use("VRMC_springBone");

  // VRM 1.0: what it is, whose it is, its bones and its expressions.
  const humanBones: Record<string, { node: number }> = {};
  for (const [name] of BONES) humanBones[name] = { node: nodes.get(name)! };
  const bind = (...indices: number[]) => ({
    morphTargetBinds: indices.map((index) => ({ node: faceNode, index, weight: 1 })),
    isBinary: false,
    overrideBlink: "none",
    overrideLookAt: "none",
    overrideMouth: "none",
  });
  const at = (name: (typeof FACE_TARGETS)[number]) => FACE_TARGETS.indexOf(name);
  b.json.extensions.VRMC_vrm = {
    specVersion: "1.0",
    meta: {
      name: PLACEHOLDER_NAME,
      version: "0.1.0-placeholder",
      authors: ["Clover contributors"],
      copyrightInformation: "A placeholder generated by Clover's code (plugins/clover/vrm/src/placeholder/model.ts). Replace it with Alpha's owned model before release.",
      licenseUrl: "https://vrm.dev/licenses/1.0/",
      avatarPermission: "everyone",
      allowExcessivelyViolentUsage: false,
      allowExcessivelySexualUsage: false,
      commercialUsage: "corporation",
      allowPoliticalOrReligiousUsage: false,
      allowAntisocialOrHateUsage: false,
      creditNotation: "unnecessary",
      allowRedistribution: true,
      modification: "allowModificationRedistribution",
      otherLicenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    },
    humanoid: { humanBones },
    expressions: {
      preset: {
        aa: bind(at("aa")),
        ih: bind(at("ih")),
        ou: bind(at("ou")),
        ee: bind(at("ee")),
        oh: bind(at("oh")),
        blink: bind(at("blinkLeft"), at("blinkRight")),
        blinkLeft: bind(at("blinkLeft")),
        blinkRight: bind(at("blinkRight")),
        happy: { ...bind(at("happy")), overrideBlink: "block" },
        surprised: { ...bind(at("surprised")), overrideBlink: "block" },
      },
    },
  };
  b.use("VRMC_vrm");
  return b.toGlb();
}

interface FacePart {
  paint: Paint;
  decals: Decal[];
}

const EYE = { x: 0.047, y: 1.238, rx: 0.016, ry: 0.021 };
const MOUTH = { x: 0, y: 1.19, rx: 0.012, ry: 0.0032 };

function faceParts(): FacePart[] {
  const eyes = (rx: number, ry: number, dy: number, lift: number): Decal[] =>
    [1, -1].map((s) => ({ points: ellipse(s * EYE.x, EYE.y + dy, rx, ry), lift }));
  return [
    { paint: "eye", decals: eyes(EYE.rx, EYE.ry, 0, 0.0012) },
    { paint: "iris", decals: eyes(0.0122, 0.0158, -0.0025, 0.0018) },
    { paint: "pupil", decals: eyes(0.0055, 0.0075, -0.0035, 0.0023) },
    {
      paint: "light",
      decals: [1, -1].flatMap((s) => [
        { points: ellipse(s * EYE.x - 0.0055, EYE.y + 0.0085, 0.0046, 0.0046, 16), lift: 0.0028 },
        { points: ellipse(s * EYE.x + 0.0058, EYE.y - 0.009, 0.0021, 0.0021, 12), lift: 0.0028 },
      ]),
    },
    { paint: "mouth", decals: [{ points: ellipse(MOUTH.x, MOUTH.y, MOUTH.rx, MOUTH.ry, 28), lift: 0.0012 }] },
    { paint: "blush", decals: [1, -1].map((s) => ({ points: ellipse(s * 0.074, 1.205, 0.017, 0.0085, 20), lift: 0.0008 })) },
    { paint: "brow", decals: [1, -1].map((s) => ({ points: ellipse(s * 0.048, 1.276, 0.0145, 0.0026, 16), lift: 0.0012 })) },
  ];
}

/** Where a face target moves a decal's points, in the front view. Untouched parts stay where they are. */
function morphDecal(paint: Paint, decal: Decal, target: (typeof FACE_TARGETS)[number]): [number, number][] {
  const [cx, cy] = decal.points[0]!;
  const left = cx > 0;
  const isEye = paint === "eye" || paint === "iris" || paint === "pupil" || paint === "light";
  const same = decal.points.map(([x, y]) => [x, y] as [number, number]);
  const eyeX = left ? EYE.x : -EYE.x;
  switch (target) {
    case "aa":
    case "ih":
    case "ou":
    case "ee":
    case "oh": {
      if (paint !== "mouth") return same;
      const shapes: Record<typeof target, readonly [number, number]> = { aa: [1.25, 5.2], ih: [1.45, 2.2], ou: [0.6, 3.3], ee: [1.6, 2.4], oh: [0.95, 4.2] };
      const [sx, sy] = shapes[target];
      // The jaw opens downward: the top lip moves less than the bottom.
      const drop = (sy - 1) * MOUTH.ry * 0.55;
      return decal.points.map(([x, y]) => [cx + (x - cx) * sx, cy + (y - cy) * sy - drop]);
    }
    case "blinkLeft":
    case "blinkRight": {
      if (!isEye || left !== (target === "blinkLeft")) return same;
      // Closed: the eye folds onto a gentle downward arc just under its middle; the highlights vanish into it.
      const lid = EYE.y - 0.005;
      return decal.points.map(([x, y]) => {
        const u = (x - eyeX) / EYE.rx;
        const squeezedX = paint === "light" ? cx + (x - cx) * 0.05 : x;
        return [squeezedX, lid + (y - lid) * 0.06 - 0.0035 * Math.max(0, 1 - u * u)];
      });
    }
    case "happy": {
      if (isEye) {
        // ^ ^: an upward arc.
        const lid = EYE.y - 0.002;
        return decal.points.map(([x, y]) => {
          const u = (x - eyeX) / EYE.rx;
          const squeezedX = paint === "light" ? cx + (x - cx) * 0.05 : x;
          return [squeezedX, lid + (y - lid) * 0.07 + 0.0065 * Math.max(0, 1 - u * u)];
        });
      }
      if (paint === "mouth") {
        // A smile: wider, the corners up, a little open in the middle.
        return decal.points.map(([x, y]) => {
          const u = (x - cx) / MOUTH.rx;
          return [cx + (x - cx) * 1.35, cy + (y - cy) * 1.9 + 0.0042 * u * u - 0.002];
        });
      }
      if (paint === "brow") return decal.points.map(([x, y]) => [x, y + 0.004]);
      return same;
    }
    case "surprised": {
      if (isEye) return decal.points.map(([x, y]) => [eyeX + (x - eyeX) * 1.1, EYE.y + (y - EYE.y) * 1.14]);
      if (paint === "mouth") return decal.points.map(([x, y]) => [cx + (x - cx) * 0.55, cy + (y - cy) * 3.6 - 0.004]);
      if (paint === "brow") return decal.points.map(([x, y]) => [x, y + 0.009]);
      return same;
    }
  }
}
