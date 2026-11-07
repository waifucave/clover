// Reading a plugin's own files safely (spec §5.1: a symlink out of the folder makes a plugin invalid; §5.5: `url()`
// only for files inside the folder). Every path a layer or the theme engine asks for is resolved inside the plugin's
// folder, symlinks included, or refused.
import { realpathSync } from "node:fs";
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

