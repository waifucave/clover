// A plugin's own icon for the Plugins page's lists, for a plugin `plugin.ui` doesn't show (off, found and waiting for
// its OK, or with no UI): `/_icon/<id>`, asked by a frame main bound to the clover tree's layer and no other. A found
// plugin's files are untrusted content shown before its OK, so this route serves only what an <img> decodes as a small
// still picture: the manifest's `icon`, a relative path inside the plugin's folder (links resolved, still inside), read
// once through one descriptor (no link followed at the end, never blocking: a FIFO is refused, not waited on), a
// regular file of 1 byte to ICON_MAX_BYTES, a PNG, JPEG or WebP by its own header (never its name; never SVG), at most
// ICON_MAX_SIDE pixels each way and not animated. Anything else is no icon (the puzzle).
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

/** The most an icon's file may be. */
export const ICON_MAX_BYTES = 256 * 1024;
/** The most an icon may be, each way, in pixels (the ruling: an icon needs no more). */
export const ICON_MAX_SIDE = 1024;

const TOP_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export type RasterType = "image/png" | "image/jpeg" | "image/webp";

/** The picture type of `bytes` by their first bytes: PNG, JPEG or WebP; undefined for anything else. */
export function rasterType(bytes: Uint8Array): RasterType | undefined {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return undefined;
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}
const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const be16 = (b: Uint8Array, at: number) => (b[at]! << 8) + b[at + 1]!;
const le16 = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8);
const le24 = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16);
const le32 = (b: Uint8Array, at: number) => (b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + (b[at + 3]! << 24)) >>> 0;

/** A picture's size from its own header, and whether it moves; undefined for a header that can't be read. */
export interface PictureInfo { width: number; height: number; animated: boolean }

/** PNG: the `IHDR` first, then every chunk before the image data for `acTL` (an animated PNG). */
function pngInfo(b: Uint8Array): PictureInfo | undefined {
  if (b.length < 33 || ascii(b, 12, 4) !== "IHDR" || be32(b, 8) !== 13) return undefined;
  const width = be32(b, 16);
  const height = be32(b, 20);
  let animated = false;
  for (let at = 8; at + 8 <= b.length;) {
    const len = be32(b, at);
    const type = ascii(b, at + 4, 4);
    if (type === "acTL") animated = true;
    if (type === "IDAT" || type === "IEND") break;
    const next = at + 12 + len;
    if (len > b.length || next <= at) return undefined;
    at = next;
  }
  return { width, height, animated };
}

/** JPEG: the segments walked from the start to the first frame header (SOF0–SOF15 but DHT, JPG and DAC); none before
 *  the scan is no size. */
function jpegInfo(b: Uint8Array): PictureInfo | undefined {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return undefined;
    let marker = b[at + 1]!;
    // Fill bytes before a marker.
    while (marker === 0xff && at + 2 < b.length) {
      at++;
      marker = b[at + 1]!;
    }
    // Markers with no length: TEM and RST0–RST7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // the end, or the scan, before a frame header
    if (at + 4 > b.length) return undefined;
    const len = be16(b, at + 2);
    if (len < 2) return undefined;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (at + 9 > b.length) return undefined;
      return { height: be16(b, at + 5), width: be16(b, at + 7), animated: false };
    }
    at += 2 + len;
  }
  return undefined;
}

/** WebP: a simple file's `VP8 ` or `VP8L` frame; an extended one's `VP8X` canvas and animation flag, and any frame in
 *  it (an `ANIM` or `ANMF` chunk is animation too). */
