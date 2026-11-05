// Alpha's placeholder Live2D model, made in code (decision 87: until open question 26 picks Alpha's real model). A
// bust of flat shapes in Alpha's lilac: back hair, shoulders, neck, face, blush, two eyes that blink, a mouth that opens
// and widens or rounds for the vowels, and a fringe; the shoulders rise with breath. Every mesh is a triangle fan, its
// keyforms the shapes at each key of its parameters. Written as a version 3 `.moc3` with Mochi2D's own `writeMoc`,
// which refuses anything the official check would, and a 64×64 texture of flat colour cells.
//
// Deterministic: the same bytes on every run (`bun run placeholder` writes them to plugins/alpha/assets/live2d/, and a
// test checks the committed files are these).

import { validateMoc, writeMoc, type MocData } from "@waifucave/mochi2d/headless";
import { encodePng } from "./png";

const f32 = Math.fround;

/** The parameters, in file order; each has one binding, keyed at its ends. */
export const PLACEHOLDER_PARAMETERS = [
  { id: "ParamEyeLOpen", min: 0, max: 1, def: 1, keys: [0, 1] },
  { id: "ParamEyeROpen", min: 0, max: 1, def: 1, keys: [0, 1] },
  { id: "ParamMouthOpenY", min: 0, max: 1, def: 0, keys: [0, 1] },
  { id: "ParamMouthForm", min: -1, max: 1, def: 0, keys: [-1, 1] },
  { id: "ParamBreath", min: 0, max: 1, def: 0, keys: [0, 1] },
] as const;

/** Bands: 0 binds nothing; 1 the left eye; 2 the right eye; 3 the mouth (open innermost, then form); 4 breath. */
const BANDS: number[][] = [[], [0], [1], [2, 3], [4]];

/** The texture's colour cells (4 × 4 cells of 16 px), by name. */
const PALETTE = {
  hair: [0x4b, 0x3a, 0x78],
  hairShade: [0x3a, 0x2c, 0x5f],
  body: [0xb9, 0xa6, 0xff],
  collar: [0xf4, 0xf0, 0xff],
  skin: [0xfb, 0xe6, 0xda],
  neck: [0xf0, 0xd2, 0xc4],
  blush: [0xf6, 0xa8, 0xbb],
  eye: [0x2e, 0x23, 0x50],
  mouth: [0x8a, 0x2e, 0x4a],
} as const;
type Colour = keyof typeof PALETTE;
const CELLS = Object.keys(PALETTE) as Colour[];
const TEXTURE = 64;
const CELL = 16;

function uvOf(colour: Colour): [number, number] {
  const i = CELLS.indexOf(colour);
  const col = i % 4;
  const row = Math.floor(i / 4);
  return [(col * CELL + CELL / 2) / TEXTURE, (row * CELL + CELL / 2) / TEXTURE];
}

export function placeholderTexture(): Uint8Array {
  const rgba = new Uint8Array(TEXTURE * TEXTURE * 4);
  for (let y = 0; y < TEXTURE; y++) {
    for (let x = 0; x < TEXTURE; x++) {
      const i = Math.floor(y / CELL) * 4 + Math.floor(x / CELL);
      const colour = CELLS[i];
      const at = (y * TEXTURE + x) * 4;
      if (colour) {
        rgba.set(PALETTE[colour], at);
        rgba[at + 3] = 255;
      }
    }
  }
  return encodePng(TEXTURE, TEXTURE, rgba);
}

type Outline = [number, number][];

function ellipse(cx: number, cy: number, rx: number, ry: number, n = 24): Outline {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as [number, number];
  });
}

/** A fan around `centre`: the outline must be star-shaped from it. Positions are the centre, then the outline. The
 *  shapes here are drawn y up; a `.moc3` stores a top-level mesh's positions y down (the runtime turns them over), so
 *  each y is negated on the way in. */
function fan(centre: [number, number], outline: Outline): { positions: number[]; triangles: number[] } {
  const positions = [centre, ...outline].flatMap(([x, y]) => [x, -y]);
  const triangles: number[] = [];
  for (let i = 0; i < outline.length; i++) triangles.push(0, 1 + i, 1 + ((i + 1) % outline.length));
  return { positions: positions.map(f32), triangles };
}

