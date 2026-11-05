// What a Live2D avatar may be before Mochi2D draws it (spec §5.5's avatar caps, the same as the VRM renderer's): every
// file read with a running cap on the whole model, every reference inside the model's own folder, and counts held to
// budgets a phone-class GPU and a tab's memory can carry: the drawables, vertices and masks of the `.moc3`, the
// textures' pixels (read from their PNG headers, before any is decoded), the motions' curves and points, the physics'
// settings and particles. A motion's sound is dropped: an avatar plays no audio of its own, and its mouth moves with
// the speech the app plays alone.
//
// Runs without a browser (`mochi2d/headless`), so the core and the tests run the same check the renderer does.

import { parseModelSettings, readMoc, validateMoc, type MocData, type ModelSettings } from "@waifucave/mochi2d/headless";

/** Where a model's files come from: its folder over the network, an archive, or memory. `cap` is the most it may
 *  read for this file; a source that knows a file is larger refuses before reading it (`Live2dRefusal`). */
export interface Live2dSource {
  read(path: string, cap: number): Promise<Uint8Array>;
}

const MiB = 1024 * 1024;

export const LIVE2D_BUDGETS = {
  /** Every file of the model together. */
  totalBytes: 64 * MiB,
  files: 512,
  settingsBytes: 1 * MiB,
  mocBytes: 32 * MiB,
  /** Each motion, expression, physics, pose, display-info, user-data or motion-sync file. */
  jsonBytes: 8 * MiB,
  textures: 8,
  textureSide: 4096,
  /** All textures together: 64 megapixels, 256 MiB once decoded (Mochi2D's own budget scales them past that). */
  texturePixels: 64 * 1024 * 1024,
  drawables: 2_000,
  vertices: 250_000,
  maskEntries: 20_000,
  parameters: 1_000,
  parts: 1_000,
  deformers: 4_000,
  motions: 256,
  motionCurves: 4_000,
  motionPoints: 2_000_000,
  expressions: 128,
  physicsSettings: 256,
  physicsParticles: 4_096,
} as const;

export type Live2dBudgets = { readonly [K in keyof typeof LIVE2D_BUDGETS]: number };

export type Live2dProblemCode =
  | "too-large"
  | "too-many-files"
  | "outside-folder"
  | "missing"
  | "archive"
  | "settings"
  | "moc"
  | "texture"
  | "motion"
  | "physics"
  | "budget";

export class Live2dRefusal extends Error {
  constructor(
    readonly code: Live2dProblemCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "Live2dRefusal";
  }
}

export interface Live2dStats {
  bytes: number;
  files: number;
  mocVersion: number;
  drawables: number;
  vertices: number;
  maskEntries: number;
  parameters: number;
  parts: number;
  deformers: number;
  textures: number;
  texturePixels: number;
  motions: number;
  motionCurves: number;
  motionPoints: number;
  expressions: number;
  physicsSettings: number;
  physicsParticles: number;
}

export interface Live2dModel {
  /** The settings file's path inside the folder. */
  settingsPath: string;
  settings: ModelSettings;
  /** Every file the model needs, by path inside the folder, already read: what the renderer loads, and nothing else
   *  (the settings rewritten without motion sounds). */
  files: Map<string, Uint8Array>;
  /** The parameter ids the `.moc3` has, for the mouth and the eyes. */
  parameterIds: readonly string[];
  stats: Live2dStats;
}

/** A path inside the model's folder, or null for one that leaves it (`..`, an absolute path, a URL, a drive). */
export function insideFolder(base: string, ref: string): string | null {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 1024) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/") || ref.startsWith("\\") || ref.includes("\0")) return null;
  const parts = [...base.split("/").slice(0, -1), ...ref.replace(/\\/g, "/").split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.length ? out.join("/") : null;
}

/** A PNG's size from its header, without decoding it. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function json(bytes: Uint8Array, what: string, code: Live2dProblemCode): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Live2dRefusal(code, `${what} is not a JSON object (${error instanceof Error ? error.message : "unreadable"})`);
  }
}

function meta(file: Record<string, unknown>): Record<string, unknown> {
  const m = file.Meta;
  return typeof m === "object" && m !== null ? (m as Record<string, unknown>) : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The `.moc3`'s counts; vertices summed over the art meshes. */
