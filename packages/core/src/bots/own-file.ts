// Reading a file in a bot's own folders without following a link the bot left there (the fence review: a bot's runner
// can plant a link in its memory, routines or scratch that points at another bot's data, and the core, which runs
// unsandboxed, must never follow it). Owner: lane D. Lane C's `readOwnFile` / `refuseLinksIn` (#224, on lane/c-m2b)
// and `openChecked` (#205) take this one's place once they land on main. This one is stricter than C's today (review
// S1): it opens without blocking, refuses a file with a second name (a hard link) and caps the size, and it reads as the
// core from the Clover home down (the routine engine reads every bot's routines), where C's checks one caller's folders.
// The swap keeps all of that: lane C is asked to take O_NONBLOCK, the hard-link check and the size cap into its helper,
// so the swap changes nothing.
//
// * Every folder from `base` (a folder the bot can't change, such as the Clover home) down to the file must be a real
//   folder, not a link.
// * The file is opened without following a link at its name (`O_NOFOLLOW`) and without waiting (`O_NONBLOCK`, so a
//   named pipe the bot planted is opened at once and refused, never read from: a read would freeze the daemon's event
//   loop, review B1), and must be a regular file with one name (no hard link to something else), at most `maxBytes`.
// * After the open, its real path must be exactly where it was asked for under `base`'s real path, and be the opened
//   file (device and inode): a folder swapped for a link between the checks and the open is caught there.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
/** A named pipe opens at once instead of waiting for a writer; the regular-file check then refuses it. */
const NON_BLOCK = constants.O_NONBLOCK ?? 0;

export type OwnRead = { ok: true; data: Buffer; size: number } | { ok: false; why: "missing" | "link" | "not-a-file" | "too-large" | "moved" };

/** The file at `path` under `base`, read as above: up to `maxBytes` of it (`size` is its whole size), or why not. */
export function readOwnFile(base: string, path: string, opts: { maxBytes: number; whole?: boolean }): OwnRead {
  const rel = relative(base, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, why: "moved" };
  const parts = rel.split(sep);
  let at = base;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return { ok: false, why: "missing" };
    }
    if (st.isSymbolicLink()) return { ok: false, why: "link" };
    if (!st.isDirectory()) return { ok: false, why: "not-a-file" };
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, why: code === "ELOOP" || code === "EMLINK" ? "link" : "missing" };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1) return { ok: false, why: "not-a-file" };
    if (opts.whole && opened.size > opts.maxBytes) return { ok: false, why: "too-large" };
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return { ok: false, why: "moved" };
    }
    let expected: string;
    try {
      expected = join(realpathSync(base), rel);
    } catch {
      return { ok: false, why: "moved" };
    }
    const there = statSync(real, { throwIfNoEntry: false });
    if (real !== expected || there === undefined || there.ino !== opened.ino || there.dev !== opened.dev) return { ok: false, why: "moved" };
    const buf = Buffer.alloc(Math.min(opened.size, opts.maxBytes));
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    return { ok: true, data: buf.subarray(0, n), size: opened.size };
  } finally {
    closeSync(fd);
  }
}
