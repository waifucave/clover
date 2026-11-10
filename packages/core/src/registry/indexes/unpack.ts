// The unpacker for a plugin download (spec §5.1: "A version downloads as a `.tar.gz` whose tree hash must match"; an
// npm package the same). Clover's own reader, no `tar` program and no library: a downloaded archive is untrusted.
//
// * gzip, inflated with a cap on what comes out (`maxOutputLength`), so a small archive can't fill the disk.
// * tar (ustar, with pax `path` and GNU long names): regular files and directories only. A link, a device, a FIFO,
//   a sparse or any other kind of entry refuses the whole archive; so does a checksum that doesn't match.
// * Paths: relative, `/`-separated, no `..`, no empty or `.` part, no backslash, no NUL or control character, at most
//   1024 characters and 32 deep. A path given twice, one under a path that is a file, or one the tree hash leaves
//   out (`.git/`, `.DS_Store`, `Thumbs.db`: it would be installed unchecked) refuses it.
// * Written into a fresh folder only (each file created exclusively, so on a case-insensitive disk `A` and `a` clash
//   and refuse it), its mode 0644, or 0755 when the archive marks it executable (the tree hash keeps that bit).
// * Bounded: `INSTALL_MAX_FILES` files and `INSTALL_MAX_BYTES` bytes, as a folder install.
// * Its root: the archive's files, or the one folder they all sit in (`package/` for npm), whichever holds
//   `clover.json`. The tree hash, checked after, decides what's installed.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { isTreeHashExcluded, MANIFEST_FILE } from "@waifucave/clover-plugin-sdk";
import { ContractError } from "../../contracts/common";
import { INSTALL_MAX_BYTES, INSTALL_MAX_FILES } from "../install-folder";

const BLOCK = 512;
export const PATH_MAX = 1024;
export const DEPTH_MAX = 32;

const bad = (why: string): never => {
  throw new ContractError("invalid", `the download isn't a plugin archive Clover takes: ${why}`);
};

function field(h: Uint8Array, at: number, len: number): string {
  const end = h.subarray(at, at + len).indexOf(0);
  return new TextDecoder("utf-8", { fatal: false }).decode(h.subarray(at, end === -1 ? at + len : at + end));
}

function octal(h: Uint8Array, at: number, len: number): number {
  // A base-256 number (high bit set) is never needed for a plugin's sizes: refused.
  if ((h[at]! & 0x80) !== 0) bad("a size or mode in base-256");
  const text = field(h, at, len).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) bad("a header number that isn't octal");
  return parseInt(text, 8);
}

function checksumOk(h: Uint8Array): boolean {
  const want = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === want;
}

/** A path as the archive gives it, checked: relative, `/`-separated, nothing that leaves the folder. */
export function safeArchivePath(raw: string): string {
  let p = raw;
  if (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  // eslint-disable-next-line no-control-regex
  if (p === "" || p.length > PATH_MAX || p.includes("\\") || /[\u0000-\u001f\u007f]/.test(p) || p.startsWith("/")) bad(`the path ${JSON.stringify(raw.slice(0, 200))}`);
  const parts = p.split("/");
  if (parts.length > DEPTH_MAX || parts.some((x) => x === "" || x === "." || x === "..")) bad(`the path ${JSON.stringify(raw.slice(0, 200))}`);
  return p;
}

/** pax records (`<len> <key>=<value>\n`): the ones that name a path. */
function paxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data);
  let at = 0;
  let path: string | undefined;
  while (at < text.length) {
    const sp = text.indexOf(" ", at);
    if (sp === -1) break;
    const len = Number(text.slice(at, sp));
    if (!Number.isInteger(len) || len <= 0) bad("a pax header");
    const rec = text.slice(sp + 1, at + len - 1);
    const eq = rec.indexOf("=");
    const key = rec.slice(0, eq);
    if (key === "path") path = rec.slice(eq + 1);
    // `linkpath` only matters to a link, which is refused anyway; sizes and times beyond ustar's aren't needed.
    if (key === "size") bad("a pax size");
    at += len;
  }
  return path;
}

export interface UnpackLimits {
  maxFiles?: number;
  maxBytes?: number;
}

/** Unpacks a `.tar.gz` into `dest` (a fresh, empty folder) and gives back the folder that holds `clover.json`. Throws
 *  `ContractError` (`invalid`) with why. */
