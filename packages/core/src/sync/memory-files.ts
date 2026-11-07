// A bot's memory folder on disk, as the memory sync reads and writes it (H-M3, the owner's decision: each bot's memory
// is `home/memory` in its tree, `<Clover home>/bots/<bot>/memory/` here, synced across the user's computers).
//
// * **Paths:** a synced path is relative to the bot's memory folder, `/` between names, Unicode NFC. Its key, which
//   two computers compare it by, is every name folded (NFC, then case), as APFS and NTFS compare them, so `memory.md`
//   and `MEMORY.md` are one file everywhere, a case-sensitive Linux disk included. `..`, `.`, empty names, absolute
//   paths, drive letters and backslashes are refused, so nothing synced leaves the bot's memory folder.
// * **Writes never follow a link:** each folder on the way must be a real folder (an existing one is matched by its
//   folded name, so a write lands on the name the disk already has), the new content goes to a fresh file made with
//   `O_CREAT | O_EXCL | O_NOFOLLOW` beside the target, the folder's real path is checked against the memory folder's,
//   and the file is renamed over the target, which replaces a link there rather than writing through it. Lane C's
//   `writeChecked`/`writeOwnFile` aren't on main yet (#205, and #224 merged without them); this is the brief's stand-in.
// * **Reads never follow a link either** (a bot's runner could leave one in its own memory pointing at another bot's
//   `MEMORY.md`, and this sync runs as the core, outside the fence): the scan lists regular files only, never going
//   into a linked folder; every folder from the home down to the file must be a real one; the file is opened with
//   `O_NOFOLLOW`, and what was opened must be, by its device and inode, the file at a real path inside the bot's own
//   memory folder. A file with more than one link (a hard link to another file) is never read. Lane C's
//   `readOwnFile` isn't on main yet; this is the brief's stand-in.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { foldName } from "../tree/names";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
/** The prefix of the sync's own temporary files, which are never synced. */
export const TEMP_PREFIX = ".clover-sync-";
/** Files the OS makes that are never memory. */
const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
export const MAX_DEPTH = 16;
export const MAX_PATH_CHARS = 1024;

