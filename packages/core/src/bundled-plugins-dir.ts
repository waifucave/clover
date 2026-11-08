// The bundled plugins (the registry's `bundledDirs`): where an installed build's are, and the one rule that makes any
// of them count. The registry approves bundled plugins without a card, so a bundled file is trusted code. The rule
// (#259 check 3, the controller's ruling) has no time-of-check gap: the signed core carries the manifest.
//
//   - At release build time the staged plugins tree is measured ({relative path → sha256, size}, scripts/release/
//     bundled-plugins.ts) and the manifest is compiled INTO clover-core as an embedded file (scripts/build-daemon.ts
//     `--plugins-manifest`). The core's own signature (macOS) or the signed feed it came from covers it.
//   - A file counts only through `readBundledFile`: it is read ONCE, its size and hash checked against the manifest,
//     and the verified bytes returned. Callers load from those bytes (or a private copy of them), never by reading the
//     path again, so swapping a file after the check changes nothing that runs. A file the manifest doesn't name is
//     refused; `readBundledPlugin` refuses a whole plugin when any of its files fails or its folder holds an extra one.
//   - `bundledPluginsDir` only finds the candidate folder by layout: `<dirname(realpath(clover-core))>/../plugins`,
//     an app's `…/resources/daemon/clover-core` → `…/resources/plugins` or a server's
//     `<cloverHome>/bin/daemon/clover-core` → `<cloverHome>/bin/plugins` (#244). A copied genuine core beside swapped
//     plugins finds a folder and then gets each swapped file refused. No per-OS folder trust (code signature, root
//     ownership, read-only mounts) is needed or used.
//   - A dev or source build has no embedded manifest, so nothing is bundled (lane B settles the dev layout). The
//     user's own `<cloverHome>/plugins` is never the bundled folder.
//   - The manifest is read from the embedded Blob itself (`loadBundledManifest`, once, at the daemon's start), never
//     through a path. Until it is loaded, `bundledManifest()` is the empty one: nothing is bundled.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** One file of the bundled tree, as measured at build time. */
export interface BundledEntry { sha256: string; size: number }

/** The bundled tree's manifest: every shipped file, by its path relative to the plugins folder (with `/`). */
export interface BundledManifest { files: Readonly<Record<string, BundledEntry>> }

/** The embedded file's name in a compiled core: `clover-bundled-plugins-<bun's hash>.manifest`. */
export const BUNDLED_MANIFEST_FILE = "clover-bundled-plugins.manifest";
const EMBEDDED_NAME = /^clover-bundled-plugins(?:-[a-z0-9]+)?\.manifest$/;

/** The manifest of a build that ships no bundled plugins (dev, source, a core built without one). */
export const EMPTY_BUNDLED_MANIFEST: BundledManifest = Object.freeze({ files: Object.freeze({}) });

/** Whether `rel` is a plain relative path inside the tree: `/`-separated, no empty, `.` or `..` segment, no
 *  backslash, colon or NUL (nothing that could name a file outside the folder on any OS). */
export function validBundledPath(rel: string): boolean {
  if (rel === "" || /[\\:\0]/.test(rel)) return false;
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Why a path can't ship to every OS, or undefined: a Windows device name in any segment (`CON`, `PRN`, `AUX`, `NUL`,
 *  `COM0`–`COM9`, `LPT0`–`LPT9`, with any extension, in any case), or a segment ending in a dot or a space. */
export function nonPortablePath(rel: string): string | undefined {
  for (const seg of rel.split("/")) {
    if (/^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i.test(seg)) return `${seg} is a Windows device name`;
    if (/[. ]$/.test(seg)) return `${seg} ends in a dot or a space, which Windows drops`;
  }
  return undefined;
}

/** The manifest's one text form (keys sorted), which the build embeds and hashes. */
export function formatBundledManifest(m: BundledManifest): string {
  const files: Record<string, BundledEntry> = {};
  for (const rel of Object.keys(m.files).sort()) files[rel] = { sha256: m.files[rel]!.sha256, size: m.files[rel]!.size };
  return `${JSON.stringify({ format: 1, files })}\n`;
}