export function unpackTarGz(gz: Uint8Array, dest: string, limits: UnpackLimits = {}): string {
  const maxBytes = limits.maxBytes ?? INSTALL_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? INSTALL_MAX_FILES;
  let tar: Uint8Array;
  try {
    // The tar framing is at most a block per file plus padding on top of the files' bytes.
    tar = gunzipSync(gz, { maxOutputLength: maxBytes + (maxFiles + 2) * BLOCK * 2 });
  } catch (err) {
    return bad(`it doesn't inflate (${(err as Error).message.slice(0, 120)})`);
  }
  const files = new Map<string, { data: Uint8Array; exec: boolean }>();
  const dirs = new Set<string>();
  let total = 0;
  let at = 0;
  let longName: string | undefined;
  let paxName: string | undefined;
  for (;;) {
    if (at + BLOCK > tar.length) bad("it ends before its end marker");
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) bad("a header's checksum doesn't match");
    const type = String.fromCharCode(h[156]!);
    const size = octal(h, 124, 12);
    const mode = octal(h, 100, 8);
    const dataAt = at + BLOCK;
    const next = dataAt + Math.ceil(size / BLOCK) * BLOCK;
    if (next > tar.length) bad("an entry runs past the end");
    const data = tar.subarray(dataAt, dataAt + size);
    at = next;
    if (type === "x") {
      paxName = paxPath(data);
      continue;
    }
    if (type === "L") {
      longName = new TextDecoder().decode(data).replace(/\0+$/, "");
      continue;
    }
    if (type === "g") continue; // a global pax header: nothing in it is used
    const magic = field(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? field(h, 345, 155) : "";
    const rawName = paxName ?? longName ?? (prefix !== "" ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    paxName = undefined;
    longName = undefined;
    const path = safeArchivePath(rawName);
    // What the tree hash leaves out (`.git/`, `.DS_Store`, `Thumbs.db`) would be installed unchecked: refused.
    if (isTreeHashExcluded(path)) bad(`${path} is something the tree hash leaves out, so it can't be checked`);
    if (type === "5") {
      if (files.has(path)) bad(`${path} is both a file and a folder`);
      dirs.add(path);
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") bad(`${path} isn't a regular file or a folder (type ${JSON.stringify(type)})`);
    if (files.has(path) || dirs.has(path)) bad(`${path} is in it twice`);
    total += size;
    if (total > maxBytes) bad(`it holds more than ${Math.round(maxBytes / (1024 * 1024))} MB`);
    if (files.size + 1 > maxFiles) bad(`it holds more than ${maxFiles} files`);
    files.set(path, { data, exec: (mode & 0o111) !== 0 });
  }
  // No file under a path that is a file.
  for (const p of [...files.keys(), ...dirs]) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join("/"))) bad(`${p} is under a file`);
  }
  // Its root: the archive's top, or the one folder everything sits in.
  let root = "";
  if (!files.has(MANIFEST_FILE)) {
    const tops = new Set([...files.keys()].map((p) => p.split("/")[0]!));
    const only = tops.size === 1 ? [...tops][0]! : undefined;
    if (only === undefined || !files.has(`${only}/${MANIFEST_FILE}`)) bad(`it has no ${MANIFEST_FILE} at its top or in its one folder`);
    root = only!;
  }
  const strip = (p: string) => (root === "" ? p : p.slice(root.length + 1));
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const d of dirs) {
    if (root !== "" && d !== root && !d.startsWith(`${root}/`)) continue;
    const rel = strip(d === root ? "" : d);
    if (rel !== "") mkdirSync(join(dest, rel), { recursive: true, mode: 0o755 });
  }
  for (const [p, f] of files) {
    if (root !== "" && !p.startsWith(`${root}/`)) continue;
    const rel = strip(p);
    const parts = rel.split("/");
    if (parts.length > 1) mkdirSync(join(dest, ...parts.slice(0, -1)), { recursive: true, mode: 0o755 });
    let fd: number;
    try {
      // Created, never opened over: a clash on a case-insensitive disk (or anything already there) refuses it.
      fd = openSync(join(dest, ...parts), "wx", f.exec ? 0o755 : 0o644);
    } catch (err) {
      return bad(`${rel} can't be written (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    try {
      let off = 0;
      while (off < f.data.byteLength) off += writeSync(fd, f.data, off, f.data.byteLength - off);
    } finally {
      closeSync(fd);
    }
  }
  return dest;
}
