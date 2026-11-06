// Reading a file the user is shown without following a link (review N1). A runner can leave a link in a folder it
// writes (its session's outputs), and the user's own surface isn't fenced, so a plain read could show another bot's
// memory in place of an output. The tree's no-follow read (lane J, #225: `tree.read` and `tree.stat` with
// `noFollow: true`) refuses a link or a reparse point anywhere from the folder's root down, opens with O_NOFOLLOW,
// accepts only a plain file and checks the handle's real path, on the computer that holds it. It is one call: there is
// no stat-then-read for a runner to race. The plugin API's `files` passes the option through (lane B's types carry
// it once #225 lands; until then this is the one place that names it).
//
// Shared by every part that shows a file: the output view, the Files panel and the conversation (`file.preview`).
import type { FileStat, PluginApi } from "./types";

type Files = NonNullable<PluginApi["files"]>;

export interface NoFollow {
  noFollow: true;
}
export const NO_FOLLOW: NoFollow = { noFollow: true };

/** The files API with the tree's no-follow option. */
interface NoFollowFiles {
  readText(path: string, opts: NoFollow): Promise<string>;
  readBytes(path: string, opts: NoFollow): Promise<Uint8Array>;
  stat(path: string, opts: NoFollow): Promise<FileStat | null>;
}
const nf = (files: Files) => files as unknown as NoFollowFiles;

/** The file's text, read in one no-follow call: a link anywhere on the way refuses it. */
export const readTextNoFollow = (files: Files, path: string) => nf(files).readText(path, NO_FOLLOW);
/** The file's bytes, likewise. */
export const readBytesNoFollow = (files: Files, path: string) => nf(files).readBytes(path, NO_FOLLOW);

/** What a path is, without following a link: `file` only for a plain file. For saying why a read was refused, and for
 *  deciding whether a path may be handed to a preview plugin, which reads it through its own fenced API. */
export async function kindNoFollow(files: Files, path: string): Promise<"file" | "link" | "other" | "missing"> {
  try {
    const stat = await nf(files).stat(path, NO_FOLLOW);
    if (!stat) return "missing";
    return stat.type === "file" ? "file" : stat.type === "symlink" ? "link" : "other";
  } catch {
    return "missing";
  }
}

/** Whether `path` is exactly one name directly inside `folder`: no `.`, `..` or empty segment, nothing nested (N1). */
export function directlyIn(path: string, folder: string | undefined): boolean {
  if (!folder || path.split("/").some((s) => s === ".." || s === "." || s === "")) return false;
  const base = folder.replace(/\/+$/, "");
  return path.startsWith(`${base}/`) && !path.slice(base.length + 1).includes("/");
}

const TYPES: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  pdf: "application/pdf", json: "application/json", csv: "text/csv", tsv: "text/tab-separated-values",
  md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", txt: "text/plain", log: "text/plain",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  glb: "model/gltf-binary", gltf: "model/gltf+json", vrm: "model/vrm", stl: "model/stl",
};

/** A file's media type by its name (the key `file.preview` is keyed by); `application/octet-stream` when unknown. */
export function mediaTypeOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return (dot > 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

/** The image types the host draws itself (never SVG: it can hold script and links). */
export const HOST_IMAGES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
