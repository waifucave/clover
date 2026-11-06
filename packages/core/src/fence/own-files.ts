// Files in a caller's own folders, for the unsandboxed core (B's file tools, the prompt loader, memory sync,
// routines, outputs). A runner can leave a symlink in its own folders pointing at another bot's data, and the core
// would follow it when it reads or writes there. These open through `openChecked` — which judges the path as given
// and its real path from the handle, never following a link at the last component — and then refuse any link on the
// way in and any real path outside the caller's own folders. A consumer that walks a folder instead guards it with
// `refuseLinksIn`.
import { closeSync, lstatSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import { isInsideFolded, type CallerFence } from "../contracts/fence";
import { foldPath } from "./fold";
import { fdRealPath, FenceRefused, openChecked } from "./open-checked";

/** The caller's own folders, from its bound policy: outputs, scratch, routines, plugin data and memory for writing,
 *  its bot folder in addition for reading. */
function ownRoots(caller: CallerFence, write: boolean): string[] {
  const p = caller.policy();
  const rw = [p.ownOutputs, p.ownScratch, p.ownRoutines, p.ownPluginData, p.ownMemory].filter((r): r is string => r !== undefined);
  return write ? rw : [...rw, ...(p.ownBot === undefined ? [] : [p.ownBot])];
}

/** Refuses when any component of `path` is a link, without following any of them. */
function refuseLinkComponents(path: string): void {
  const abs = path; // callers pass absolute paths; a relative one has no anchor to judge
  if (!isAbsolute(abs)) throw new FenceRefused({ allowed: false, reason: "clover-home", path }, path);
  // Every prefix from the path itself up to (not including) the root.
  for (let at = abs; ; ) {
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(at); } catch { st = undefined; }
    if (st !== undefined && st.isSymbolicLink()) throw new FenceRefused({ allowed: false, reason: "clover-home", path: at }, at);
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

/** Opens `path` for `caller` as above: no link on the way in, and a real path inside its own folders. The caller
 *  closes the descriptor. Throws `FenceRefused`, or the open's own error. */
function openOwn(caller: CallerFence, path: string, write: boolean): number {
  refuseLinkComponents(path);
  const fd = openChecked(caller, path, write ? { write: true, create: true, truncate: true } : {});
  try {
    const real = fdRealPath(fd);
    if (real === null || normalForm(real, caller.os) !== normalForm(path, caller.os)) {
      throw new FenceRefused({ allowed: false, reason: "clover-home", path: real ?? path }, real ?? path);
    }
    if (!ownRoots(caller, write).some((r) => isInsideFolded(real, r, caller.os))) {
      throw new FenceRefused({ allowed: false, reason: "clover-home", path: real }, real);
    }
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** The whole file in the caller's own folders, read as above. Throws `FenceRefused` for a link on the way in or a
 *  real path outside them. */
export function readOwnFile(caller: CallerFence, path: string): Buffer {
  const fd = openOwn(caller, path, false);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

/** The whole file in the caller's own folders, replaced as above (created when it isn't there). Throws
 *  `FenceRefused` for a link on the way in or a real path outside them. */
export function writeOwnFile(caller: CallerFence, path: string, data: string | Uint8Array): void {
  const fd = openOwn(caller, path, true);
  try {
    const b = typeof data === "string" ? Buffer.from(data) : data;
    for (let off = 0; off < b.length;) off += writeSync(fd, b, off, b.length - off);
  } finally { closeSync(fd); }
}

/** Refuses when `ownFolder` itself or anything under it is a link, for a consumer that walks a folder (memory sync,
 *  routines) instead of opening one file. Throws `FenceRefused` naming the link. */
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
