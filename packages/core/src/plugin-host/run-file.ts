// The files a plugin process starts from (the host's two bundles, the load guards, the bunfig): written whole and
// checked by their SHA-256 right before they run (#312's review, S1, the same principle as #322's S2). Node builtins
// only: the host bundle (process-main.ts → mux.ts) carries this module, and checks each worker's files with it.
//
// What this closes, and what it doesn't. A plugin has node:fs (its guard confines what it LOADS, not what it writes), and
// runs as the user, so it can rewrite the run folder's files between two starts. Now:
//   - a file is written to a fresh temporary name (created exclusively, never through a link) and renamed into place,
//     so a planted link at the name is replaced, never followed, and no reader sees half a file;
//   - before a process or a worker starts from a file, the file is read once more (never through a link) and its
//     SHA-256 compared with the text Clover wrote; a changed file refuses the start.
// The remaining limit: a process of the same user can still swap a file in the moment between that check and the
// exec (or the Worker's own read of it). Closing that needs the bytes handed over without a path, which Bun's
// `--preload` and `new Worker(path)` don't take.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A file a start depends on, and the SHA-256 (hex) of the text it must hold. */
export interface RunFileCheck { path: string; sha256: string }

export const sha256Hex = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/** The file's bytes, read once without following a last-segment link, or undefined when it isn't a regular file. */
export function readRunFile(path: string): Uint8Array | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    const bytes = new Uint8Array(st.size);
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return at === bytes.length ? bytes : undefined;
  } finally {
    closeSync(fd);
  }
}

/** Writes `text` to `path` whole: a fresh temporary file beside it (created exclusively, mode 0600, never through a
 *  link), then renamed over the name, so a link planted at `path` is replaced, never written through. Skipped when the
 *  file already holds exactly `text` (read without following a link). */
export function writeRunFile(path: string, text: string): void {
  const current = readRunFile(path);
  if (current !== undefined && Buffer.from(current).equals(Buffer.from(text))) return;
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(text);
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(temp); } catch { /* gone */ }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* gone */ }
    throw err;
  }
}

/** Refuses (throws) unless every file holds the text it was written with: read once, never through a link, and its
 *  SHA-256 compared. Call it immediately before the start that depends on the files. */
export function checkRunFiles(checks: readonly RunFileCheck[], what: string): void {
  for (const c of checks) {
    const bytes = readRunFile(c.path);
    if (bytes === undefined) throw new Error(`${what}: ${c.path} isn't a regular file Clover wrote (missing, or a link); it doesn't start`);
    if (sha256Hex(bytes) !== c.sha256) throw new Error(`${what}: ${c.path} changed since Clover wrote it (its SHA-256 differs); it doesn't start`);
  }
}

/** The argv form of a check, `--clover-check=<sha256>:<path>`, which the host process reads (never the environment). */
export const RUN_CHECK_ARG = "--clover-check=";

export function runCheckArgs(checks: readonly RunFileCheck[]): string[] {
  return checks.map((c) => `${RUN_CHECK_ARG}${c.sha256}:${c.path}`);
}

/** The checks named in `argv` (`runCheckArgs`'s form); anything else is ignored. A malformed one throws. */
export function parseRunCheckArgs(argv: readonly string[]): RunFileCheck[] {
  return argv.filter((a) => a.startsWith(RUN_CHECK_ARG)).map((a) => {
    const m = /^([0-9a-f]{64}):(.+)$/.exec(a.slice(RUN_CHECK_ARG.length));
    if (m === null) throw new Error(`a malformed ${RUN_CHECK_ARG} argument`);
    return { sha256: m[1]!, path: m[2]! };
  });
}
