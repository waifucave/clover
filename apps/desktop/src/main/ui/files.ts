// Reading a plugin's own files safely (spec §5.1: a symlink out of the folder makes a plugin invalid; §5.5: `url()`
// only for files inside the folder). Every path a layer or the theme engine asks for is resolved inside the plugin's
// folder, symlinks included, or refused.
import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { AvatarFormatView } from "@waifucave/clover-protocol";
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

/** The most a bot's avatar model file may be (the same 96 MiB the VRM avatar part accepts): a larger one is refused with 413
 *  before it is read, and a smaller one is streamed, not read into memory whole. */
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
      return new Response(`This avatar file is ${Math.ceil(st.size / 1024 / 1024)} MiB; the most it can be is ${Math.floor(limit / 1024 / 1024)} MiB.`, { status: 413, headers });
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

/** How a file of a model is served, by the kind a renderer declared for its extension. */
export interface ModelServe {
  /** The one fixed media type of its kind (never HTML, SVG, script, style or wasm). */
  media: string;
  /** The renderer's cap for the kind, already clamped by the core. */
  maxBytes: number;
}

const AUDIO_MEDIA: Readonly<Record<string, string>> = { mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" };
/** Names a model's folder never shares, however a renderer's extensions are written: a plugin's own manifest and package files. */
const NOT_MODEL = /^(clover|clover-plugin|package)\.json$/i;

/** The media type of one declared kind for this file, or undefined when it can't be served inertly (an `image` kind is only a
 *  raster picture: never SVG). */
function kindMedia(type: AvatarFormatView["kinds"][number]["type"], file: string): string | undefined {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  switch (type) {
    case "json": return "application/json";
    case "binary": return "application/octet-stream";
    case "text": return "text/plain";
    case "audio": return AUDIO_MEDIA[ext] ?? "audio/mpeg";
    case "image": { const m = mediaType(file); return m !== undefined && m.startsWith("image/") && m !== "image/svg+xml" ? m : undefined; }
  }
}

/** What the declared kinds of `formats` say of this file, by its extension: how to serve it, or undefined (it isn't a kind of
 *  the model). Where two kinds claim an extension the first declared wins. */
export function declaredKind(formats: readonly AvatarFormatView[], file: string): ModelServe | undefined {
  const lower = file.toLowerCase();
  if (NOT_MODEL.test(lower.slice(lower.lastIndexOf("/") + 1))) return undefined;
  for (const f of formats) {
    for (const k of f.kinds) {
      if (!k.ext.some((e) => lower.endsWith(e))) continue;
      const media = kindMedia(k.type, file);
      if (media !== undefined) return { media, maxBytes: k.maxBytes };
    }
  }
  return undefined;
}

/** A bot plugin's own model file on `/_t/`, by the kinds the installed renderer of the bot's format declared (`avatar.formats`):
 *  the bot's manifest names the avatar and its format; some installed plugin declares that format; the file (already resolved by
 *  `pluginFile`: its real path, no link out) lies inside the folder that holds the avatar's file, that folder and below; and its
 *  extension is a declared kind. Undefined for anything else, which `/_t/` then treats as before (images and fonts only). */
export function avatarModelFile(plugin: Pick<UiPlugin, "assetBase" | "isBot" | "botAvatar">, registry: readonly Pick<UiPlugin, "avatarFormats">[], file: string): ModelServe | undefined {
  const avatar = plugin.botAvatar;
  if (!plugin.isBot || avatar === undefined) return undefined;
  const formats = registry.flatMap((p) => p.avatarFormats).filter((f) => f.format === avatar.format);
  if (formats.length === 0) return undefined;
  try {
    const slash = avatar.file.lastIndexOf("/");
    const folder = slash < 0 ? realpathSync(plugin.assetBase) : pluginFile(plugin, avatar.file.slice(0, slash));
    if (!isInside(folder, file)) return undefined;
  } catch {
    return undefined;
  }
  return declaredKind(formats, file);
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


/** `/_a/<bot>/<path…>`: a file of the user's own avatar model, by the path the layer asked. The bot must be installed;
 *  the path is plain names; and the REAL path (links followed, at serve time) must still be inside that bot's folder,
 *  so a link planted after the import leads nowhere. Data only: the kinds a renderer declared, never an SVG (a document with scripts). */
export function userAvatarFile(avatarsDir: string, registry: readonly Pick<UiPlugin, "id" | "isBot" | "avatarFormats">[], pathname: string): { file: string; type: string; maxBytes: number } | "forbidden" | "missing" {
  const [, , encodedBot, ...parts] = pathname.split("/");
  let segment: string;
  let rel: string[];
  try {
    segment = decodeURIComponent(encodedBot ?? "");
    rel = parts.map((p) => decodeURIComponent(p));
  } catch {
    return "missing";
  }
  if (!registry.some((p) => p.isBot && p.id.replace(/\//g, "--") === segment)) return "forbidden";
  if (rel.length === 0 || rel.some((p) => p === "" || p === "." || p === ".." || p.startsWith(".") || p.includes("\\") || p.includes("/") || p.includes("\0"))) return "missing";
  const root = join(avatarsDir, segment);
  const file = normalize(join(root, ...rel));
  if (!isInside(root, file)) return "forbidden";
  try {
    if (!isInside(realpathSync(root), realpathSync(file))) return "forbidden";
  } catch {
    return "missing";
  }
  // By the kinds the installed renderers declared (every installed format: the user's model belongs to its bot, whose renderer is
  // one of them): nothing that is not a declared kind, and never SVG.
  const kind = declaredKind(registry.flatMap((p) => p.avatarFormats), file);
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