function webpInfo(b: Uint8Array): PictureInfo | undefined {
  const frame = (at: number, type: string): { width: number; height: number } | undefined => {
    const d = at + 8;
    if (type === "VP8 ") {
      if (d + 10 > b.length || b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return undefined;
      return { width: le16(b, d + 6) & 0x3fff, height: le16(b, d + 8) & 0x3fff };
    }
    if (type === "VP8L") {
      if (d + 5 > b.length || b[d] !== 0x2f) return undefined;
      const bits = le32(b, d + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return undefined;
  };
  const first = ascii(b, 12, 4);
  if (first === "VP8 " || first === "VP8L") {
    const f = frame(12, first);
    return f === undefined ? undefined : { ...f, animated: false };
  }
  if (first !== "VP8X") return undefined;
  if (b.length < 30) return undefined;
  const flags = b[20]!;
  let width = le24(b, 24) + 1;
  let height = le24(b, 27) + 1;
  let animated = (flags & 0x02) !== 0;
  // The chunks after it: a frame larger than the canvas counts at its own size; any animation chunk moves.
  for (let at = 12 + 8 + le32(b, 16) + (le32(b, 16) & 1); at + 8 <= b.length;) {
    const type = ascii(b, at, 4);
    const len = le32(b, at + 4);
    if (type === "ANIM" || type === "ANMF") animated = true;
    if (type === "VP8 " || type === "VP8L") {
      const f = frame(at, type);
      if (f === undefined) return undefined;
      width = Math.max(width, f.width);
      height = Math.max(height, f.height);
    }
    const next = at + 8 + len + (len & 1);
    if (next <= at) return undefined;
    at = next;
  }
  return { width, height, animated };
}

/** A picture's size and motion, read from its header. */
export function pictureInfo(bytes: Uint8Array, type: RasterType): PictureInfo | undefined {
  return type === "image/png" ? pngInfo(bytes) : type === "image/jpeg" ? jpegInfo(bytes) : webpInfo(bytes);
}

/** Whether a picture may be shown: a size it states, 1 to ICON_MAX_SIDE each way, and still. */
export function pictureAllowed(bytes: Uint8Array): RasterType | undefined {
  const type = rasterType(bytes);
  if (type === undefined) return undefined;
  const info = pictureInfo(bytes, type);
  if (info === undefined || info.animated) return undefined;
  if (info.width < 1 || info.height < 1 || info.width > ICON_MAX_SIDE || info.height > ICON_MAX_SIDE) return undefined;
  return type;
}

/** A manifest's `icon` as a path inside its folder, or undefined. */
export function iconPathOf(manifest: unknown): string | undefined {
  const icon = (manifest as { icon?: unknown } | null | undefined)?.icon;
  if (typeof icon !== "string" || icon === "" || icon.length > 4096 || isAbsolute(icon) || icon.startsWith("/") || icon.includes("\\")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(icon) || icon.split("/").some((p) => p === "" || p === "." || p === "..")) return undefined;
  return icon;
}

/** Where a plugin's icon is (`plugin.iconSource`): its folder, and the manifest's icon. */
export interface IconSource {
  folder: string;
  manifest?: unknown;
}

/** A file's bytes through one descriptor: opened with no link followed at its end and without blocking, a regular
 *  file of 1 byte to `max` by the descriptor's own stat, at most `max` + 1 bytes read; closed on every path. */
export function readSmallFile(path: string, max: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size < 1 || st.size > max) return undefined;
    const buf = Buffer.alloc(max + 1);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return got < 1 || got > max ? undefined : buf.subarray(0, got);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // closed
      }
    }
  }
}

/** The icon of plugin `id`, read from its own folder as the rules above say; undefined when it has none to show. */
export async function pluginIconFile(get: (id: string) => Promise<IconSource | undefined>, id: string): Promise<{ data: Buffer; type: string } | undefined> {
  if (!TOP_ID_RE.test(id) || id.length > 40) return undefined;
  const p = await get(id).catch(() => undefined);
  if (p === undefined || typeof p.folder !== "string") return undefined;
  const rel = iconPathOf(p.manifest);
  if (rel === undefined) return undefined;
  let file: string;
  try {
    const root = realpathSync(p.folder);
    file = realpathSync(join(root, ...rel.split("/")));
    if (!file.startsWith(root + sep)) return undefined;
  } catch {
    return undefined;
  }
  const data = readSmallFile(file, ICON_MAX_BYTES);
  if (data === undefined) return undefined;
  const type = pictureAllowed(data);
  return type === undefined ? undefined : { data, type };
}

/** The route's door: `/_icon/` is answered only for a frame main bound to the clover tree's layer (by the frame that
 *  asks, never the URL's host); a request with no known frame, or from another layer's, is refused. Other paths aren't
 *  this door's. */
export function iconRequest(frameLayer: string | undefined, url: string): "not-icon" | "allow" | "refuse" {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not-icon";
  }
  if (!u.pathname.startsWith("/_icon/")) return "not-icon";
  return frameLayer === "clover" && u.host === "clover" ? "allow" : "refuse";
}
