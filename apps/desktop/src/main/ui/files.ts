// Reading a plugin's own files safely (spec §5.1: a symlink out of the folder makes a plugin invalid; §5.5: `url()`
// only for files inside the folder). Every path a layer or the theme engine asks for is resolved inside the plugin's
// folder, symlinks included, or refused.
import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { DataFilesView } from "@waifucave/moss-protocol";
import type { UiPlugin } from "./model";

/** Whether `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A file in the plugin's folder, by its relative path (`/` separated). Throws for a path that leaves the folder,
 *  directly or through a symlink, or that doesn't exist. */
export function pluginFile(plugin: Pick<UiPlugin, "assetBase">, path: string): string {
  if (path === "" || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new Error("not a relative path");
  const parts = path.split("/");
  if (parts.some((p) => p === ".." || p === "")) throw new Error("not a plain path");
  const base = realpathSync(plugin.assetBase);
  const full = normalize(join(base, ...parts));
  if (!isInside(base, full)) throw new Error("outside the plugin");
  const real = realpathSync(full);
  if (!isInside(base, real)) throw new Error("a link out of the plugin");
  return real;
}

/** The most a data file may be by default: a larger one is refused with 413 before it is read, and a smaller one is
 *  streamed, not read into memory whole. */
export const MODEL_MAX_BYTES = 96 * 1024 * 1024;

export function modelResponse(path: string, type: string, headers: Record<string, string>, limit = MODEL_MAX_BYTES): Response {
  // Opened once, without following a link at the end and never blocking (a FIFO is refused, not waited on); what is
  // checked (a regular file, its size) and what is streamed are the same descriptor, so nothing swapped in between is served.
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > limit) {
      closeSync(fd);
      return new Response(`This file is ${Math.ceil(st.size / 1024 / 1024)} MiB; the most it can be is ${Math.floor(limit / 1024 / 1024)} MiB.`, { status: 413, headers });
    }
    // The stream owns the descriptor from here (it closes it when it ends or is cancelled); `end` stops it at the size checked.
    const stream = createReadStream(path, { fd, start: 0, end: Math.max(0, st.size - 1), autoClose: true });
    fd = undefined;
    if (st.size === 0) {
      stream.destroy();
      return new Response(new Uint8Array(0), { headers: { ...headers, "Content-Type": type, "Content-Length": "0" } });
    }
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { headers: { ...headers, "Content-Type": type, "Content-Length": String(st.size) } });
  } catch {
    if (fd !== undefined) closeSync(fd);
    return new Response("not found", { status: 404, headers });
  }
}

/** How a data file is served, by the kind declared for its extension. */
export interface ModelServe {
  /** The one fixed media type of its kind (never HTML, SVG, script, style or wasm). */
  media: string;
  /** The declared cap for the kind, already clamped by the core. */
  maxBytes: number;
}

const AUDIO_MEDIA: Readonly<Record<string, string>> = { mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" };
/** Names a data folder never shares, however a declaration's extensions are written: a plugin's own manifest and package files. */
const NOT_MODEL = /^(moss|moss-plugin|package)\.json$/i;

/** The media type of one declared kind for this file, or undefined when it can't be served inertly (an `image` kind is only a
 *  raster picture: never SVG). */
function kindMedia(type: DataFilesView["kinds"][number]["type"], file: string): string | undefined {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  switch (type) {
    case "json": return "application/json";
    case "binary": return "application/octet-stream";
    case "text": return "text/plain";
    case "audio": return AUDIO_MEDIA[ext] ?? "audio/mpeg";
    case "image": { const m = mediaType(file); return m !== undefined && m.startsWith("image/") && m !== "image/svg+xml" ? m : undefined; }
  }
}

/** What the declared kinds say of this file, by its extension: how to serve it, or undefined (it isn't one of them). Where
 *  two kinds claim an extension the first declared wins. */
export function declaredKind(declared: readonly Pick<DataFilesView, "kinds">[], file: string): ModelServe | undefined {
  const lower = file.toLowerCase();
  if (NOT_MODEL.test(lower.slice(lower.lastIndexOf("/") + 1))) return undefined;
  for (const f of declared) {
    for (const k of f.kinds) {
      if (!k.ext.some((e) => lower.endsWith(e))) continue;
      const media = kindMedia(k.type, file);
      if (media !== undefined) return { media, maxBytes: k.maxBytes };
    }
  }
  return undefined;
}

/** A file that comes with one of a plugin's point entries, on `/_t/` (`DataFilesView`): the file (already resolved by
 *  `pluginFile`: its real path, no link out) lies inside a folder its view names, that folder and below, and its extension
 *  is one of that folder's declared kinds. Undefined for anything else, which `/_t/` then treats as before (images and
 *  fonts only). */
export function dataFile(plugin: Pick<UiPlugin, "assetBase" | "dataFiles">, file: string): ModelServe | undefined {
  for (const d of plugin.dataFiles) {
    try {
      const folder = d.folder === "" ? realpathSync(plugin.assetBase) : pluginFile(plugin, d.folder);
      if (!isInside(folder, file)) continue;
    } catch {
      continue;
    }
    const kind = declaredKind([d], file);
    if (kind !== undefined) return kind;
  }
  return undefined;
}

/** The media type a plugin file is served with; anything else is refused (no HTML from a plugin's folder: the only
 *  documents in a layer are the core's). */
export function mediaType(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return {
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
    vrm: "application/octet-stream",
    glb: "model/gltf-binary",
    moc3: "application/octet-stream",
    wasm: "application/wasm",
  }[ext];
}


/** The inert kinds a plugin's own data file is served as to its own layer (`/_d/`), by its extension: data and media only,
 *  never a document, a script, a style, SVG or wasm. Anything else is refused. */
const OWN_DATA_KINDS: readonly Pick<DataFilesView, "kinds">[] = [{ kinds: [
  { ext: [".json"], type: "json", maxBytes: 8 * 1024 * 1024 },
  { ext: [".moc3", ".vrm", ".glb", ".bin"], type: "binary", maxBytes: 128 * 1024 * 1024 },
  { ext: [".png", ".webp", ".jpg", ".jpeg", ".gif", ".avif"], type: "image", maxBytes: 128 * 1024 * 1024 },
  { ext: [".mp3", ".ogg", ".wav"], type: "audio", maxBytes: 16 * 1024 * 1024 },
  { ext: [".txt"], type: "text", maxBytes: 1024 * 1024 },
] }];

/** Whether a request may reach `/_d/` (checked by the asking frame, before the handler): only a frame main bound to the
 *  very layer the URL names. Anything else on that path is refused. */
export function ownDataRequest(frameLayer: string | undefined, url: string): "not-own-data" | "allow" | "refuse" {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not-own-data";
  }
  if (!u.pathname.startsWith("/_d/")) return "not-own-data";
  return frameLayer !== undefined && frameLayer === u.host ? "allow" : "refuse";
}