/** Parses a manifest, or throws: format 1, every path valid, every hash 64 lower-case hex, every size a whole number. */
export function parseBundledManifest(text: string): BundledManifest {
  const raw = JSON.parse(text) as { format?: unknown; files?: unknown };
  if (raw === null || typeof raw !== "object" || raw.format !== 1 || raw.files === null || typeof raw.files !== "object" || Array.isArray(raw.files)) {
    throw new Error("not a bundled-plugins manifest (format 1)");
  }
  const files: Record<string, BundledEntry> = {};
  for (const [rel, e] of Object.entries(raw.files as Record<string, unknown>)) {
    const entry = e as { sha256?: unknown; size?: unknown } | null;
    if (!validBundledPath(rel)) throw new Error(`the manifest names ${JSON.stringify(rel)}, not a plain relative path`);
    if (entry === null || typeof entry !== "object" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`the manifest's entry for ${rel} isn't {sha256, size}`);
    }
    files[rel] = Object.freeze({ sha256: entry.sha256, size: entry.size });
  }
  return Object.freeze({ files: Object.freeze(files) });
}

/** Measures the tree at `dir` (every regular file; a symlink or anything else is refused, never followed). */
export function measureBundledTree(dir: string): BundledManifest {
  const files: Record<string, BundledEntry> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel === "" ? dir : join(dir, rel)).sort()) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) {
        if (!validBundledPath(r)) throw new Error(`${r}: not a plain relative path`);
        const odd = nonPortablePath(r);
        if (odd !== undefined) throw new Error(`${r}: ${odd}: a bundled file must ship to every OS`);
        const bytes = readFileSync(join(dir, r));
        files[r] = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
      } else throw new Error(`${join(dir, r)} is ${st.isSymbolicLink() ? "a symlink" : "not a regular file"}: the bundled tree holds regular files only`);
    }
  };
  walk("");
  return { files };
}

/** An embedded file of a compiled core: its name, and its bytes. */
export interface EmbeddedFile { name?: string; bytes(): Promise<Uint8Array> }

/** The manifest among a compiled core's embedded files: the one named like BUNDLED_MANIFEST_FILE, read from its Blob,
 *  or the empty manifest when there is none. Two, or one that doesn't parse, throws: a release core is built with
 *  exactly one good manifest. */
export async function loadEmbeddedManifest(files: readonly EmbeddedFile[]): Promise<{ manifest: BundledManifest; text?: string }> {
  const found = files.filter((f) => EMBEDDED_NAME.test(f.name ?? ""));
  if (found.length === 0) return { manifest: EMPTY_BUNDLED_MANIFEST };
  if (found.length > 1) throw new Error(`the core embeds ${found.length} bundled-plugins manifests`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await found[0]!.bytes());
  return { manifest: parseBundledManifest(text), text };
}

let loaded: Promise<{ manifest: BundledManifest; text?: string }> | undefined;
let cached: { manifest: BundledManifest; text?: string } | undefined;

/** Reads the core's own embedded manifest from its Blob, once per process (later calls answer the same); empty outside
 *  a compiled core. The daemon awaits it at its start, before anything asks for a bundled plugin. */
export function loadBundledManifest(): Promise<{ manifest: BundledManifest; text?: string }> {
  loaded ??= loadEmbeddedManifest(typeof Bun !== "undefined" ? (Bun.embeddedFiles as unknown as readonly EmbeddedFile[]) : []).then((m) => (cached = m));
  return loaded;
}

/** The manifest this core was built with, once `loadBundledManifest` has read it; until then (and for a dev or source
 *  build) the empty one, so nothing counts as bundled. */
export function bundledManifest(): BundledManifest {
  return cached?.manifest ?? EMPTY_BUNDLED_MANIFEST;
}

/** A bundled file's verified bytes, or why it was refused. */
export type BundledRead = { ok: true; bytes: Uint8Array } | { ok: false; refusal: string };

/**
 * Reads `rel` under the bundled folder `root` ONCE and returns its bytes only when they are the manifest's: the path
 * must be named by the manifest, the file a regular one (a symlink in its last segment is refused) of the manifest's
 * size, and its SHA-256 the manifest's. Load from the bytes returned, never by reading the path again.
 */
