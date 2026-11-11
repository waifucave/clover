// The avatar formats (the owner's decision of November 5, amending §5.5 and §6's "VRM by default"): avatars are VRM or
// Live2D Cubism models. The bot stage's `avatar` spot is keyed by format, so a plugin may bring another; these two are
// the app's own. Live2D is drawn by Mochi2D (`waifucave/Mochi2D`), the owner's clean-room Cubism runtime, and Alpha's
// avatar is a Live2D model.

export interface AvatarFormatInfo {
  readonly format: string;
  /** What `file` names. */
  readonly entry: string;
  readonly renderer: string;
}

export const AVATAR_FORMATS: readonly AvatarFormatInfo[] = [
  { format: "vrm", entry: "a `.vrm` file", renderer: "the bundled VRM renderer (three-vrm)" },
  {
    format: "live2d",
    entry: "a Cubism `.model3.json` file, with the files it names beside it, or a `.zip` holding one",
    renderer: "Mochi2D (`waifucave/Mochi2D`), the owner's clean-room Cubism runtime",
  },
];

/** What's wrong with an avatar's `file` for its format, or undefined. A format the app doesn't draw itself isn't
 *  checked here: its renderer plugin knows its files. */
export function avatarFileProblem(format: string, file: string): string | undefined {
  // Whatever the format, `file` names a file: not a folder, `.` or `..` (the path's own checks refuse a `..` inside, an absolute path or an empty one).
  const last = file.split("/").pop() ?? "";
  if (last === "" || last === "." || last === "..") return "an avatar's file names a file, not a folder";
  const f = file.toLowerCase();
  if (format === "vrm" && !f.endsWith(".vrm")) return "a `vrm` avatar's file is a `.vrm` file";
  if (format === "live2d" && !f.endsWith(".model3.json") && !f.endsWith(".zip")) {
    return "a `live2d` avatar's file is a Cubism `.model3.json` file or a `.zip` holding one";
  }
  return undefined;
}

/** The files a Cubism `model3.json` names, relative to it (`FileReferences`): the moc, textures, physics, pose, display
 *  info, expressions and motions with their sounds. Null when it isn't a `model3.json`. */
export function live2dReferences(model3: unknown): string[] | null {
  if (typeof model3 !== "object" || model3 === null) return null;
  const refs = (model3 as { FileReferences?: unknown }).FileReferences;
  if (typeof refs !== "object" || refs === null) return null;
  const r = refs as Record<string, unknown>;
  if (typeof r.Moc !== "string" || !Array.isArray(r.Textures) || !r.Textures.every((t) => typeof t === "string")) return null;
  const out: string[] = [r.Moc, ...(r.Textures as string[])];
  for (const key of ["Physics", "Pose", "DisplayInfo", "UserData"]) if (typeof r[key] === "string") out.push(r[key] as string);
  if (Array.isArray(r.Expressions)) for (const e of r.Expressions) if (typeof (e as { File?: unknown })?.File === "string") out.push((e as { File: string }).File);
  if (typeof r.Motions === "object" && r.Motions !== null) {
    for (const group of Object.values(r.Motions as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue;
      for (const m of group) {
        const motion = m as { File?: unknown; Sound?: unknown };
        if (typeof motion?.File === "string") out.push(motion.File);
        if (typeof motion?.Sound === "string") out.push(motion.Sound);
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// What a renderer declares about its format (`avatar.formats`, a data point the character plugin declares)
// -------------------------------------------------------------------------------------------------

/** The kinds of file a model is made of. A closed set: each is served as one fixed, inert media type (nosniff, never a
 *  document, a script, a style, SVG, HTML or wasm), whatever extension the renderer gives it. */
export const AVATAR_FILE_TYPES = ["json", "binary", "image", "audio", "text"] as const;
export type AvatarFileType = (typeof AVATAR_FILE_TYPES)[number];

/** The media type each kind is served with. */
export const AVATAR_FILE_MEDIA: Readonly<Record<AvatarFileType, string>> = {
  json: "application/json",
  binary: "application/octet-stream",
  image: "image/png",
  audio: "audio/mpeg",
  text: "text/plain",
};

const MiB = 1024 * 1024;
/** The most a renderer may ask for, per kind of file, in bytes: a declared `maxBytes` above it is refused at install, and
 *  whoever serves a model file clamps to it again. */
export const AVATAR_FILE_CAPS: Readonly<Record<AvatarFileType, number>> = {
  json: 8 * MiB,
  binary: 128 * MiB,
  image: 32 * MiB,
  audio: 16 * MiB,
  text: 1 * MiB,
};

/** The most files one model may have (the import's own limit). */
export const AVATAR_MODEL_MAX_FILES = 512;

/** How a model's files are found from its entry file. `folder`: every file of a declared kind in the entry's folder and
 *  below. `cubism-model3`: the files the entry's Cubism `FileReferences` name (`live2dReferences`). A closed list of checks the
 *  core implements: a renderer never brings code for it, and an unknown name is an install error. */
export const AVATAR_FINDERS = ["folder", "cubism-model3"] as const;
export type AvatarFinder = (typeof AVATAR_FINDERS)[number];

/** What a renderer can do beyond drawing: which of the stage's feeds it uses. */
export const AVATAR_CAPABILITIES = ["lipsync", "expressions", "motions", "outfits", "lookat", "pace"] as const;

/** The clamped cap for a kind of file: the declared one, never above the kind's hard limit. */
export function clampAvatarCap(type: AvatarFileType, declared: number | undefined): number {
  const hard = AVATAR_FILE_CAPS[type];
  return declared === undefined || !Number.isFinite(declared) || declared < 1 ? hard : Math.min(Math.floor(declared), hard);
}
