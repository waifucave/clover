// Files in a caller's own folders, for the unsandboxed core (B's file tools, the prompt loader, memory sync,
// routines, outputs). A runner can leave a symlink in its own folders pointing at another bot's data, and the core
// would follow it when it reads or writes there. These never follow a link: a read opens through `openChecked` —
// which judges the path as given and its real path from the handle, never following a link at the last component —
// and then refuses any link on the way in and any real path outside the caller's own folders. A write goes further:
// it creates a temp file next to the target, writes and syncs it, and renames it over the target, so the target is
// replaced atomically and a link at the target is replaced without being followed. A consumer that walks a folder
// instead guards it with `refuseLinksIn`.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import { isInsideFolded, type CallerFence } from "../contracts/fence";
import { foldPath } from "./fold";
import { fdRealPath, FenceRefused, openChecked } from "./open-checked";

/** Options for the core's own-file access. */
export interface OwnFileOpts {
  /** Fake for the handle's real path: Windows has no CI here, so tests fake it. Defaults to `fdRealPath`. */
  realPath?: (fd: number) => string | null;
}

/** The caller's own folders, from its bound policy: outputs, scratch, routines, plugin data and memory for writing,
 *  its bot folder in addition for reading. */
function ownRoots(caller: CallerFence, write: boolean): string[] {
  const p = caller.policy();
  const rw = [p.ownOutputs, p.ownScratch, p.ownRoutines, p.ownPluginData, p.ownMemory].filter((r): r is string => r !== undefined);
  return write ? rw : [...rw, ...(p.ownBot === undefined ? [] : [p.ownBot])];
}

/** Refuses when any component of `path` is a link, without following any of them. Callers pass absolute, canonical
 *  paths, as the fence judges them. */
function refuseLinkComponents(path: string): void {
  if (!isAbsolute(path)) throw new FenceRefused({ allowed: false, reason: "clover-home", path }, path);
  // Every prefix from the path itself up to (not including) the root.
  for (let at = path; ; ) {
    let isLink = false;
    try { isLink = lstatSync(at).isSymbolicLink(); } catch { isLink = false; } // missing: the open below refuses it
    if (isLink) throw new FenceRefused({ allowed: false, reason: "clover-home", path: at }, at);
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
}

/** Normalizes `..` and separators the way the caller's OS opens the path, for comparing a real path to the path. */
function normalForm(path: string, os: CallerFence["os"]): string {
  const p = os === "windows" ? win32 : posix;
  return foldPath(p.normalize(path), os);
}

/** The handle's real path, or a refusal when the OS won't say (fail closed). */
function handleRealPath(caller: CallerFence, fd: number, path: string, o: OwnFileOpts): string {
  const platform = caller.os === "macos" ? "darwin" : caller.os === "windows" ? "win32" : "linux";
  const real = o.realPath !== undefined ? o.realPath(fd) : fdRealPath(fd, platform, path);
  if (real === null) throw new FenceRefused({ allowed: false, reason: "clover-home", path }, path);
  return real;
}

/** Refuses when `real`, the handle's real path, isn't the path that was opened (a link was swapped in) or isn't
 *  inside the caller's own folders for this access. */
function refuseOutside(caller: CallerFence, real: string, path: string, write: boolean): void {
  if (normalForm(real, caller.os) !== normalForm(path, caller.os)) {
    throw new FenceRefused({ allowed: false, reason: "clover-home", path: real }, real);
  }
  if (!ownRoots(caller, write).some((r) => isInsideFolded(real, r, caller.os))) {
    throw new FenceRefused({ allowed: false, reason: "clover-home", path: real }, real);
  }
}

/** The whole file in the caller's own folders, read as above. Throws `FenceRefused` for a link on the way in or a
 *  real path outside them. */
export function readOwnFile(caller: CallerFence, path: string, o: OwnFileOpts = {}): Buffer {
  refuseLinkComponents(path);
  const fd = openChecked(caller, path);
  try {
    refuseOutside(caller, handleRealPath(caller, fd, path, o), path, false);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** The whole file in the caller's own folders, replaced atomically as above (created when it isn't there). Throws
 *  `FenceRefused` for a link on the way in or a real path outside them; the temp file is removed when anything
 *  fails. */
export function writeOwnFile(caller: CallerFence, path: string, data: string | Uint8Array): void {
  refuseLinkComponents(path);
  const write = { op: "write", path } as const;
  const first = caller.check(write);
  if (!first.allowed) throw new FenceRefused(first, path);
  if (!ownRoots(caller, true).some((r) => isInsideFolded(normalForm(path, caller.os), r, caller.os))) {
    throw new FenceRefused({ allowed: false, reason: "clover-home", path }, path);
  }
  // A temp file next to the target, created exclusively through `openChecked` (a fresh random suffix each try,
  // so a planted one can't be reused: the existence check makes the `O_EXCL` creation effective).
  let tmp = "";
  let fd = -1;
  for (let i = 0; i < 3 && fd === -1; i++) {
    const cand = `${path}.tmp-${randomBytes(8).toString("hex")}`;
    try { lstatSync(cand); continue; } catch { /* missing: create it */ }
    tmp = cand;
    fd = openChecked(caller, tmp, { write: true, create: true });
  }
  if (fd === -1) throw new FenceRefused({ allowed: false, reason: "clover-home", path }, path);
  try {
    const b = typeof data === "string" ? Buffer.from(data) : data;
    for (let off = 0; off < b.length;) off += writeSync(fd, b, off, b.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    // Narrow the plant-then-rename window: the way in must still be link-free before the rename lands.
    refuseLinkComponents(path);
    renameSync(tmp, path);
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* gone */ } }
    try { unlinkSync(tmp); } catch { /* landed, or never made */ }
  }
}

/** Refuses when `ownFolder` itself or anything under it is a link. This is a walk done in advance: consumers must
 *  still open each file through `readOwnFile` or `writeOwnFile`, which judge every open. Throws `FenceRefused`
 *  naming the link. */
export function refuseLinksIn(ownFolder: string): void {
  try {
    if (lstatSync(ownFolder).isSymbolicLink()) throw new FenceRefused({ allowed: false, reason: "clover-home", path: ownFolder }, ownFolder);
  } catch (e) {
    if (e instanceof FenceRefused) throw e;
    return; // missing or unreadable: the open below refuses it
  }
  const stack = [ownFolder];
  while (stack.length > 0) {
    const at = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(at); } catch { continue; } // unreadable: the open below refuses it
    for (const name of entries) {
      const p = join(at, name);
      let st: ReturnType<typeof lstatSync> | undefined;
      try { st = lstatSync(p); } catch { continue; } // gone: the open below refuses it
      if (st.isSymbolicLink()) throw new FenceRefused({ allowed: false, reason: "clover-home", path: p }, p);
      if (st.isDirectory()) stack.push(p);
    }
  }
}
