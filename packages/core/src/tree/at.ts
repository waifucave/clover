// Changes anchored to folders, not paths (J-M1 review minor 6): libc's `openat`, `mkdirat`, `unlinkat` and `renameat`
// through Bun's FFI, since Bun has none of them. Each folder on the way is opened relative to the one above it and
// never through a link (`O_NOFOLLOW`), so a folder swapped for a link between the holder's checks and the change
// can't carry the change anywhere else: the walk fails instead (`refused`).
//
// macOS and Linux (glibc). Elsewhere, or where libc can't be loaded, `atOps()` is null and the holder keeps its checked
// path calls; on Windows that is the plan until a native add-on brings handle-relative opens.
//
// A recursive remove lists each folder by its path, but removes every entry relative to that folder's own open
// handle: a listing taken from a swapped folder names things that aren't in the pinned one (`ENOENT`, skipped) or are
// (removed, as asked); nothing outside the pinned tree is touched, and a folder left non-empty fails the remove.
import { dlopen, read } from "bun:ffi";
import { constants as FS, readdirSync } from "node:fs";
import { constants as OS } from "node:os";
import { join } from "node:path";
import { ContractError } from "../contracts/common";

type Libc = {
  /** Renames, failing with `EEXIST` rather than replacing what's there: Linux's `renameat2(…, RENAME_NOREPLACE)`, or
   *  macOS's `renameatx_np(…, RENAME_EXCL)`; null where the C library has neither. */
  renameNoReplace: ((fromfd: number, from: Uint8Array, tofd: number, to: Uint8Array) => number) | null;
  openat(dirfd: number, path: Uint8Array, flags: number, mode: number): number;
  mkdirat(dirfd: number, path: Uint8Array, mode: number): number;
  unlinkat(dirfd: number, path: Uint8Array, flags: number): number;
  renameat(fromfd: number, from: Uint8Array, tofd: number, to: Uint8Array): number;
  close(fd: number): number;
  errno(): number;
};

const E = OS.errno;
let loaded: Libc | null | undefined;

