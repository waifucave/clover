// Reading a plugin's own files safely (spec §5.1: a symlink out of the folder makes a plugin invalid; §5.5: `url()`
// only for files inside the folder). Every path a layer or the theme engine asks for is resolved inside the plugin's
// folder, symlinks included, or refused.
import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { isAbsolute, join, normalize, relative } from "node:path";
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

/** The most a Live2D model's JSON file may be (a model3, physics, pose or motion file): larger is refused with 413. */
export const AVATAR_JSON_MAX_BYTES = 8 * 1024 * 1024;

const LIVE2D_JSON_NAMES = /\.(model3|physics3|pose3|cdi3|exp3|motion3|userdata3)\.json$/i;

/** Whether this `.json` file of a bot plugin (already resolved by `pluginFile`: its real path) may be served on `/_t/`: only for
 *  a bot whose manifest names a Live2D avatar, and only a file inside the folder that holds that avatar's file (that folder
 *  and below, by real path, so a link out of it leads nowhere). The route does not check which frame asks, so whoever can
 *  reach `/_t/` can read what this allows. When the model sits at the plugin's root, only the Live2D
 *  file names pass: never its `clover.json` or any other JSON. The folder comes from the registry's record of the manifest. */
export function avatarJsonAllowed(plugin: Pick<UiPlugin, "assetBase" | "isBot" | "botAvatar">, file: string): boolean {
  const avatar = plugin.botAvatar;
  if (!plugin.isBot || avatar === undefined || avatar.format !== "live2d" || !file.toLowerCase().endsWith(".json")) return false;
  try {
    const slash = avatar.file.lastIndexOf("/");
    const base = realpathSync(plugin.assetBase);
    const folder = slash < 0 ? base : pluginFile(plugin, avatar.file.slice(0, slash));
    if (!isInside(folder, file)) return false;
    return folder !== base || LIVE2D_JSON_NAMES.test(file);
  } catch {
    return false;
  }
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
 *  so a link planted after the import leads nowhere. Data only, never an SVG (a document with scripts). */
export function userAvatarFile(avatarsDir: string, registry: readonly Pick<UiPlugin, "id" | "isBot">[], pathname: string): { file: string; type: string } | "forbidden" | "missing" {
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
  const type = mediaType(file);
  if (type === undefined || type === "image/svg+xml" || !(type.startsWith("image/") || type.startsWith("application/json") || type === "application/octet-stream" || type === "model/gltf-binary")) return "forbidden";
  return { file, type };
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
