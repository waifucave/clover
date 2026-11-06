// A bot's persistent memory on this computer (spec §6.5): `MEMORY.md`, the index the bot keeps, and the memory files
// it links to, stored in `<home>/bots/<bot>/memory/` and named `home/memory/` in the bot's folder tree (lane J maps it,
// lane H syncs it across the user's computers). There is no memory tool: the bot's own sessions read and write these
// with Read, Write and Edit, and no other session reaches them (the per-caller fence). The core seeds a bot's starter memories once (§5.9 `memory`), and lists and reads the folder for
// `memory.list` and `memory.read` (`memory.read` capability). Syncing it, and merging after a takeover, are lane H's
// (§6.5, §8.5). Owner: lane D.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MemoryEntry } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";

export const MEMORY_INDEX = "MEMORY.md";
/** What seeding copies at most: a bot's starter memories are a few Markdown files, not a disk. */
export const SEED_MAX_FILES = 500;
export const SEED_MAX_BYTES = 8 * 1024 * 1024;
/** What listing walks at most, and the largest file `memory.read` returns. */
export const LIST_MAX_ENTRIES = 5_000;
export const READ_MAX_BYTES = 1024 * 1024;

/** `O_NOFOLLOW` where the system has it (not on Windows, where a bot can't make links without the user's say). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** A folder the core writes into, made if missing; false when the path is a link or not a folder. */
function realFolder(path: string): boolean {
  try {
    mkdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = lstatSync(path);
  return st.isDirectory() && !st.isSymbolicLink();
}

/** Copies a plugin's starter memories into the bot's memory folder (spec §5.9 `memory`): regular files only, read
 *  without following a link; never over anything already there; and never through a link the bot planted in its
 *  memory, since this runs as the core, outside the fence. Each folder on the way, from `base` (the home) down, must be
 *  a real folder, and each file is created with `O_CREAT | O_EXCL | O_NOFOLLOW`, which fails on any name already taken,
 *  a dangling link included. A folder swapped for a link after it was checked is caught before a byte is written: the
 *  new file must be where the memory folder really is, by its real path and its device and inode (as the inherited
 *  image staging checks), or it is removed. A seed file with more than one link (a hard link to something else) is
 *  skipped. Returns how many it copied. */
export function seedMemory(
  from: string,
  to: string,
  opts: { base: string; warn?: (message: string) => void; /** TEST-ONLY: runs right before each file is created, the window a swap would use. */ beforeCreate?: (path: string) => void },
): number {
  const warn = opts.warn ?? (() => {});
  const rel = relative(opts.base, to);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new ContractError("invalid", `the memory folder ${to} isn't inside ${opts.base}`);
  let at = opts.base;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    if (!realFolder(at)) {
      warn(`starter memories weren't copied: ${at} is a link or not a folder`);
      return 0;
    }
  }
  const realTo = realpathSync(to);
  let realFrom: string;
  try {
    realFrom = realpathSync(from);
  } catch {
    return 0;
  }
  let files = 0;
  let bytes = 0;
  const walk = (src: string, dest: string): boolean => {
    for (const name of readdirSync(src).sort()) {
      if (name === ".DS_Store" || name === "Thumbs.db" || name === ".git") continue;
      const s = join(src, name);
      const d = join(dest, name);
      const st = lstatSync(s);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!realFolder(d)) {
          warn(`starter memories under ${d} weren't copied: it is a link or not a folder`);
          continue;
        }
        if (!walk(s, d)) return false;
        continue;
      }
      if (!st.isFile()) continue;
      if (files + 1 > SEED_MAX_FILES || bytes + st.size > SEED_MAX_BYTES) {
        warn(`starter memories past ${SEED_MAX_FILES} files or ${SEED_MAX_BYTES} bytes were not copied`);
        return false;
      }
      let data: Buffer;
      const inFd = openSync(s, constants.O_RDONLY | NO_FOLLOW);
      try {
        const opened = fstatSync(inFd);
        if (!opened.isFile() || opened.nlink > 1) {
          warn(`the starter memory ${s} wasn't copied: it isn't a file of its own`);
          continue;
        }
        // Read where it was asked for, not through a folder swapped for a link on the way (the fence review).
        let realSrc = "";
        try { realSrc = realpathSync(s); } catch { /* gone */ }
        const srcThere = realSrc === "" ? undefined : statSync(realSrc, { throwIfNoEntry: false });
        if (realSrc !== join(realFrom, relative(from, s)) || srcThere === undefined || srcThere.ino !== opened.ino || srcThere.dev !== opened.dev) {
          warn(`the starter memory ${s} wasn't copied: it is under a link`);
          continue;
        }
        data = readFileSync(inFd);
      } finally {
        closeSync(inFd);
      }
      let outFd: number;
      opts.beforeCreate?.(d);
      try {
        outFd = openSync(d, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o644);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue; // the bot's own file, or a link: left alone
        throw err;
      }
      try {
        // The new file must be where the memory folder really is, before a single byte is written.
        const made = fstatSync(outFd);
        let real = "";
        try {
          real = realpathSync(d);
        } catch {
          // gone already: not ours
        }
        const there = real === "" ? undefined : statSync(real, { throwIfNoEntry: false });
        if (real !== join(realTo, relative(to, d)) || there === undefined || there.ino !== made.ino || there.dev !== made.dev) {
          warn(`starter memories under ${dirname(d)} weren't copied: a folder changed while they were`);
          const now = lstatSync(d, { throwIfNoEntry: false });
          if (now !== undefined && now.ino === made.ino && now.dev === made.dev) unlinkSync(d);
          return false;
        }
        let written = 0;
        while (written < data.length) written += writeSync(outFd, data, written, data.length - written);
      } finally {
        closeSync(outFd);
      }
      files++;
      bytes += data.length;
    }
    return true;
  };
  walk(from, to);
  return files;
}

/** The memory folder's files: `MEMORY.md` first, then the rest by path, with `/` as the separator. */
export function listMemory(dir: string): MemoryEntry[] {
  if (!existsSync(dir)) return [];
  const out: MemoryEntry[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder).sort()) {
      if (out.length >= LIST_MAX_ENTRIES) return;
      const full = join(folder, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ path: relative(dir, full).split(sep).join("/"), size: st.size, modifiedAt: Math.floor(st.mtimeMs) });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path === MEMORY_INDEX ? -1 : b.path === MEMORY_INDEX ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One memory file's text. The path is relative to the memory folder, and may not lead out of it. */
export function readMemory(dir: string, path: string): string {
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new ContractError("invalid", `"${path}" isn't a path inside the bot's memory`);
  const full = resolve(dir, path);
  if (!existsSync(full)) throw new ContractError("not_found", `the bot has no memory file "${path}"`);
  const real = realpathSync(full);
  const root = realpathSync(dir);
  if (!real.startsWith(root + sep)) throw new ContractError("invalid", `"${path}" leads out of the bot's memory`);
  const st = statSync(real);
  if (!st.isFile()) throw new ContractError("invalid", `"${path}" isn't a file`);
  if (st.size > READ_MAX_BYTES) throw new ContractError("refused", `"${path}" is larger than ${READ_MAX_BYTES} bytes`);
  return readFileSync(real, "utf8");
}