function libc(): Libc | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  const lib = process.platform === "darwin" ? "libc.dylib" : process.platform === "linux" ? "libc.so.6" : null;
  if (!lib) return null;
  try {
    const errnoName = process.platform === "darwin" ? "__error" : "__errno_location";
    const { symbols: s } = dlopen(lib, {
      openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
      mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
      unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
      renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
      close: { args: ["i32"], returns: "i32" },
      [errnoName]: { args: [], returns: "ptr" },
    });
    const at = s as unknown as Record<string, (...a: unknown[]) => unknown>;
    // Optional: an older C library without it keeps the rest.
    let noReplace: Libc["renameNoReplace"] = null;
    try {
      const name = process.platform === "darwin" ? "renameatx_np" : "renameat2";
      const flag = process.platform === "darwin" ? 0x4 : 0x1; // RENAME_EXCL, RENAME_NOREPLACE
      const { symbols: r } = dlopen(lib, { [name]: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" } });
      const fn = (r as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
      noReplace = (a, b, c, d) => fn(a, b, c, d, flag) as number;
    } catch {
      noReplace = null;
    }
    loaded = {
      renameNoReplace: noReplace,
      openat: (d, p, f, m) => at.openat!(d, p, f, m) as number,
      mkdirat: (d, p, m) => at.mkdirat!(d, p, m) as number,
      unlinkat: (d, p, f) => at.unlinkat!(d, p, f) as number,
      renameat: (a, b, c, d) => at.renameat!(a, b, c, d) as number,
      close: (fd) => at.close!(fd) as number,
      errno: () => read.i32(at[errnoName]!() as never, 0),
    };
  } catch {
    loaded = null;
  }
  return loaded;
}

const AT_FDCWD = process.platform === "darwin" ? -2 : -100;
const AT_REMOVEDIR = process.platform === "darwin" ? 0x80 : 0x200;
const DIR_FLAGS = FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0);
const z = (s: string) => Buffer.from(`${s}\0`);

/** The anchored changes, or null where they aren't available. */
export interface AtOps {
  /** Makes the folders `rel` under `root` that are missing, each through the one above it. */
  mkdirs(root: string, rel: readonly string[], label: string): void;
  /** Removes `rel` under `root`: a file or link, an empty folder, or with `recursive` a folder and all inside. */
  remove(root: string, rel: readonly string[], o: { dir: boolean; recursive: boolean }, label: string): void;
  /** Renames `fromRel` under `fromRoot` to `toRel` under `toRoot`. */
  rename(fromRoot: string, fromRel: readonly string[], toRoot: string, toRel: readonly string[], label: string): void;
  /** Renames within one folder, never over something that's there (`conflict`); false where the C library can't. */
  renameNew(root: string, dirRel: readonly string[], from: string, to: string, label: string): boolean;
}

function fail(c: Libc, what: string, label: string): never {
  const n = c.errno();
  if (n === E.ENOENT) throw new ContractError("not_found", `${label} doesn't exist`);
  if (n === E.EEXIST) throw new ContractError("conflict", `${label} already exists`);
  if (n === E.ENOTEMPTY) throw new ContractError("invalid", `${label} isn't empty`);
  if (n === E.EISDIR) throw new ContractError("invalid", `${label} is a folder`);
  if (n === E.ELOOP || n === E.ENOTDIR || n === E.EMLINK) throw new ContractError("refused", `a folder on the way to ${label} is a link, or changed while it was being changed`);
  if (n === E.EACCES || n === E.EPERM) throw new ContractError("refused", `${label}: permission denied`);
  if (n === E.EXDEV) throw new ContractError("invalid", `${label} is on another disk`);
  throw new ContractError("failed", `${label}: ${what} failed (errno ${n})`);
}

/** Opens `rel` under `root` as a folder, each step without following a link. */
function openDir(c: Libc, root: string, rel: readonly string[], label: string): number {
  let fd = c.openat(AT_FDCWD, z(root), DIR_FLAGS, 0);
  if (fd < 0) fail(c, "open", label);
  for (const seg of rel) {
    const next = c.openat(fd, z(seg), DIR_FLAGS, 0);
    if (next < 0) {
      const err = (() => { try { fail(c, "open", label); } catch (e) { return e; } })();
      c.close(fd);
      throw err;
    }
    c.close(fd);
    fd = next;
  }
  return fd;
}

function withDir<T>(c: Libc, root: string, rel: readonly string[], label: string, fn: (fd: number) => T): T {
  const fd = openDir(c, root, rel, label);
  try {
    return fn(fd);
  } finally {
    c.close(fd);
  }
}

/** Removes the folder `name` in `parent` and everything inside, every entry relative to its own folder's handle. */
function removeTree(c: Libc, parent: number, name: string, listPath: string, label: string): void {
  if (c.unlinkat(parent, z(name), 0) === 0) return; // a file or a link
  const first = c.errno();
  if (first === E.ENOENT) return;
  if (first !== E.EISDIR && first !== E.EPERM) fail(c, "remove", label);
  const fd = c.openat(parent, z(name), DIR_FLAGS, 0);
  if (fd < 0) fail(c, "open", label);
  try {
    let names: string[] = [];
    try {
      names = readdirSync(listPath);
    } catch {
      names = [];
    }
    for (const child of names) removeTree(c, fd, child, join(listPath, child), label);
  } finally {
    c.close(fd);
  }
  if (c.unlinkat(parent, z(name), AT_REMOVEDIR) !== 0) fail(c, "remove", label);
}

export function atOps(): AtOps | null {
  const c = libc();
  if (!c) return null;
  return {
    mkdirs(root, rel, label) {
      let fd = c.openat(AT_FDCWD, z(root), DIR_FLAGS, 0);
      if (fd < 0) fail(c, "open", label);
      try {
        for (const seg of rel) {
          let next = c.openat(fd, z(seg), DIR_FLAGS, 0);
          if (next < 0 && c.errno() === E.ENOENT) {
            if (c.mkdirat(fd, z(seg), 0o777) !== 0 && c.errno() !== E.EEXIST) fail(c, "mkdir", label);
            next = c.openat(fd, z(seg), DIR_FLAGS, 0);
          }
          if (next < 0) fail(c, "open", label);
          c.close(fd);
          fd = next;
        }
      } finally {
        c.close(fd);
      }
    },
    remove(root, rel, o, label) {
      if (rel.length === 0) throw new ContractError("invalid", `${label} is a whole area of the tree`);
      const name = rel[rel.length - 1]!;
      withDir(c, root, rel.slice(0, -1), label, (fd) => {
        if (o.recursive && o.dir) return removeTree(c, fd, name, join(root, ...rel), label);
        if (c.unlinkat(fd, z(name), o.dir ? AT_REMOVEDIR : 0) !== 0) fail(c, "remove", label);
      });
    },
    renameNew(root, dirRel, from, to, label) {
      const nr = c.renameNoReplace;
      if (!nr) return false;
      withDir(c, root, dirRel, label, (fd) => {
        if (nr(fd, z(from), fd, z(to)) !== 0) fail(c, "rename", label);
      });
      return true;
    },
    rename(fromRoot, fromRel, toRoot, toRel, label) {
      if (fromRel.length === 0 || toRel.length === 0) throw new ContractError("invalid", `${label} is a whole area of the tree`);
      withDir(c, fromRoot, fromRel.slice(0, -1), label, (a) => withDir(c, toRoot, toRel.slice(0, -1), label, (b) => {
        if (c.renameat(a, z(fromRel[fromRel.length - 1]!), b, z(toRel[toRel.length - 1]!)) !== 0) fail(c, "rename", label);
      }));
    },
  };
}
