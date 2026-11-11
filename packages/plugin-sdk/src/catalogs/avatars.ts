import type { AvatarFormatEntry } from "./points";

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

/** What's wrong with an avatar's `file` for its format, or undefined, by the format's declaration (`avatar.formats`):
 *  the file ends with one of its `entry.extensions`. A format none of `formats` declares isn't checked here (its
 *  renderer, when one is installed, knows its files). `formats` defaults to the ones Clover ships, for a check made
 *  without the installed list (an offline `validate`, a manifest's own schema). */
export function avatarFileProblem(format: string, file: string, formats: readonly AvatarFormatDecl[] = BUNDLED_AVATAR_FORMATS): string | undefined {
  // Whatever the format, `file` names a file: not a folder, `.` or `..` (the path's own checks refuse a `..` inside, an absolute path or an empty one).
  const last = file.split("/").pop() ?? "";
  if (last === "" || last === "." || last === "..") return "an avatar's file names a file, not a folder";
  const decl = formats.find((d) => d.format === format);
  if (decl === undefined || extensionOf(file, decl.entry.extensions) !== undefined) return undefined;
  return `a \`${format}\` avatar's file is ${orList(decl.entry.extensions.map((e) => `a \`${e}\` file`))}`;
}

/** "a, b or c". */
export function orList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** The longest of `extensions` (lower case, with the dot) that `name` ends with, case-blind; undefined when none. */
export function extensionOf(name: string, extensions: readonly string[]): string | undefined {
  const n = name.toLowerCase();
  return [...extensions].sort((a, b) => b.length - a.length).find((e) => n.endsWith(e));
}

/** The kind (`files.kinds`) a model file is, by its extension, and its clamped cap; undefined for a file of no declared
 *  kind, which never comes along with a model. */
export function avatarFileKind(decl: Pick<AvatarFormatDecl, "files">, name: string): { type: AvatarFileType; maxBytes: number } | undefined {
  let best: { ext: string; type: AvatarFileType; maxBytes?: number | undefined } | undefined;
  for (const k of decl.files.kinds) {
    const ext = extensionOf(name, k.ext);
    if (ext !== undefined && (best === undefined || ext.length > best.ext.length)) best = { ext, type: k.type, maxBytes: k.maxBytes };
  }
  return best === undefined ? undefined : { type: best.type, maxBytes: clampAvatarCap(best.type, best.maxBytes) };
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
  image: 128 * MiB,
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

/** What the checks read of an `avatar.formats` declaration (`AvatarFormatEntry`, as parsed: `files.find` filled in). */
export type AvatarFormatDecl = Pick<AvatarFormatEntry, "format" | "name" | "entry" | "files" | "import">;

/** The formats Clover ships, as their renderers declare them (clover/vrm's and clover/live2d's `avatar.formats` entries;
 *  a core test holds the two equal): what a check falls back on when it isn't handed the installed formats. */
export const BUNDLED_AVATAR_FORMATS: readonly AvatarFormatDecl[] = [
  {
    format: "vrm", name: "VRM", entry: { extensions: [".vrm"] },
    files: { kinds: [{ ext: [".vrm", ".glb"], type: "binary", maxBytes: 128 * MiB }], find: "folder", maxFiles: 1 },
    import: { accepts: ["file"] },
  },
  {
    format: "live2d", name: "Live2D (Cubism)", entry: { extensions: [".model3.json", ".zip"] },
    files: {
      kinds: [
        { ext: [".json"], type: "json", maxBytes: 8 * MiB },
        { ext: [".moc3"], type: "binary", maxBytes: 128 * MiB },
        { ext: [".png", ".webp", ".jpg", ".jpeg"], type: "image", maxBytes: 32 * MiB },
      ],
      find: "cubism-model3", maxFiles: 512,
    },
    import: { accepts: ["folder", "zip"] },
  },
];