export function mocCounts(data: MocData): Pick<Live2dStats, "drawables" | "vertices" | "maskEntries" | "parameters" | "parts" | "deformers"> {
  let vertices = 0;
  for (const n of data.artMeshes.vertexCount) vertices += n;
  return {
    drawables: data.artMeshes.ids.length,
    vertices,
    maskEntries: data.maskEntries.length,
    parameters: data.parameters.ids.length,
    parts: data.parts.ids.length,
    deformers: data.deformers.ids.length,
  };
}

/**
 * Reads and checks a model from `source`, starting at its settings file. Throws a `Live2dRefusal` for the first rule
 * it breaks, with words for the log (never the files' contents).
 */
export async function validateLive2d(source: Live2dSource, settingsPath: string, budgets: Live2dBudgets = LIVE2D_BUDGETS): Promise<Live2dModel> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const read = async (path: string, cap: number, what: string): Promise<Uint8Array> => {
    const known = files.get(path);
    if (known) return known;
    if (files.size >= budgets.files) throw new Live2dRefusal("too-many-files", `more than ${budgets.files} files`);
    let bytes: Uint8Array;
    try {
      bytes = await source.read(path, Math.min(cap, budgets.totalBytes - total));
    } catch (error) {
      if (error instanceof Live2dRefusal) throw error;
      throw new Live2dRefusal("missing", `${what} (${path}) could not be read`);
    }
    if (bytes.byteLength > cap) throw new Live2dRefusal("too-large", `${what} is ${bytes.byteLength} bytes, over ${cap}`);
    total += bytes.byteLength;
    if (total > budgets.totalBytes) throw new Live2dRefusal("too-large", `the model is over ${budgets.totalBytes} bytes`);
    files.set(path, bytes);
    return bytes;
  };
  const ref = (value: string, what: string): string => {
    const path = insideFolder(settingsPath, value);
    if (!path) throw new Live2dRefusal("outside-folder", `${what} points outside the model's folder`);
    return path;
  };

  // The settings, parsed by Mochi2D's own reader, then rewritten without motion sounds.
  const settingsBytes = await read(settingsPath, budgets.settingsBytes, "the settings file");
  const raw = json(settingsBytes, "the settings file", "settings");
  let settings: ModelSettings;
  try {
    settings = parseModelSettings(settingsBytes, settingsPath);
  } catch (error) {
    throw new Live2dRefusal("settings", error instanceof Error ? error.message : "unreadable settings");
  }
  const refs = (raw.FileReferences ?? {}) as Record<string, unknown>;
  const motions = (refs.Motions ?? {}) as Record<string, unknown>;
  let soundsDropped = 0;
  for (const group of Object.values(motions)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (entry && typeof entry === "object" && "Sound" in entry) {
        delete (entry as Record<string, unknown>).Sound;
        soundsDropped++;
      }
    }
  }
  for (const entry of settings.motions.flatMap((m) => m.entries)) delete entry.sound;
  if (soundsDropped > 0) files.set(settingsPath, new TextEncoder().encode(JSON.stringify(raw)));

  // The .moc3.
  const mocPath = ref(settings.moc, "the .moc3");
  const mocBytes = await read(mocPath, budgets.mocBytes, "the .moc3");
  let data: MocData;
  let mocVersion: number;
  try {
    const result = readMoc(mocBytes);
    data = result.data;
    mocVersion = result.version;
  } catch (error) {
    throw new Live2dRefusal("moc", error instanceof Error ? error.message : "unreadable .moc3");
  }
  const check = validateMoc(data, { version: mocVersion as 1, level: "strict" });
  if (!check.valid) throw new Live2dRefusal("moc", `the .moc3 fails its check (${check.diagnostics.find((d) => d.severity === "error")?.code ?? "invalid"})`);
  const counts = mocCounts(data);
  for (const key of ["drawables", "vertices", "maskEntries", "parameters", "parts", "deformers"] as const) {
    if (counts[key] > budgets[key]) throw new Live2dRefusal("budget", `${counts[key]} ${key}, over ${budgets[key]}`);
  }

  // Textures: their size from the PNG header, before anything decodes them.
  if (settings.textures.length === 0) throw new Live2dRefusal("texture", "no textures");
  if (settings.textures.length > budgets.textures) throw new Live2dRefusal("budget", `${settings.textures.length} textures, over ${budgets.textures}`);
  let texturePixels = 0;
  for (const [i, texture] of settings.textures.entries()) {
    const bytes = await read(ref(texture, `texture ${i}`), budgets.totalBytes, `texture ${i}`);
    const size = pngSize(bytes);
    if (!size) throw new Live2dRefusal("texture", `texture ${i} is not a PNG`);
    if (size.width === 0 || size.height === 0 || size.width > budgets.textureSide || size.height > budgets.textureSide) {
      throw new Live2dRefusal("texture", `texture ${i} is ${size.width}×${size.height}, over ${budgets.textureSide} a side`);
    }
    texturePixels += size.width * size.height;
  }
  if (texturePixels > budgets.texturePixels) throw new Live2dRefusal("budget", `${texturePixels} texture pixels, over ${budgets.texturePixels}`);

  // Motions: their own meta says how many curves and points; a file that says nothing is counted from its curves.
  const motionEntries = settings.motions.flatMap((m) => m.entries);
  if (motionEntries.length > budgets.motions) throw new Live2dRefusal("budget", `${motionEntries.length} motions, over ${budgets.motions}`);
  let motionCurves = 0;
  let motionPoints = 0;
  for (const [i, entry] of motionEntries.entries()) {
    const file = json(await read(ref(entry.file, `motion ${i}`), budgets.jsonBytes, `motion ${i}`), `motion ${i}`, "motion");
    const curves = Array.isArray(file.Curves) ? file.Curves.length : 0;
    motionCurves += Math.max(curves, count(meta(file).CurveCount));
    // The file's own Meta never wins on its own: the larger of what it says and what it holds (the review's probe: a
    // motion declaring 1 point while holding 1.5 million values).
    const held = Array.isArray(file.Curves) ? file.Curves.reduce((s: number, c: { Segments?: unknown[] }) => s + (Array.isArray(c?.Segments) ? c.Segments.length : 0), 0) : 0;
    motionPoints += Math.max(count(meta(file).TotalPointCount), held);
  }
  if (motionCurves > budgets.motionCurves) throw new Live2dRefusal("budget", `${motionCurves} motion curves, over ${budgets.motionCurves}`);
  if (motionPoints > budgets.motionPoints) throw new Live2dRefusal("budget", `${motionPoints} motion points, over ${budgets.motionPoints}`);

  if (settings.expressions.length > budgets.expressions) throw new Live2dRefusal("budget", `${settings.expressions.length} expressions, over ${budgets.expressions}`);
  for (const [i, expression] of settings.expressions.entries()) {
    json(await read(ref(expression.file, `expression ${i}`), budgets.jsonBytes, `expression ${i}`), `expression ${i}`, "settings");
  }

  // Physics: settings and particles.
  let physicsSettings = 0;
  let physicsParticles = 0;
  if (settings.physics) {
    const file = json(await read(ref(settings.physics, "the physics"), budgets.jsonBytes, "the physics"), "the physics", "physics");
    const list = Array.isArray(file.PhysicsSettings) ? (file.PhysicsSettings as { Vertices?: unknown[] }[]) : [];
    physicsSettings = Math.max(list.length, count(meta(file).PhysicsSettingCount));
    physicsParticles = Math.max(
      list.reduce((s, p) => s + (Array.isArray(p?.Vertices) ? p.Vertices.length : 0), 0),
      count(meta(file).VertexCount),
    );
    if (physicsSettings > budgets.physicsSettings) throw new Live2dRefusal("budget", `${physicsSettings} physics settings, over ${budgets.physicsSettings}`);
    if (physicsParticles > budgets.physicsParticles) throw new Live2dRefusal("budget", `${physicsParticles} physics particles, over ${budgets.physicsParticles}`);
  }
  for (const [what, path] of [
    ["the pose", settings.pose],
    ["the display info", settings.displayInfo],
    ["the user data", settings.userData],
    ["the motion sync", settings.motionSync],
  ] as const) {
    if (path) json(await read(ref(path, what), budgets.jsonBytes, what), what, "settings");
  }

  return {
    settingsPath,
    settings,
    files,
    parameterIds: [...data.parameters.ids],
    stats: {
      bytes: total,
      files: files.size,
      mocVersion,
      ...counts,
      textures: settings.textures.length,
      texturePixels,
      motions: motionEntries.length,
      motionCurves,
      motionPoints,
      expressions: settings.expressions.length,
      physicsSettings,
      physicsParticles,
    },
  };
}