export function readBundledFile(root: string, rel: string, manifest: BundledManifest = bundledManifest()): BundledRead {
  if (!validBundledPath(rel)) return { ok: false, refusal: `${rel}: not a plain relative path` };
  const entry = Object.hasOwn(manifest.files, rel) ? manifest.files[rel] : undefined;
  if (entry === undefined) return { ok: false, refusal: `${rel}: not in the bundled-plugins manifest this core was built with` };
  const path = join(root, rel);
  // A regular file before it is opened: a planted FIFO or device is refused without a read that could block. The open
  // is non-blocking and follows no last-segment link, and fstat checks the file actually opened.
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { ok: false, refusal: `${rel}: not a regular file` };
  } catch (err) {
    return { ok: false, refusal: `${rel}: can't be opened (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` };
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    return { ok: false, refusal: `${rel}: can't be opened (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, refusal: `${rel}: not a regular file` };
    if (st.size !== entry.size) return { ok: false, refusal: `${rel}: ${st.size} bytes, not the manifest's ${entry.size}` };
    const bytes = new Uint8Array(entry.size);
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (n === 0) return { ok: false, refusal: `${rel}: shorter than the manifest's ${entry.size} bytes` };
      at += n;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return { ok: false, refusal: `${rel}: its contents aren't the manifest's (SHA-256 differs)` };
    return { ok: true, bytes };
  } catch (err) {
    return { ok: false, refusal: `${rel}: can't be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` };
  } finally {
    closeSync(fd);
  }
}

/** The manifest's top-level plugins (the first segment of each path). */
export function bundledPluginIds(manifest: BundledManifest = bundledManifest()): string[] {
  return [...new Set(Object.keys(manifest.files).map((rel) => rel.split("/")[0]!))].sort();
}

/** A whole bundled plugin's verified files (paths relative to the plugins folder), or why it isn't bundled. */
export type BundledPluginRead = { ok: true; files: Map<string, Uint8Array> } | { ok: false; refusal: string };

/**
 * Every file of the top-level plugin `id`, each through `readBundledFile`. The plugin counts as bundled only when the
 * manifest names it, every file it names verifies, and the folder holds nothing the manifest doesn't name (an extra
 * file or a symlink is refused, not skipped). The registry loads the plugin from these bytes.
 */
export function readBundledPlugin(root: string, id: string, manifest: BundledManifest = bundledManifest()): BundledPluginRead {
  if (!validBundledPath(id) || id.includes("/")) return { ok: false, refusal: `${id}: not a top-level plugin name` };
  const names = Object.keys(manifest.files).filter((rel) => rel.startsWith(`${id}/`)).sort();
  if (names.length === 0) return { ok: false, refusal: `${id}: not in the bundled-plugins manifest this core was built with` };
  const extra = extraFiles(root, id, manifest);
  if (extra.length > 0) return { ok: false, refusal: `${id}: its folder holds what the manifest doesn't name: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", …" : ""}` };
  const files = new Map<string, Uint8Array>();
  for (const rel of names) {
    const r = readBundledFile(root, rel, manifest);
    if (!r.ok) return { ok: false, refusal: r.refusal };
    files.set(rel, r.bytes);
  }
  return { ok: true, files };
}

/** What's under `root/id` that the manifest doesn't name (files and symlinks; a folder only through its contents). */
function extraFiles(root: string, id: string, manifest: BundledManifest): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try { names = readdirSync(join(root, rel)); } catch { return; }
    for (const name of names.sort()) {
      const r = `${rel}/${name}`;
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(join(root, r)); } catch { continue; }
      if (st.isDirectory()) walk(r);
      else if (!st.isFile() || !Object.hasOwn(manifest.files, r)) out.push(r);
    }
  };
  walk(id);
  return out;
}

export interface BundledPluginsDirOptions {
  cloverHome?: string;
  realpath?: (p: string) => string;
  /** The manifest this core carries (default: its embedded one). An empty one means nothing is bundled. */
  manifest?: BundledManifest;
}

/** The candidate bundled plugins folder for the core at `execPath` by layout alone, or undefined when the layout
 *  isn't an installed one or the core carries no manifest. Every file in it still counts only through
 *  `readBundledFile`/`readBundledPlugin`. */
export function bundledPluginsDir(execPath: string, o: BundledPluginsDirOptions = {}): string | undefined {
  if (Object.keys((o.manifest ?? bundledManifest()).files).length === 0) return undefined;
  let real: string;
  try {
    real = (o.realpath ?? realpathSync)(execPath);
  } catch {
    return undefined;
  }
  const daemonDir = resolve(dirname(real));
  if (basename(daemonDir) !== "daemon") return undefined;
  const parent = dirname(daemonDir);
  const dir = join(parent, "plugins");
  const home = o.cloverHome === undefined ? undefined : resolve(o.cloverHome);
  // Never the user's own plugins folder.
  if (home !== undefined && dir === join(home, "plugins")) return undefined;
  if (home !== undefined && parent === join(home, "bin")) return dir;
  return basename(parent).toLowerCase() === "resources" ? dir : undefined;
}