/** The plugin a `/_d/<plugin id>/…` URL names (its first segment, percent-encoded), or undefined. */
export function ownDataPlugin(pathname: string): string | undefined {
  try {
    const id = decodeURIComponent(pathname.slice("/_d/".length).split("/")[0] ?? "");
    return /^[a-z0-9][a-z0-9-]{0,63}(?:\/[a-z0-9][a-z0-9-]{0,63})?$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** `/_d/<plugin id>/<path…>`: a file a plugin chose to share with its own pages, in the `shared/` folder of its data
 *  folder (`<home>/plugin-data/<id>/shared/`), to its own layer only. Nothing else of its data folder (what its host code
 *  keeps) is served. The path is plain names (no dot files); the REAL path (links followed, at serve time) must still be
 *  inside that folder; and only the inert kinds above, never SVG. `sharedDir` is that folder. */
export function ownDataFile(sharedDir: string, pathname: string): { file: string; type: string; maxBytes: number } | "forbidden" | "missing" {
  const dataDir = sharedDir;
  let rel: string[];
  try {
    rel = pathname.slice("/_d/".length).split("/").slice(1).map((p) => decodeURIComponent(p));
  } catch {
    return "missing";
  }
  if (rel.length === 0 || rel.some((p) => p === "" || p === "." || p === ".." || p.startsWith(".") || p.includes("\\") || p.includes("/") || p.includes("\0"))) return "missing";
  const file = normalize(join(dataDir, ...rel));
  if (!isInside(dataDir, file)) return "forbidden";
  try {
    if (!isInside(realpathSync(dataDir), realpathSync(file))) return "forbidden";
  } catch {
    return "missing";
  }
  const kind = declaredKind(OWN_DATA_KINDS, file);
  if (kind === undefined) return "forbidden";
  return { file, type: kind.media, maxBytes: kind.maxBytes };
}

/** The most a built client module may be (the core's build refuses more). */
export const BUILT_CLIENT_MAX_BYTES = 16 * 1024 * 1024;

/** Where a plugin's built client is served (`/_b/<id>/<hash prefix>/<file>`): its own layer's origin, the hash in the
 *  path so a new build is a new URL. */
export function builtClientUrl(pluginId: string, built: { file: string; sha256: string }): string {
  return `/_b/${encodeURIComponent(pluginId)}/${built.sha256.slice(0, 16)}/${encodeURIComponent(built.file)}`;
}

/** The bytes of a plugin's built client for a `/_b/` request's key and file, or undefined: only the module its view
 *  names, read without following a link, at most `BUILT_CLIENT_MAX_BYTES`, and only while its SHA-256 is still the one
 *  the core built (a file changed on disk since is never served). */
export function builtClientFile(plugin: Pick<UiPlugin, "clientBuild">, key: string, file: string): Uint8Array<ArrayBuffer> | undefined {
  const b = plugin.clientBuild;
  if (b === undefined || key !== b.sha256.slice(0, 16) || file !== b.file || file.includes("/") || file.includes("\\")) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(join(b.base, b.file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > BUILT_CLIENT_MAX_BYTES) return undefined;
    const bytes = new Uint8Array(new ArrayBuffer(st.size));
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, bytes, at, st.size - at, at);
      if (n <= 0) return undefined;
      at += n;
    }
    return createHash("sha256").update(bytes).digest("hex") === b.sha256 ? bytes : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