/** Why a path is refused, or its parts: the names as given (NFC) and the key. */
export function memoryPath(rel: unknown): { names: string[]; rel: string; key: string } | { refused: string } {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > MAX_PATH_CHARS) return { refused: "not a path" };
  const nfc = rel.normalize("NFC");
  if (nfc.startsWith("/") || nfc.includes("\\") || nfc.includes("\0") || /^[A-Za-z]:/.test(nfc)) return { refused: "not inside the memory folder" };
  const names = nfc.split("/");
  if (names.length > MAX_DEPTH) return { refused: "too deep" };
  for (const n of names) {
    if (n === "" || n === "." || n === "..") return { refused: "not inside the memory folder" };
    // A name no disk of the user's could hold alike (Windows refuses these), or the sync's own temporary files.
    if (/[<>:"|?*\u0000-\u001f]/.test(n) || /[. ]$/.test(n)) return { refused: "a name not every computer can hold" };
    if (n.startsWith(TEMP_PREFIX) || JUNK.has(n.toLowerCase())) return { refused: "not memory" };
  }
  return { names, rel: names.join("/"), key: names.map((n) => foldName(n, "linux")).join("/") };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface DiskFile {
  rel: string;
  key: string;
  size: number;
  mtimeMs: number;
}

/** The regular files in a memory folder, never through a link; at most `max` (more is `over: true`). A folder that
 *  isn't there is empty. */
export function listMemory(base: string, root: string, max: number): { files: DiskFile[]; over: boolean } {
  const files: DiskFile[] = [];
  let over = false;
  const walk = (dir: string, prefix: string[], depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (over) return;
      const st = lstatSync(join(dir, name), { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      const parts = [...prefix, name];
      if (st.isDirectory()) {
        if (depth + 1 < MAX_DEPTH) walk(join(dir, name), parts, depth + 1);
        continue;
      }
      if (!st.isFile() || st.nlink > 1) continue;
      const p = memoryPath(parts.join("/"));
      if ("refused" in p) continue;
      if (files.length >= max) {
        over = true;
        return;
      }
      files.push({ rel: p.rel, key: p.key, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  if (realRoot(base, root) !== undefined) walk(root, [], 0);
  return { files, over };
}

/** A memory file's bytes, read without following a link; undefined when it's gone, a link, not a file, or bigger than
 *  `max`. */
export function readMemoryFile(base: string, root: string, rel: string, max: number, o: { exact?: boolean } = {}): { data: Buffer; mtimeMs: number } | undefined {
  const rootReal = realRoot(base, root);
  if (rootReal === undefined) return undefined;
  const at = resolveExisting(root, rel.split("/"), o.exact === true);
  if (!at) return undefined;
  let fd: number;
  try {
    fd = openSync(at, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max || st.nlink > 1) return undefined;
    // What was opened is the file at a real path inside this bot's memory folder, by its device and inode: a folder
    // swapped for a link after the walk is caught here.
    let real: string;
    try {
      real = realpathSync(at);
    } catch {
      return undefined;
    }
    const inside = relative(rootReal, real);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
    const there = lstatSync(real, { throwIfNoEntry: false });
    if (!there || there.ino !== st.ino || there.dev !== st.dev) return undefined;
    return { data: readFileSync(fd), mtimeMs: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** Writes a memory file without following a link anywhere on the way; returns the name it has on disk, `/` between
 *  names, and its mtime. Throws on a link or a non-folder in the way, or a folder at the target. */
export function writeMemoryFile(base: string, root: string, names: readonly string[], data: Uint8Array, o: { /** TEST-ONLY: runs right before the rename, the window a swap would use. */ beforeChange?: () => void } = {}): { rel: string; mtimeMs: number } {
  const dir = realFolders(base, root, names.slice(0, -1), true)!;
  const want = names.at(-1)!;
  const name = existingName(dir.path, want) ?? want;
  const target = join(dir.path, name);
  const now = lstatSync(target, { throwIfNoEntry: false });
  if (now?.isDirectory()) throw new Error(`a folder is in the way at ${name}`);
  const tmp = join(dir.path, `${TEMP_PREFIX}${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o644);
  let mtimeMs: number;
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    mtimeMs = fstatSync(fd).mtimeMs;
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);
  // The folder must still be where the memory folder really is: one swapped for a link meanwhile is caught here.
  o.beforeChange?.();
  if (!sameRealFolder(dir.path, dir.real)) {
    try {
      unlinkSync(tmp);
    } catch {
      // gone with the folder
    }
    throw new Error("a folder changed while memory was written");
  }
  renameSync(tmp, target);
  return { rel: [...dir.names, name].join("/"), mtimeMs };
}

/** Removes a memory file (a link at its place is removed itself, never followed); false when nothing was there. */
export function removeMemoryFile(base: string, root: string, names: readonly string[], o: { exact?: boolean; /** TEST-ONLY: runs right before the unlink. */ beforeChange?: () => void } = {}): boolean {
  const dir = realFolders(base, root, names.slice(0, -1), false);
  if (!dir) return false;
  const name = existingName(dir.path, names.at(-1)!, o.exact === true);
  if (name === undefined) return false;
  const target = join(dir.path, name);
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st || st.isDirectory()) return false;
  // The folder must still be where the memory folder really is (#232's review, S1): one swapped for a link since it
  // was walked is caught here, right before the unlink.
  o.beforeChange?.();
  if (!sameRealFolder(dir.path, dir.real)) throw new Error("a folder changed while memory was removed");
  unlinkSync(target);
  return true;
}

/** The entry in `dir` whose name folds equal to `want` (the exact name first). */
function existingName(dir: string, want: string, exact = false): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (names.includes(want)) return want;
  if (exact) return undefined;
  const f = foldName(want, "linux");
  return names.find((n) => foldName(n.normalize("NFC"), "linux") === f);
}

/** The path of an existing entry, each name matched by fold, every folder on the way a real one. */
function resolveExisting(root: string, names: readonly string[], exact = false): string | undefined {
  const top = lstatSync(root, { throwIfNoEntry: false });
  if (!top?.isDirectory() || top.isSymbolicLink()) return undefined;
  let at = root;
  for (let i = 0; i < names.length; i++) {
    const n = existingName(at, names[i]!, exact);
    if (n === undefined) return undefined;
    at = join(at, n);
    if (i < names.length - 1) {
      const st = lstatSync(at, { throwIfNoEntry: false });
      if (!st?.isDirectory() || st.isSymbolicLink()) return undefined;
    }
  }
  return at;
}

/** Walks (and with `make`, makes) the folders from `base` down to `root` and then `names`, each a real folder, never a
 *  link. Returns the last one's path, its real path and the names it has on disk; undefined when one is missing and
 *  `make` is false. */
function realFolders(base: string, root: string, names: readonly string[], make: boolean): { path: string; real: string; names: string[] } | undefined {
  const rel = relative(base, root);
  if (rel === "" || rel.startsWith("..")) throw new Error("the memory folder isn't inside the home");
  let at = base;
  // Where each folder really is, step by step (#232's review, S1): a folder swapped for a link between its check and
  // the next step (an mkdir in it, say) shows as a real path that isn't the one expected, and the walk stops.
  let real = realpathSync(base);
  const step = (name: string, matchFold: boolean): boolean => {
    const n = matchFold ? (existingName(at, name) ?? name) : name;
    const next = join(at, n);
    let st = lstatSync(next, { throwIfNoEntry: false });
    if (!st) {
      if (!make) return false;
      if (!sameRealFolder(at, real)) throw new Error("a folder changed while memory was written");
      try {
        mkdirSync(next);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      st = lstatSync(next);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${n} is a link or not a folder`);
    const nextReal = realpathSync(next);
    if (nextReal !== join(real, n) && relative(real, nextReal) !== n) throw new Error(`${n} isn't where its folder is`);
    at = next;
    real = nextReal;
    if (matchFold) onDisk.push(n);
    return true;
  };
  const onDisk: string[] = [];
  for (const part of rel.split(sep)) if (!step(part, false)) return undefined;
  const rootReal = real;
  for (const name of names) if (!step(name, true)) return undefined;
  const inside = relative(rootReal, real);
  if (inside.startsWith("..") || inside.startsWith(sep)) throw new Error("a folder on the way leaves the memory folder");
  return { path: at, real, names: onDisk };
}

/** The memory folder's real path when every folder from `base` (the home) down to it is a real folder, never a link;
 *  undefined otherwise or when it isn't there. */
function realRoot(base: string, root: string): string | undefined {
  const rel = relative(base, root);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  let at = base;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return undefined;
  }
  try {
    const real = realpathSync(at);
    const baseReal = realpathSync(base);
    return relative(baseReal, real) === rel ? real : undefined;
  } catch {
    return undefined;
  }
}

function sameRealFolder(path: string, real: string): boolean {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && st.isDirectory() && realpathSync(path) === real;
  } catch {
    return false;
  }
}