interface Mesh {
  id: string;
  colour: Colour;
  band: number;
  drawOrder: number;
  /** One outline per keyform, in the band's keyform order; every outline has the same number of points. */
  keyforms: Outline[];
  centre?: (k: number) => [number, number];
}

function centroid(o: Outline): [number, number] {
  return [o.reduce((s, p) => s + p[0], 0) / o.length, o.reduce((s, p) => s + p[1], 0) / o.length];
}

/** The fringe: the top of an ellipse, its lower edge a row of points. Star-shaped from a point above the edge. */
function fringe(): Outline {
  const top: Outline = [];
  for (let i = 0; i <= 16; i++) {
    const a = (Math.PI * i) / 16;
    top.push([0.235 * Math.cos(a), 0.14 + 0.17 * Math.sin(a)]);
  }
  // Back along the bottom, from the left: points dipping between the locks.
  const bottom: Outline = [];
  for (let i = 0; i <= 8; i++) {
    const x = -0.235 + (0.47 * i) / 8;
    bottom.push([x, i % 2 === 0 ? 0.13 : 0.085]);
  }
  return [...top, ...bottom.slice(1, -1)];
}

function shoulders(lift: number): Outline {
  return [
    [-0.4, -0.5],
    [0.4, -0.5],
    [0.36, -0.3 + lift],
    [0.22, -0.215 + lift],
    [0.08, -0.19 + lift],
    [-0.08, -0.19 + lift],
    [-0.22, -0.215 + lift],
    [-0.36, -0.3 + lift],
  ];
}

function collar(lift: number): Outline {
  return [
    [-0.1, -0.2 + lift],
    [0.1, -0.2 + lift],
    [0.05, -0.27 + lift],
    [0, -0.3 + lift],
    [-0.05, -0.27 + lift],
  ];
}

/** The mouth at (open, form): closed is a line, open an oval; form −1 rounds it (o, u), +1 widens it (i, e). */
function mouth(open: number, form: number): Outline {
  const rx = form < 0 ? (open ? 0.026 : 0.02) : open ? 0.05 : 0.044;
  const ry = open ? (form < 0 ? 0.042 : 0.026) : 0.005;
  return ellipse(0, -0.085 - (open ? ry * 0.5 : 0), rx, ry, 20);
}

function eye(cx: number, open: number): Outline {
  return ellipse(cx, 0.025, 0.036, open ? 0.052 : 0.006, 20);
}

export function placeholderMeshes(): Mesh[] {
  return [
    { id: "ArtMeshHairBack", colour: "hairShade", band: 0, drawOrder: 300, keyforms: [ellipse(0, 0.06, 0.28, 0.33, 28)] },
    { id: "ArtMeshBody", colour: "body", band: 4, drawOrder: 400, keyforms: [shoulders(0), shoulders(0.008)], centre: (k) => [0, -0.38 + 0.008 * k] },
    { id: "ArtMeshCollar", colour: "collar", band: 4, drawOrder: 410, keyforms: [collar(0), collar(0.008)] },
    { id: "ArtMeshNeck", colour: "neck", band: 0, drawOrder: 420, keyforms: [[[-0.055, -0.21], [0.055, -0.21], [0.055, -0.1], [-0.055, -0.1]]] },
    { id: "ArtMeshFace", colour: "skin", band: 0, drawOrder: 500, keyforms: [ellipse(0, 0.04, 0.2, 0.23, 32)] },
    { id: "ArtMeshCheekL", colour: "blush", band: 0, drawOrder: 510, keyforms: [ellipse(-0.115, -0.035, 0.035, 0.017, 16)] },
    { id: "ArtMeshCheekR", colour: "blush", band: 0, drawOrder: 510, keyforms: [ellipse(0.115, -0.035, 0.035, 0.017, 16)] },
    { id: "ArtMeshEyeL", colour: "eye", band: 1, drawOrder: 600, keyforms: [eye(-0.075, 0), eye(-0.075, 1)] },
    { id: "ArtMeshEyeR", colour: "eye", band: 2, drawOrder: 600, keyforms: [eye(0.075, 0), eye(0.075, 1)] },
    // Innermost first: (open 0, form −1), (open 1, form −1), (open 0, form 1), (open 1, form 1).
    { id: "ArtMeshMouth", colour: "mouth", band: 3, drawOrder: 600, keyforms: [mouth(0, -1), mouth(1, -1), mouth(0, 1), mouth(1, 1)] },
    { id: "ArtMeshFringe", colour: "hair", band: 0, drawOrder: 700, keyforms: [fringe()], centre: () => [0, 0.22] },
  ];
}

