// A small zip reader for Chrome for Testing's archives (ported from spike S7's `src/cft/unzip.ts`), so the daemon needs
// no `unzip` on the machine (a bare server often has none) and keeps what a browser needs from the archive: Unix modes
// (the executable bits) and symlinks (macOS frameworks). Stored and deflated entries, ZIP64 offsets, CRC checked.
// Refuses any entry or symlink that would land outside the destination. Only ever run on an archive whose SHA-256
// already matched its pin (`install.ts`).
import { inflateRawSync } from "node:zlib";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  /** Unix mode from the external attributes, when the archive was made on Unix. */
  mode?: number;
  isDir: boolean;
  isSymlink: boolean;
}

const EOCD = 0x06054b50, ZIP64_LOCATOR = 0x07064b50, ZIP64_EOCD = 0x06064b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

/** The archive's entries, from its central directory. Pure over the bytes. */
export function listEntries(zip: Uint8Array): ZipEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (dv.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end of central directory");
  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  const loc = eocd - 20;
  if (loc >= 0 && dv.getUint32(loc, true) === ZIP64_LOCATOR) {
    const z64 = Number(dv.getBigUint64(loc + 8, true));
    if (dv.getUint32(z64, true) !== ZIP64_EOCD) throw new Error("bad ZIP64 end record");
    count = Number(dv.getBigUint64(z64 + 32, true));
    cdOffset = Number(dv.getBigUint64(z64 + 48, true));
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== CENTRAL) throw new Error(`bad central directory entry ${n}`);
    const madeBy = dv.getUint16(p + 4, true) >>> 8;
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const ext = dv.getUint32(p + 38, true);
    let localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: the 0xFFFFFFFF fields, in order
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(dv.getBigUint64(q, true)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(dv.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }
    const mode = madeBy === 3 ? (ext >>> 16) & 0xffff : undefined;
    const isDir = name.endsWith("/");
    const isSymlink = mode !== undefined && (mode & 0o170000) === 0o120000;
    entries.push({ name, method, crc, compressedSize, size, localOffset, mode, isDir, isSymlink });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's bytes. */
export function entryData(zip: Uint8Array, entry: ZipEntry, crc32: (data: Uint8Array) => number): Uint8Array {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const p = entry.localOffset;
  if (dv.getUint32(p, true) !== LOCAL) throw new Error(`bad local header for ${entry.name}`);
  const start = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
  const raw = zip.subarray(start, start + entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = inflateRawSync(raw);
  else throw new Error(`unsupported compression ${entry.method} for ${entry.name}`);
  if (data.length !== entry.size) throw new Error(`size mismatch for ${entry.name}`);
  if ((crc32(data) >>> 0) !== entry.crc) throw new Error(`CRC mismatch for ${entry.name}`);
  return data;
}

/** Is `rel` (a zip name or a symlink target resolved against its entry's folder) inside `root`? Pure. */
export function inside(root: string, path: string): boolean {
  const r = resolve(root);
  const p = resolve(path);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

export interface ExtractStats { files: number; dirs: number; symlinks: number; bytes: number }

/** Extract every entry under `dest` (created). */
export function extractAll(zip: Uint8Array, dest: string, crc32: (data: Uint8Array) => number): ExtractStats {
  const stats: ExtractStats = { files: 0, dirs: 0, symlinks: 0, bytes: 0 };
  mkdirSync(dest, { recursive: true });
  const realDest = realpathSync(dest);
  for (const entry of listEntries(zip)) {
    const clean = normalize(entry.name);
    if (isAbsolute(entry.name) || clean.split(/[\\/]/).includes("..")) throw new Error(`refused entry outside the destination: ${entry.name}`);
    const target = join(dest, clean);
    if (!inside(dest, target)) throw new Error(`refused entry outside the destination: ${entry.name}`);
    if (entry.isDir) { mkdirSync(target, { recursive: true }); stats.dirs++; continue; }
    mkdirSync(dirname(target), { recursive: true });
    // an earlier symlink must not carry a later entry out of the destination
    if (!inside(realDest, realpathSync(dirname(target)))) throw new Error(`refused entry through a symlink: ${entry.name}`);
    const data = entryData(zip, entry, crc32);
    if (entry.isSymlink) {
      const link = new TextDecoder().decode(data);
      if (isAbsolute(link) || !inside(dest, resolve(dirname(target), link))) throw new Error(`refused symlink outside the destination: ${entry.name} -> ${link}`);
      symlinkSync(link, target);
      stats.symlinks++;
      continue;
    }
    writeFileSync(target, data);
    if (entry.mode !== undefined && process.platform !== "win32") chmodSync(target, entry.mode & 0o777);
    stats.files++;
    stats.bytes += data.length;
  }
  return stats;
}
