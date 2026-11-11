// A plugin's own icon for the Plugins page's lists, for a plugin `plugin.ui` doesn't show (off, found and waiting for
// its OK, or with no UI): `/_icon/<id>` on the clover tree's layer only. A found plugin's files are untrusted content
// shown before its OK, so this route serves only what an <img> decodes as a picture and nothing else: the manifest's
// `icon`, a relative path inside the plugin's folder (links resolved, still inside), a raster image (PNG, JPEG or WebP,
// by its first bytes, never its name; never SVG), at most ICON_MAX_BYTES. Anything else is no icon (the puzzle).
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

/** The most an icon may be. */
export const ICON_MAX_BYTES = 256 * 1024;

const TOP_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The picture type of `bytes` by their first bytes: PNG, JPEG or WebP; undefined for anything else. */
export function rasterType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return "image/png";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

/** A manifest's `icon` as a path inside its folder, or undefined. */
export function iconPathOf(manifest: unknown): string | undefined {
  const icon = (manifest as { icon?: unknown } | null | undefined)?.icon;
  if (typeof icon !== "string" || icon === "" || icon.length > 4096 || isAbsolute(icon) || icon.startsWith("/") || icon.includes("\\")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(icon) || icon.split("/").some((p) => p === "" || p === "." || p === "..")) return undefined;
  return icon;
}

/** What `plugin.get` gives of a plugin (only what's read here). */
export interface IconSource {
  folder: string;
  manifest?: unknown;
}

/** The icon of plugin `id`, read from its own folder as the rules above say; undefined when it has none to show. */
export async function pluginIconFile(get: (id: string) => Promise<IconSource | undefined>, id: string): Promise<{ data: Buffer; type: string } | undefined> {
  if (!TOP_ID_RE.test(id) || id.length > 40) return undefined;
  const p = await get(id).catch(() => undefined);
  if (p === undefined || typeof p.folder !== "string") return undefined;
  const rel = iconPathOf(p.manifest);
  if (rel === undefined) return undefined;
  try {
    const root = realpathSync(p.folder);
    const file = realpathSync(join(root, ...rel.split("/")));
    if (!file.startsWith(root + sep)) return undefined;
    const st = statSync(file);
    if (!st.isFile() || st.size === 0 || st.size > ICON_MAX_BYTES) return undefined;
    const data = readFileSync(file);
    if (data.length > ICON_MAX_BYTES) return undefined;
    const type = rasterType(data);
    return type === undefined ? undefined : { data, type };
  } catch {
    return undefined;
  }
}