export function placeholderMocData(): MocData {
  const meshes = placeholderMeshes();
  const params = PLACEHOLDER_PARAMETERS;
  const keys: number[] = [];
  const bindingFirstKey: number[] = [];
  const bindingKeyCount: number[] = [];
  for (const p of params) {
    bindingFirstKey.push(keys.length);
    bindingKeyCount.push(p.keys.length);
    keys.push(...p.keys);
  }
  const bindingIndices: number[] = [];
  const bandFirst: number[] = [];
  const bandCount: number[] = [];
  for (const b of BANDS) {
    bandFirst.push(bindingIndices.length);
    bandCount.push(b.length);
    bindingIndices.push(...b);
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const triangles: number[] = [];
  const m = {
    ids: [] as string[],
    band: [] as number[],
    firstKeyform: [] as number[],
    keyformCount: [] as number[],
    vertexCount: [] as number[],
    firstUv: [] as number[],
    firstTriangleIndex: [] as number[],
    triangleIndexCount: [] as number[],
  };
  const kf = { opacity: [] as number[], drawOrder: [] as number[], firstPosition: [] as number[] };
  for (const mesh of meshes) {
    const expected = BANDS[mesh.band]!.reduce((n, b) => n * params[b]!.keys.length, 1);
    if (mesh.keyforms.length !== expected) throw new Error(`${mesh.id}: ${mesh.keyforms.length} keyforms, its band has ${expected}`);
    let vertexCount = 0;
    m.ids.push(mesh.id);
    m.band.push(mesh.band);
    m.firstKeyform.push(kf.opacity.length);
    m.keyformCount.push(mesh.keyforms.length);
    m.firstUv.push(uvs.length / 2);
    m.firstTriangleIndex.push(triangles.length);
    mesh.keyforms.forEach((outline, k) => {
      const built = fan(mesh.centre?.(k) ?? centroid(outline), outline);
      if (k === 0) {
        vertexCount = built.positions.length / 2;
        const [u, v] = uvOf(mesh.colour);
        for (let i = 0; i < vertexCount; i++) uvs.push(f32(u), f32(v));
        triangles.push(...built.triangles);
        m.triangleIndexCount.push(built.triangles.length);
      } else if (built.positions.length / 2 !== vertexCount) throw new Error(`${mesh.id}: keyform ${k} has another vertex count`);
      kf.opacity.push(1);
      kf.drawOrder.push(mesh.drawOrder);
      kf.firstPosition.push(positions.length);
      positions.push(...built.positions);
    });
    m.vertexCount.push(vertexCount);
  }
  const n = meshes.length;
  const i32 = (a: number[]) => Int32Array.from(a);
  const fl = (a: number[]) => Float32Array.from(a.map(f32));
  const zeros = (len: number) => new Int32Array(len);
  const ones = (len: number) => new Int32Array(len).fill(1);

  return {
    canvas: { pixelsPerUnit: f32(1024), originX: f32(512), originY: f32(512), width: f32(1024), height: f32(1024), flags: 0 },
    parts: { ids: ["PartAlpha"], band: i32([0]), firstKeyform: i32([0]), keyformCount: i32([1]), initiallyVisible: ones(1), enabled: ones(1), parent: i32([-1]) },
    deformers: { ids: [], band: zeros(0), visible: zeros(0), enabled: zeros(0), part: zeros(0), parent: zeros(0), kind: zeros(0), kindIndex: zeros(0) },
    warpDeformers: { band: zeros(0), firstKeyform: zeros(0), keyformCount: zeros(0), pointCount: zeros(0), rows: zeros(0), columns: zeros(0), bilinear: zeros(0) },
    rotationDeformers: { band: zeros(0), firstKeyform: zeros(0), keyformCount: zeros(0), baseAngle: new Float32Array(0) },
    artMeshes: {
      ids: m.ids,
      band: i32(m.band),
      firstKeyform: i32(m.firstKeyform),
      keyformCount: i32(m.keyformCount),
      visible: ones(n),
      enabled: ones(n),
      part: zeros(n),
      deformer: i32(new Array(n).fill(-1)),
      texture: zeros(n),
      flags: new Uint8Array(n).fill(4),
      vertexCount: i32(m.vertexCount),
      firstUv: i32(m.firstUv),
      firstTriangleIndex: i32(m.firstTriangleIndex),
      triangleIndexCount: i32(m.triangleIndexCount),
      firstMask: zeros(n),
      maskCount: zeros(n),
    },
    parameters: {
      ids: params.map((p) => p.id),
      max: fl(params.map((p) => p.max)),
      min: fl(params.map((p) => p.min)),
      defaultValue: fl(params.map((p) => p.def)),
      repeat: zeros(params.length),
      decimals: i32(params.map(() => 3)),
      firstBinding: i32(params.map((_, i) => i)),
      bindingCount: ones(params.length),
    },
    partKeyforms: { drawOrder: fl([500]) },
    warpKeyforms: { opacity: new Float32Array(0), firstPosition: zeros(0) },
    rotationKeyforms: { opacity: new Float32Array(0), angle: new Float32Array(0), originX: new Float32Array(0), originY: new Float32Array(0), scale: new Float32Array(0), mirrorX: zeros(0), mirrorY: zeros(0) },
    artMeshKeyforms: { opacity: fl(kf.opacity), drawOrder: fl(kf.drawOrder), firstPosition: i32(kf.firstPosition) },
    keyformPositions: fl(positions),
    bindingIndices: i32(bindingIndices),
    bands: { firstEntry: i32(bandFirst), entryCount: i32(bandCount) },
    parameterBindings: { firstKey: i32(bindingFirstKey), keyCount: i32(bindingKeyCount) },
    keys: fl(keys),
    uvs: fl(uvs),
    triangleIndices: Uint16Array.from(triangles),
    maskEntries: zeros(0),
    drawOrderGroups: { firstObject: i32([0]), objectCount: i32([n]), entryCount: i32([n]), maxDrawOrder: i32([1000]), minDrawOrder: i32([0]) },
    drawOrderGroupObjects: { kind: zeros(n), index: i32(meshes.map((_, i) => i)), nestedGroup: i32(new Array(n).fill(-1)) },
    glues: { ids: [], band: zeros(0), firstKeyform: zeros(0), keyformCount: zeros(0), artMeshA: zeros(0), artMeshB: zeros(0), firstInfo: zeros(0), infoCount: zeros(0) },
    glueInfo: { weight: new Float32Array(0), vertex: new Uint16Array(0) },
    glueKeyforms: { intensity: new Float32Array(0) },
  };
}

export const PLACEHOLDER_VERSION = 3;
export const PLACEHOLDER_NAME = "alpha";

export function placeholderSettings(): Record<string, unknown> {
  return {
    Version: 3,
    FileReferences: { Moc: `${PLACEHOLDER_NAME}.moc3`, Textures: [`${PLACEHOLDER_NAME}.png`] },
    Groups: [
      { Target: "Parameter", Name: "EyeBlink", Ids: ["ParamEyeLOpen", "ParamEyeROpen"] },
      { Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] },
    ],
  };
}

/** The placeholder's files, by name: what plugins/alpha/assets/live2d/ holds. */
export function placeholderFiles(): Record<string, Uint8Array> {
  const data = placeholderMocData();
  const check = validateMoc(data, { version: PLACEHOLDER_VERSION, level: "strict" });
  if (!check.valid) throw new Error(`the placeholder fails its own check: ${check.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  return {
    [`${PLACEHOLDER_NAME}.model3.json`]: new TextEncoder().encode(`${JSON.stringify(placeholderSettings(), null, 2)}\n`),
    [`${PLACEHOLDER_NAME}.moc3`]: writeMoc(data, { version: PLACEHOLDER_VERSION }),
    [`${PLACEHOLDER_NAME}.png`]: placeholderTexture(),
  };
}
