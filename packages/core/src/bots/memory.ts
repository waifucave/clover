// A bot's persistent memory on this computer (spec §6.5): `MEMORY.md`, the index the bot keeps, and the memory files
// it links to, in `<home>/bots/<bot>/memory/`. There is no memory tool: bots read and write these with `Bash` and the
// file tools. The core seeds a bot's starter memories once (§5.9 `memory`), and lists and reads the folder for
// `memory.list` and `memory.read` (`memory.read` capability). Syncing it, and merging after a takeover, are lane H's
// (§6.5, §8.5). Owner: lane D.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MemoryEntry } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";

export const MEMORY_INDEX = "MEMORY.md";
/** What seeding copies at most: a bot's starter memories are a few Markdown files, not a disk. */
export const SEED_MAX_FILES = 500;
export const SEED_MAX_BYTES = 8 * 1024 * 1024;
/** What listing walks at most, and the largest file `memory.read` returns. */
export const LIST_MAX_ENTRIES = 5_000;
export const READ_MAX_BYTES = 1024 * 1024;

/** Copies a plugin's starter memories into the bot's memory folder: regular files only, never over a file already
 *  there, never through a symlink. Returns how many it copied. */
export function seedMemory(from: string, to: string, warn: (message: string) => void = () => {}): number {
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
        if (!walk(s, d)) return false;
        continue;
      }
      if (!st.isFile()) continue;
      if (files + 1 > SEED_MAX_FILES || bytes + st.size > SEED_MAX_BYTES) {
        warn(`starter memories past ${SEED_MAX_FILES} files or ${SEED_MAX_BYTES} bytes were not copied`);
        return false;
      }
      if (existsSync(d)) continue;
      mkdirSync(dest, { recursive: true });
      copyFileSync(s, d);
      files++;
      bytes += st.size;
    }
    return true;
  };
  mkdirSync(to, { recursive: true });
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
