// The release's name scan (plan §4 M-M2): every file a release ships, read for the owner's identity before the
// draft goes up. Git hooks see only what enters the repo; a build can still carry an absolute builder path or a name
// in a binary (the predecessor app's 0.2.001 leak), so the gate reads the built files themselves. The patterns live
// OUTSIDE this repo, in the owner's local-only guard (~/norma-private/git-hooks/name-guard.sh `artifacts`, or
// CLOVER_NAME_GUARD): a tracked
// copy would publish the strings it keeps out. So the gate fails closed on a machine without the guard, or without a
// tool it needs to open an asset, and only the owner's Mac cuts a release.
//
// One scanner, two callers. publish.ts runs `nameScan` on the release's assets and the signed app before the draft
// goes up. The builds (release/build.ts, build-packages.ts) run `runNameScan` on their whole output folder,
// apps/desktop/out/dist/ (the unpacked app with resources/daemon's core, sidecar, plugin Bun and process holder, the
// installers, the update files and the core's release files): release-lib.ts's `nameScanPlan` splits it into what is
// read and what is excluded, the partition is asserted against the filesystem (every regular file under exactly one of
// the two, so a bug in it can't under-scan a release), and the read part goes through `nameScan`, opened to the
// bottom like everything else. A signed release's build FAILS CLOSED without the guard; an unsigned build (CI's) scans
// when the guard is there and says it skipped when it isn't. Build-time exclusions: none yet (CLOVER_NAME_SCAN_EXCLUSIONS
// below); widening them is a security decision, not a build fix (release-lib.ts's NAME_SCAN_EXCLUSIONS says why the
// predecessor app has its one), and a Chromium locale pack colliding here is investigated and named, never appended to
// blind.
//
// What it reads, for each asset: the asset's own bytes, and everything inside it, opened without running anything:
//   dmg        mounted read-only and unbrowsed (hdiutil attach -readonly -nobrowse), its whole tree, .DS_Store too
//   zip, 7z    extracted (bsdtar, 7z); the Windows installer (NSIS) through 7z, and the app archive inside it
//   deb, ar    its control and data archives, each extracted (and decompressed, and the tar inside opened)
//   rpm, tar   extracted (bsdtar)
//   AppImage   its squashfs, at the offset where the ELF runtime ends (unsquashfs -o); a bare squashfs likewise
//   asar       extracted (@electron/asar, in-process), so what is packed inside is opened in turn
//   cab, msi, rar, crx   extracted (7z)
//   PE         offered to `7z l`: when 7z reads it as an archive (an NSIS or 7-Zip installer, a self-extractor), it
//              is extracted (7z) and read; a plain executable or DLL is read raw
//   a zip appended to anything (an end-of-central-directory record that ends the file, in its last 64 KB)   7z
//   gz, br, zst, xz, bz2, lzma, lz4, lzip, and the block maps (gzip)   decompressed
// and nested archives the same way, down to MAX_DEPTH. A file is known by its bytes (formatOf: the magic numbers of
// each format above) as well as its name, so a renamed archive (`hidden.tgz`, `blob.bin`) is opened all the same; a
// file in a format the scan knows but can't open here (a tool missing, or the bytes don't open) fails the scan
// rather than being read raw. Beside the contents it reads every path inside each asset and every link's target (a
// list it hands the guard as a file), and fails on a link to an absolute path. It fails when an asset yields no file
// to read. The unpacked apps (the signed Clover.app, CI's win-unpacked) are read whole.
// Every file is also read raw, as it is, opened or not: .pak files, and anything with no format above.
//
// Bytes after a format's end: a file known by its format must be that format to its last byte, or the scan fails
// (trailingProblem), since bytes a tool skips are bytes nobody opened. Measured by each format's own structure: a
// gzip by its members (each inflated, its trailer checked) and the bytes gunzip consumed, a brotli by the bytes it
// consumed, a bzip2 by its "trailing garbage" warning, a lzip with --trailing-error, a zstd or lz4 by walking its
// frames (zstdEnd, lz4End), xz and lzma by their tools (which refuse trailing bytes; xz allows its own zero
// padding), a zip or crx by an end record that is the file's last bytes, a tar by its end-of-archive blocks
// (only zeros after them), an ar or deb by its last member, a 7z by its start header, a cab by its header's size, a
// squashfs or AppImage by its superblock's bytes used (only zeros after), an asar by its last packed file, a dmg by
// its koly trailer (it ends the file by how it is found). A file read raw (no format), a PE file (its overlay) and
// the formats whose end isn't measured here (rpm, msi, rar, the NSIS installer) are searched for a stream appended
// to them (appendedStreams): a gzip, xz, zstd, bzip2 or 7z that starts in the file and runs to its end (checked by
// decoding it, or by its header's own sizes and CRC), or a zip whose end record ends the file; what it finds is
// opened as a nested file, and the bytes before it are searched again.
// Bytes a decoder skips inside a stream fail the scan the same way: a zstd or lz4 skippable frame, and a gzip
// member's extra field or comment (gunzip skips all three, so a stream hidden there would be opened by nobody). xz,
// lzma, lzip and bzip2 carry no skipped payload (xz's padding must be zeros, which xz checks).
//
// Known limits, not read inside (each is read raw, as every file is):
//   streams in the middle of a file: zlib inside a PNG or a PDF, Chromium's .pak resources (gzip, brotli), a
//       compressed section of an executable; only one that runs to the file's end is found
//   brotli by name only: it has no magic number, so a brotli stream is opened only when it is named .br (none of the
//       release's builders writes one); its metadata blocks, which the decoder skips, aren't read
//
// Accepted (not read by the guard), each for its own reason, and widening this list is a security decision:
//   resources/daemon/srt-win.THIRD_PARTY_NOTICES.txt   third parties' license texts, with their authors' names and
//       addresses, which can collide with a pattern by chance. CI generates it from pinned sources (srt-win.ts:
//       sandbox-runtime's LICENSE and cargo-about's report), never the owner's machine, and it carries no build
//       path. Only that name in that place, in an app's resources; its path is still in the names list.
import { extractAll as extractAsar, getRawHeader as asarHeader } from "@electron/asar";
import { spawnSync } from "node:child_process";
import { brotliDecompressSync, gunzipSync, inflateRawSync } from "node:zlib";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { nameScanPlan } from "../release-lib";

export const NAME_SCAN_ACCEPTED: readonly RegExp[] = [/(^|\/)resources\/daemon\/srt-win\.THIRD_PARTY_NOTICES\.txt$/];
export const MAX_DEPTH = 4;

export function guardPath(home: string | undefined): string {
  return join(home ?? "", "norma-private", "git-hooks", "name-guard.sh");
}

/** The owner's local-only guard: CLOVER_NAME_GUARD, or the one in their home folder. */
export function nameGuardPath(env: Record<string, string | undefined> = process.env): string {
  return env.CLOVER_NAME_GUARD ?? guardPath(env.HOME ?? homedir());
}

/** How nameScan finds its guard: a home folder (its norma-private guard), or the guard itself; `quiet` hides its output. */
export type NameScanOptions = string | undefined | { home?: string; guard?: string; quiet?: boolean };

export type Opener =
  | "dmg" | "zip" | "7z" | "nsis" | "deb" | "ar" | "rpm" | "tar" | "appimage" | "squashfs" | "asar" | "cab" | "msi" | "rar" | "crx"
  | "gz" | "br" | "zst" | "xz" | "bz2" | "lzma" | "lz4" | "lzip" | "pe" | "appendedzip" | "raw";

/** How a file is opened for reading, by its name. */
export function openerFor(name: string): Opener {
  if (name.endsWith(".dmg")) return "dmg";
  if (name.endsWith(".zip") || name.endsWith(".jar")) return "zip";
  if (name.endsWith(".7z")) return "7z";
  if (/^Clover-Setup-.+\.exe$/.test(name)) return "nsis";
  if (name.endsWith(".deb")) return "deb";
  if (name.endsWith(".a")) return "ar";
  if (name.endsWith(".rpm")) return "rpm";
  if (name.endsWith(".tar")) return "tar";
  if (name.endsWith(".AppImage")) return "appimage";
  if (name.endsWith(".squashfs") || name.endsWith(".sqfs")) return "squashfs";
  if (name.endsWith(".asar")) return "asar";
  if (name.endsWith(".cab")) return "cab";
  if (name.endsWith(".msi")) return "msi";
  if (name.endsWith(".rar")) return "rar";
  if (name.endsWith(".crx")) return "crx";
  if (name.endsWith(".gz") || name.endsWith(".tgz") || name.endsWith(".blockmap")) return "gz";
  if (name.endsWith(".br")) return "br";
  if (name.endsWith(".zst") || name.endsWith(".tzst")) return "zst";
  if (name.endsWith(".xz") || name.endsWith(".txz")) return "xz";
  if (name.endsWith(".bz2") || name.endsWith(".tbz") || name.endsWith(".tbz2")) return "bz2";
  if (name.endsWith(".lzma") || name.endsWith(".tlz")) return "lzma";
  if (name.endsWith(".lz4")) return "lz4";
  if (name.endsWith(".lz")) return "lzip";
  return "raw";
}

const at = (b: Uint8Array, off: number, sig: readonly number[]): boolean => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
const ascii = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));

/** How much of a file's end magicOf reads: a zip's end record (22 bytes) and the longest comment it can carry. */
export const TAIL_BYTES = 22 + 0xffff;

/**
 * How a file is opened for reading, by its bytes: `head` is its first 512 bytes (or all of it), `tail` its last
 * TAIL_BYTES (or all of it). Undefined when no format's magic number matches (brotli has none; it is known by name
 * only).
 */
export function magicOf(head: Uint8Array, tail: Uint8Array = new Uint8Array(0)): Opener | undefined {
  if (at(head, 0, [0x50, 0x4b]) && (at(head, 2, [3, 4]) || at(head, 2, [5, 6]) || at(head, 2, [7, 8]))) return "zip";
  if (at(head, 0, ascii("Cr24"))) return "crx";
  if (at(head, 0, [0x1f, 0x8b])) return "gz";
  if (at(head, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz";
  if (at(head, 0, [0x28, 0xb5, 0x2f, 0xfd])) return "zst";
  if (at(head, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  if (at(head, 0, ascii("BZh")) && head[3] !== undefined && head[3] >= 0x31 && head[3] <= 0x39) return "bz2";
  if (at(head, 0, ascii("!<arch>\n"))) return "ar";
  if (at(head, 0, ascii("hsqs")) || at(head, 0, ascii("sqsh"))) return "squashfs";
  if (at(head, 0, [0x7f, 0x45, 0x4c, 0x46]) && at(head, 8, [0x41, 0x49, 0x02])) return "appimage";
  if (at(head, 0, [0xed, 0xab, 0xee, 0xdb])) return "rpm";
  if (at(head, 0, ascii("MSCF")) && at(head, 4, [0, 0, 0, 0])) return "cab";
  if (at(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "msi";
  if (at(head, 0, ascii("Rar!\x1a\x07"))) return "rar";
  if (at(head, 0, [0x04, 0x22, 0x4d, 0x18]) || at(head, 0, [0x02, 0x21, 0x4c, 0x18])) return "lz4";
  if (at(head, 0, ascii("LZIP"))) return "lzip";
  if (at(head, 257, ascii("ustar"))) return "tar";
  // asar: a pickle of the header's size (4), then the header, JSON starting {"files":
  if (at(head, 0, [4, 0, 0, 0]) && at(head, 16, ascii('{"files":'))) return "asar";
  // .lzma (LZMA-alone): properties 0x5d, a dictionary of 2^n or 3·2^(n-1) bytes, then a size that is unknown (all
  // ones) or under 2^48.
  if (head.length >= 13 && head[0] === 0x5d) {
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const dict = v.getUint32(1, true);
    const pow = (dict & (dict - 1)) === 0 || ((dict / 3) & (dict / 3 - 1)) === 0;
    const size = v.getBigUint64(5, true);
    if (dict >= 4096 && pow && (size === 0xffffffffffffffffn || size < 1n << 48n)) return "lzma";
  }
  // A UDIF disk image ends with its "koly" trailer.
  if (tail.length >= 512 && at(tail, tail.length - 512, ascii("koly"))) return "dmg";
  // A PE file (MZ, and "PE\0\0" where e_lfanew points, when that is in `head`; formatOf reads further): 7z is asked
  // whether it holds an archive.
  if (at(head, 0, ascii("MZ")) && head.length >= 64) {
    const lfanew = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0x3c, true);
    if (at(head, lfanew, [0x50, 0x45, 0, 0])) return "pe";
  }
  if (appendedZip(tail)) return "appendedzip";
  return undefined;
}

/** Whether `tail` (a file's last bytes) ends with a zip's end-of-central-directory record: its comment ends the file. */
export function appendedZip(tail: Uint8Array): boolean {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (at(tail, i, [0x50, 0x4b, 5, 6]) && i + 22 + v.getUint16(i + 20, true) === tail.length) return true;
  }
  return false;
}

/** What 7z reads a PE file as (`Type = …` in `7z l -slt`): "PE" for a plain executable, or the archive it holds. */
export function peArchiveType(listing: string): string | undefined {
  const types = [...listing.matchAll(/^Type = (.+)$/gm)].map((m) => m[1]!.trim());
  return types.find((t) => t !== "PE" && t !== "COFF" && t !== "TE") ?? (types.length > 0 ? "PE" : undefined);
}

/** How `path` is opened: by its bytes first, and by its name when its bytes match no format. */
export function formatOf(path: string): Opener {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const head = new Uint8Array(Math.min(512, size));
    readSync(fd, head, 0, head.length, 0);
    const tail = new Uint8Array(size > 512 ? Math.min(TAIL_BYTES, size - 512) : 0);
    if (tail.length > 0) readSync(fd, tail, 0, tail.length, size - tail.length);
    const byName = openerFor(basename(path));
    // The release's own installer is a PE file (no magic of its own here) that 7z opens as NSIS.
    if (byName === "nsis") return byName;
    const magic = magicOf(head, tail);
    // A PE header past the first 512 bytes (e_lfanew can point anywhere in the file): read where it points.
    if ((magic === undefined || magic === "appendedzip") && at(head, 0, ascii("MZ")) && head.length >= 64) {
      const lfanew = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0x3c, true);
      if (lfanew + 4 > head.length && lfanew + 4 <= size && at(readAt(fd, lfanew, 4), 0, [0x50, 0x45, 0, 0])) return "pe";
    }
    return magic ?? byName;
  } finally {
    closeSync(fd);
  }
}

/** The tool each opener needs, beyond Bun itself. */
export const TOOLS: Readonly<Partial<Record<Opener, string>>> = {
  dmg: "hdiutil", zip: "bsdtar", rpm: "bsdtar", deb: "bsdtar", ar: "bsdtar", tar: "bsdtar",
  "7z": "7z", nsis: "7z", cab: "7z", msi: "7z", rar: "7z", crx: "7z", pe: "7z", appendedzip: "7z",
  appimage: "unsquashfs", squashfs: "unsquashfs", xz: "xz", lzma: "xz", bz2: "bzip2", lz4: "lz4", lzip: "lzip",
};

/** What a decompressed stream is called: its name without the compression's suffix (a .tgz becomes a .tar). */
export function decompressedName(name: string): string {
  const swaps: Array<[RegExp, string]> = [[/\.(tgz|tbz2?|txz|tzst|tlz)$/, ".tar"], [/\.(gz|br|zst|xz|bz2|lzma|lz4|lz)$/, ""]];
  for (const [re, to] of swaps) if (re.test(name)) return name.replace(re, to);
  return `${name}.out`;
}

/** Where an AppImage's squashfs starts: the end of its ELF runtime (its section headers, the last thing in it). */
export function elfEnd(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 64 || v.getUint32(0) !== 0x7f454c46) throw new Error("not an ELF file");
  if (bytes[4] === 2) return Number(v.getBigUint64(0x28, true)) + v.getUint16(0x3a, true) * v.getUint16(0x3c, true);
  if (bytes[4] === 1) return v.getUint32(0x20, true) + v.getUint16(0x2e, true) * v.getUint16(0x30, true);
  throw new Error("not an ELF file");
}

/** Reads up to `length` bytes of an open file at `position` (fewer at its end). */
function readAt(fd: number, position: number, length: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, length));
  const n = readSync(fd, out, 0, out.length, position);
  return out.subarray(0, n);
}

/** Whether every byte of an open file from `from` to `size` is zero (padding). */
function zerosFrom(fd: number, from: number, size: number): boolean {
  for (let p = from; p < size; p += 1 << 20) {
    const chunk = readAt(fd, p, Math.min(1 << 20, size - p));
    if (chunk.length === 0 || chunk.some((x) => x !== 0)) return false;
  }
  return true;
}

const octal = (b: Uint8Array): number | undefined => {
  const t = new TextDecoder().decode(b).replace(/\0.*$/s, "").trim();
  return /^[0-7]+$/.test(t) ? Number.parseInt(t, 8) : t === "" ? 0 : undefined;
};

/**
 * Where a tar archive's end-of-archive block starts (the first all-zero header), walking its headers by their
 * checksums and sizes; undefined when a header doesn't check or a member runs past `size`.
 */
export function tarEnd(read: (position: number, length: number) => Uint8Array, size: number): number | undefined {
  let p = 0;
  while (p + 512 <= size) {
    const h = read(p, 512);
    if (h.length < 512) return undefined;
    if (h.every((x) => x === 0)) return p;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (octal(h.subarray(148, 156)) !== sum) return undefined;
    let length: number | undefined;
    if ((h[124]! & 0x80) !== 0) {
      // base-256 (GNU, for sizes over 8 GiB)
      length = 0;
      for (let i = 125; i < 136; i++) length = length * 256 + h[i]!;
    } else length = octal(h.subarray(124, 136));
    if (length === undefined) return undefined;
    // Links, devices, fifos and folders carry no data blocks.
    const type = String.fromCharCode(h[156]!);
    const data = "123456".includes(type) ? 0 : Math.ceil(length / 512) * 512;
    p += 512 + data;
  }
  return undefined;
}

/** Where an ar archive (a deb) ends: after its last member, each padded to an even length; undefined if malformed. */
export function arEnd(read: (position: number, length: number) => Uint8Array, size: number): number | undefined {
  if (!at(read(0, 8), 0, ascii("!<arch>\n"))) return undefined;
  let p = 8;
  // Fewer bytes left than a member header: they are bytes after the archive's end.
  while (p + 60 <= size) {
    const h = read(p, 60);
    if (h[58] !== 0x60 || h[59] !== 0x0a) return undefined;
    const t = new TextDecoder().decode(h.subarray(48, 58)).trim();
    if (!/^\d+$/.test(t)) return undefined;
    const length = Number(t);
    p += 60 + length + (length & 1);
  }
  return p;
}

const u32 = (b: Uint8Array, off: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true);
const u64 = (b: Uint8Array, off: number): number => Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, true));

/** Where a 7z archive starting at `off` ends, by its start header (whose CRC must check); undefined otherwise. */
export function sevenZipEnd(b: Uint8Array, off = 0): number | undefined {
  if (!at(b, off, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || b.length < off + 32) return undefined;
  if (Bun.hash.crc32(b.subarray(off + 12, off + 32)) !== u32(b, off + 8)) return undefined;
  return off + 32 + u64(b, off + 12) + u64(b, off + 20);
}

/** Where a gzip member starting at `off` ends (its trailer's CRC and size checked); undefined if it isn't one. */
export function gzipMemberEnd(b: Uint8Array, off: number): number | undefined {
  if (!at(b, off, [0x1f, 0x8b, 8]) || b.length < off + 18) return undefined;
  const flags = b[off + 3]!;
  if ((flags & 0xe0) !== 0) return undefined;
  let p = off + 10;
  if (flags & 4) p += 2 + (b[p]! | (b[p + 1]! << 8));
  for (const bit of [8, 16]) {
    if (flags & bit) {
      const z = b.indexOf(0, p);
      if (z < 0) return undefined;
      p = z + 1;
    }
  }
  if (flags & 2) p += 2;
  if (p + 8 > b.length) return undefined;
  try {
    const r = (inflateRawSync as unknown as (d: Uint8Array, o: { info: true }) => { buffer: Uint8Array; engine: { bytesWritten: number } })(b.subarray(p), { info: true });
    const end = p + r.engine.bytesWritten + 8;
    if (end > b.length) return undefined;
    if (u32(b, end - 8) !== Bun.hash.crc32(r.buffer) || u32(b, end - 4) !== (r.buffer.length >>> 0)) return undefined;
    return end;
  } catch {
    return undefined;
  }
}

const isSkippable = (b: Uint8Array, p: number): boolean => p + 8 <= b.length && (u32(b, p) & 0xfffffff0) >>> 0 === 0x184d2a50;

/**
 * A zstd file walked frame by frame (each frame's header and blocks, its checksum): where the frames end, and how
 * many skippable frames it holds (bytes the decoder skips). `end` stops at the first bytes that aren't a frame.
 */
export function zstdEnd(b: Uint8Array): { end: number; skippable: number } {
  let p = 0, skippable = 0;
  const frame = (q: number): number | undefined => {
    if (isSkippable(b, q)) return q + 8 + u32(b, q + 4);
    if (!at(b, q, [0x28, 0xb5, 0x2f, 0xfd]) || q + 5 > b.length) return undefined;
    const fhd = b[q + 4]!;
    if (fhd & 0x08) return undefined;
    const single = (fhd >> 5) & 1, fcs = fhd >> 6;
    let r = q + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3]! + (fcs === 0 ? single : [0, 2, 4, 8][fcs]!);
    for (;;) {
      if (r + 3 > b.length) return undefined;
      const h = b[r]! | (b[r + 1]! << 8) | (b[r + 2]! << 16);
      r += 3;
      const type = (h >> 1) & 3;
      if (type === 3) return undefined;
      r += type === 1 ? 1 : h >>> 3;
      if (h & 1) break;
    }
    return r + ((fhd >> 2) & 1 ? 4 : 0);
  };
  while (p < b.length) {
    const e = frame(p);
    if (e === undefined || e > b.length) break;
    if (isSkippable(b, p)) skippable++;
    p = e;
  }
  return { end: p, skippable };
}

/** An lz4 file walked frame by frame (the frame format, and the legacy one), as zstdEnd. */
export function lz4End(b: Uint8Array): { end: number; skippable: number } {
  let p = 0, skippable = 0;
  const frame = (q: number): number | undefined => {
    if (isSkippable(b, q)) return q + 8 + u32(b, q + 4);
    if (at(b, q, [0x02, 0x21, 0x4c, 0x18])) {
      // Legacy: blocks until the file ends or the next frame starts.
      let r = q + 4;
      while (r + 4 <= b.length && !at(b, r, [0x04, 0x22, 0x4d, 0x18]) && !at(b, r, [0x02, 0x21, 0x4c, 0x18]) && !isSkippable(b, r)) r += 4 + u32(b, r);
      return r;
    }
    if (!at(b, q, [0x04, 0x22, 0x4d, 0x18]) || q + 7 > b.length) return undefined;
    const flg = b[q + 4]!;
    if (flg >> 6 !== 1 || flg & 0x02) return undefined;
    let r = q + 6 + (flg & 0x08 ? 8 : 0) + (flg & 0x01 ? 4 : 0) + 1;
    for (;;) {
      if (r + 4 > b.length) return undefined;
      const size = u32(b, r);
      r += 4;
      if (size === 0) break;
      r += (size & 0x7fffffff) + (flg & 0x10 ? 4 : 0);
    }
    return r + (flg & 0x04 ? 4 : 0);
  };
  while (p < b.length) {
    const e = frame(p);
    if (e === undefined || e > b.length) break;
    if (isSkippable(b, p)) skippable++;
    p = e;
  }
  return { end: p, skippable };
}

/**
 * A gzip file walked member by member (gzipMemberEnd): where the members end, and whether any carries an extra field
 * or a comment (bytes gunzip skips).
 */
export function gzipEnd(b: Uint8Array): { end: number; skipped: boolean } {
  let p = 0, skipped = false;
  while (p < b.length) {
    const e = gzipMemberEnd(b, p);
    if (e === undefined) break;
    if (b[p + 3]! & (4 | 16)) skipped = true;
    p = e;
  }
  return { end: p, skipped };
}

/** Every offset where `sig` starts in `b`. */
function offsetsOf(b: Uint8Array, sig: readonly number[]): number[] {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const needle = Buffer.from(sig);
  const out: number[] = [];
  for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Whether a tool reads `input` as one whole stream: it exits 0 and warns of nothing after it. */
function toolTakesWhole(cmd: string[], input: Uint8Array): boolean {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { input, stdio: ["pipe", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return (r.status ?? 1) === 0 && !/trailing/i.test(String(r.stderr ?? ""));
}

export interface Appended { offset: number; kind: "gz" | "xz" | "zst" | "bz2" | "7z" | "zip" }

/**
 * Streams appended to `b`: a gzip (one member or several), xz, zstd, bzip2 or 7z that starts in it and runs to its
 * very end, or a zip whose end record ends it; then the bytes before that, searched again. Latest first. A stream
 * that ends before the file does (in its middle) isn't one: see the known limits in the header.
 */
export function appendedStreams(b: Uint8Array, o: { xz?: string; bzip2?: string } = {}): { found: Appended[]; problems: string[] } {
  const found: Appended[] = [];
  const problems: string[] = [];
  let end = b.length;
  for (;;) {
    const v = b.subarray(0, end);
    let best: Appended | undefined;
    const take = (a: Appended): void => { if (best === undefined || a.offset < best.offset) best = a; };
    // gzip: members chained back from the end; the earliest whose chain reaches it.
    const reaches = new Set<number>([end]);
    for (const c of offsetsOf(v, [0x1f, 0x8b, 8]).reverse()) {
      const e = gzipMemberEnd(v, c);
      if (e !== undefined && reaches.has(e)) { reaches.add(c); take({ offset: c, kind: "gz" }); }
    }
    for (const c of offsetsOf(v, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) if (sevenZipEnd(v, c) === end) { take({ offset: c, kind: "7z" }); break; }
    for (const c of offsetsOf(v, [0x28, 0xb5, 0x2f, 0xfd])) {
      // Frames to the end (skippable ones too: opened, the cut-out zstd fails on them), and a stream that decodes.
      if (c + zstdEnd(v.subarray(c)).end !== end) continue;
      try { Bun.zstdDecompressSync(v.subarray(c)); take({ offset: c, kind: "zst" }); break; } catch { /* not a stream */ }
    }
    // xz: a stream header whose CRC checks, in a file ending with a stream footer ("YZ", after zero padding).
    let last = end;
    while (last >= 4 && u32(v, last - 4) === 0) last -= 4;
    if (last >= 2 && v[last - 2] === 0x59 && v[last - 1] === 0x5a) {
      for (const c of offsetsOf(v, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) {
        if (c + 12 > end || Bun.hash.crc32(v.subarray(c + 6, c + 8)) !== u32(v, c + 8)) continue;
        if (o.xz === undefined) { problems.push("ends with an xz stream, which the scan needs xz to check"); break; }
        if (toolTakesWhole([o.xz, "-t"], v.subarray(c))) { take({ offset: c, kind: "xz" }); break; }
      }
    }
    for (const c of offsetsOf(v, ascii("BZh"))) {
      const d = v[c + 3];
      if (d === undefined || d < 0x31 || d > 0x39) continue;
      if (!at(v, c + 4, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59]) && !at(v, c + 4, [0x17, 0x72, 0x45, 0x38, 0x50, 0x90])) continue;
      if (o.bzip2 === undefined) { problems.push("ends with a bzip2 stream, which the scan needs bzip2 to check"); break; }
      if (toolTakesWhole([o.bzip2, "-t"], v.subarray(c))) { take({ offset: c, kind: "bz2" }); break; }
    }
    if (appendedZip(v.subarray(Math.max(0, end - TAIL_BYTES)))) {
      // The zip starts where its central directory's offset says, counted back from the directory itself.
      const e = (() => { for (let i = end - 22; i >= Math.max(0, end - TAIL_BYTES); i--) if (at(v, i, [0x50, 0x4b, 5, 6]) && i + 22 + (v[i + 20]! | (v[i + 21]! << 8)) === end) return i; return -1; })();
      const size = u32(v, e + 12), offset = u32(v, e + 16);
      const start = e - size - offset;
      if (size === 0xffffffff || offset === 0xffffffff) problems.push("ends with a zip64, which the scan can't place");
      else if (start >= 0 && (at(v, start, [0x50, 0x4b, 3, 4]) || start === e) && (size === 0 || at(v, start + offset, [0x50, 0x4b, 1, 2]))) take({ offset: start, kind: "zip" });
      else problems.push("ends with a zip end record that doesn't place its zip");
    }
    if (best === undefined || problems.length > 0) break;
    found.push(best);
    if ((best as Appended).offset === 0) break;
    end = (best as Appended).offset;
  }
  return { found, problems };
}

/** The formats whose end isn't measured (trailingProblem), searched for appended streams instead. */
export const SEARCHED: ReadonlySet<Opener> = new Set<Opener>(["raw", "pe", "nsis", "rpm", "msi", "rar", "appendedzip"]);

/**
 * Why `file`, opened as `how`, isn't that format to its last byte (bytes after its end), or undefined when it is, or
 * when its end is measured another way (the decompressors, in `open`; the SEARCHED formats, by appendedStreams).
 */
export function trailingProblem(file: string, how: Opener): string | undefined {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (p: number, n: number): Uint8Array => readAt(fd, p, n);
    const after = (what: string, end: number | undefined, zeros = false): string | undefined => {
      if (end === undefined || end > size) return `isn't a whole ${what}`;
      if (end === size || (zeros && zerosFrom(fd, end, size))) return undefined;
      return `has ${size - end} bytes after its ${what}'s end`;
    };
    switch (how) {
      case "zst": case "lz4": {
        const b = new Uint8Array(readFileSync(file));
        const w = how === "zst" ? zstdEnd(b) : lz4End(b);
        if (w.skippable > 0) return `holds ${w.skippable} ${how === "zst" ? "zstd" : "lz4"} skippable frame(s), bytes its decoder skips`;
        return after(how === "zst" ? "zstd stream" : "lz4 stream", w.end);
      }
      case "gz": {
        const w = gzipEnd(new Uint8Array(readFileSync(file)));
        if (w.skipped) return "has a gzip member with an extra field or a comment, bytes gunzip skips";
        return after("gzip stream", w.end === 0 ? undefined : w.end);
      }
      case "zip": case "crx":
        return appendedZip(read(Math.max(0, size - TAIL_BYTES), Math.min(TAIL_BYTES, size))) ? undefined : "has bytes after its zip's end record";
      case "tar": return after("tar archive", tarEnd(read, size), true);
      case "ar": case "deb": return after("ar archive", arEnd(read, size));
      case "7z": return after("7z archive", sevenZipEnd(read(0, 32)));
      case "cab": { const h = read(0, 12); return after("cab", h.length === 12 ? u32(h, 8) : undefined); }
      case "squashfs": case "appimage": {
        const off = how === "appimage" ? elfEnd(read(0, 64)) : 0;
        const sb = read(off, 48);
        return after("squashfs", sb.length === 48 && (at(sb, 0, ascii("hsqs")) || at(sb, 0, ascii("sqsh"))) ? off + u64(sb, 40) : undefined, true);
      }
      case "asar": {
        const { header, headerSize } = asarHeader(file);
        let last = 0;
        const walk = (d: { files?: Record<string, unknown> }): void => {
          for (const e of Object.values(d.files ?? {}) as Array<{ files?: Record<string, unknown>; offset?: string; size?: number; unpacked?: boolean; link?: string }>) {
            if (e.files !== undefined) walk(e);
            else if (e.offset !== undefined && e.unpacked !== true) last = Math.max(last, Number(e.offset) + (e.size ?? 0));
          }
        };
        walk(header as { files?: Record<string, unknown> });
        return after("asar", 8 + headerSize + last);
      }
      default: return undefined;
    }
  } catch (err) {
    return `isn't a whole ${how} (${(err as Error).message})`;
  } finally {
    closeSync(fd);
  }
}

export interface Walked {
  /** Regular files for the guard. */
  read: string[];
  /** Regular files left unread (NAME_SCAN_ACCEPTED). */
  accepted: string[];
  /** Every path inside, relative to its root, and every link's target: the guard reads them as a list. */
  names: string[];
  problems: string[];
  /** Nested archives found inside, to open in turn. */
  nested: string[];
}

/** One tree, without following links: what to read, what's accepted, the names, and links to absolute paths. */
export function walkTree(root: string): Walked {
  const w: Walked = { read: [], accepted: [], names: [], problems: [], nested: [] };
  const visit = (p: string): void => {
    const rel = relative(root, p).split("\\").join("/");
    if (rel !== "") w.names.push(rel);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(p);
      w.names.push(target);
      if (isAbsolute(target)) w.problems.push(`${rel} links to an absolute path (${target})`);
      return;
    }
    if (st.isDirectory()) { for (const n of readdirSync(p).sort()) visit(join(p, n)); return; }
    if (!st.isFile()) return;
    if (NAME_SCAN_ACCEPTED.some((re) => re.test(rel))) { w.accepted.push(p); return; }
    w.read.push(p);
    if (formatOf(p) !== "raw") w.nested.push(p);
  };
  visit(root);
  return w;
}

function tool(name: string): string | undefined {
  const candidates = name === "7z" ? ["7z", "7zz"] : [name];
  return candidates.find((c) => (spawnSync("/bin/sh", ["-c", `command -v ${c}`]).status ?? 1) === 0);
}

function sh(cmd: string[]): boolean {
  return (spawnSync(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "ignore", "pipe"] }).status ?? 1) === 0;
}

export function nameScan(assets: readonly string[], apps: readonly string[], options: NameScanOptions = process.env.HOME): { problems: string[]; read: number; accepted: string[] } {
  const o = typeof options === "object" ? options : { home: options };
  const guard = o.guard ?? (o.home === process.env.HOME ? nameGuardPath() : guardPath(o.home));
  if (!existsSync(guard)) return { problems: [`the name scan needs the owner's local guard (${guard}); this machine can't cut a release`], read: 0, accepted: [] };
  const needed = new Set(assets.map((a) => TOOLS[formatOf(a)]).filter((t): t is string => t !== undefined));
  const missing = [...needed].filter((t) => tool(t) === undefined);
  if (missing.length > 0) return { problems: [`the name scan needs ${missing.join(", ")} to open the release's assets`], read: 0, accepted: [] };
  const work = mkdtempSync(join(tmpdir(), "clover-name-scan-"));
  const problems: string[] = [];
  const accepted: string[] = [];
  let read = 0;
  let n = 0;
  const runGuard = (files: string[]): boolean => {
    for (let i = 0; i < files.length; i += 500) {
      // The guard's own output goes straight to the terminal (or nowhere): never into a message this process keeps.
      const r = spawnSync(guard, ["artifacts", ...files.slice(i, i + 500)], { stdio: o.quiet ? "ignore" : ["ignore", "inherit", "inherit"] });
      if ((r.status ?? 1) !== 0) return false;
    }
    return true;
  };
  /** Opens `file` into a new folder (or a mount, which `cleanup` undoes) and returns it, or undefined if it holds nothing to open. */
  const open = (file: string, cleanup: Array<() => void>): string | undefined => {
    const how = formatOf(file);
    if (how === "raw") return undefined;
    const needs = TOOLS[how];
    if (needs !== undefined && tool(needs) === undefined) {
      problems.push(`${basename(file)} is ${how}, which the scan needs ${needs} to open (it doesn't read a known format raw)`);
      return undefined;
    }
    const trailing = trailingProblem(file, how);
    if (trailing !== undefined) { problems.push(`${basename(file)} ${trailing}`); return undefined; }
    const into = join(work, `${n++}-${basename(file)}`);
    mkdirSync(into, { recursive: true });
    const bytes = (): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(file));
    const out = join(into, decompressedName(basename(file)));
    const stream = (cmd: string[]): boolean => {
      const r = spawnSync(cmd[0]!, [...cmd.slice(1), file], { maxBuffer: 2 * 1024 * 1024 * 1024 });
      // bzip2 says "trailing garbage after EOF ignored" and exits 0: bytes it skipped, so it fails here.
      if ((r.status ?? 1) !== 0 || /trailing/i.test(String(r.stderr ?? ""))) return false;
      writeFileSync(out, r.stdout);
      return true;
    };
    /** In-process: the whole file must be the stream (every byte consumed), or there are bytes nobody opened. */
    const whole = (fn: (d: Uint8Array, o: { info: true }) => { buffer: Uint8Array; engine: { bytesWritten: number } }, what: string): boolean => {
      const b = bytes();
      const r = fn(b, { info: true });
      if (r.engine.bytesWritten !== b.length) { problems.push(`${basename(file)} has ${b.length - r.engine.bytesWritten} bytes after its ${what} stream`); return false; }
      writeFileSync(out, r.buffer);
      return true;
    };
    const ok = ((): boolean => {
      try {
        return openWith();
      } catch {
        return false;
      }
    })();
    function openWith(): boolean {
      switch (how) {
        case "dmg":
          if (!sh(["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", into, file])) return false;
          cleanup.push(() => { sh(["hdiutil", "detach", into, "-force"]); });
          return true;
        case "zip": case "rpm": case "tar": case "ar": return sh(["bsdtar", "-xf", file, "-C", into]);
        case "7z": case "nsis": case "cab": case "msi": case "rar": case "crx": case "pe": case "appendedzip": return sh([tool("7z")!, "x", "-y", `-o${into}`, file]);
        case "deb": {
          if (!sh(["bsdtar", "-xf", file, "-C", into])) return false;
          // The control and data archives are opened in turn, as nested archives.
          return true;
        }
        case "appimage": return sh(["unsquashfs", "-no-progress", "-o", String(elfEnd(bytes())), "-d", join(into, "squashfs-root"), file]);
        case "squashfs": return sh(["unsquashfs", "-no-progress", "-d", join(into, "squashfs-root"), file]);
        case "asar": extractAsar(file, join(into, "asar")); return true;
        // node's gunzip reads every member (Bun.gunzipSync stops after the first) and says how much it consumed.
        case "gz": return whole(gunzipSync as never, "gzip");
        case "br": return whole(brotliDecompressSync as never, "brotli");
        case "zst": writeFileSync(out, Bun.zstdDecompressSync(bytes())); return true;
        case "xz": return stream(["xz", "-dc"]);
        case "lzma": return stream(["xz", "--format=lzma", "-dc"]);
        case "bz2": return stream(["bzip2", "-dc"]);
        case "lz4": return stream(["lz4", "-dc"]);
        case "lzip": return stream(["lzip", "--trailing-error", "-dc"]);
        case "raw": return false;
      }
    }
    if (!ok) { problems.push(`${basename(file)} doesn't open for the scan`); return undefined; }
    return into;
  };
  /**
   * Streams appended to `file` (appendedStreams), each cut out into the work folder and opened as a nested file
   * (one deeper); how many files that read.
   */
  const searchAppended = (label: string, file: string, depth: number, cleanup: Array<() => void>): number => {
    const b = new Uint8Array(readFileSync(file));
    const xzTool = tool("xz"), bzTool = tool("bzip2");
    const { found, problems: bad } = appendedStreams(b, { xz: xzTool, bzip2: bzTool });
    problems.push(...bad.map((p) => `${label} ${p}`));
    let count = 0;
    let end = b.length;
    for (const a of found) {
      if (depth >= MAX_DEPTH) { problems.push(`${label} ends with a ${a.kind} nested deeper than ${MAX_DEPTH} archives`); break; }
      const cut = join(work, `${n++}-${basename(file)}.appended-${a.offset}.${a.kind}`);
      writeFileSync(cut, b.subarray(a.offset, end));
      end = a.offset;
      const opened = open(cut, cleanup);
      if (opened !== undefined) count += scanRoot(`${label} (its appended ${a.kind})`, opened, depth + 1, cleanup);
    }
    return count;
  };
  /** Reads one root (and what opens inside it) with the guard; returns how many files it read. */
  const scanRoot = (label: string, root: string, depth: number, cleanup: Array<() => void>): number => {
    const w = walkTree(root);
    problems.push(...w.problems.map((p) => `${label}: ${p}`));
    accepted.push(...w.accepted);
    const names = join(work, `${n++}-names.txt`);
    writeFileSync(names, `${w.names.join("\n")}\n`);
    if (!runGuard([...w.read, names])) problems.push(`the name scan found the owner's identity in ${label} (the guard printed where)`);
    let count = w.read.length;
    for (const file of w.read) {
      if (!SEARCHED.has(formatOf(file))) continue;
      count += searchAppended(`${label}/${relative(root, file)}`, file, depth, cleanup);
    }
    for (const inner of w.nested) {
      // A plain executable or DLL is read raw (it is in w.read); only one 7z reads as an archive is opened.
      if (formatOf(inner) === "pe") {
        const seven = tool("7z");
        if (seven === undefined) { problems.push(`${label}: ${relative(root, inner)} is a PE file, which the scan needs 7z to look inside`); continue; }
        const r = spawnSync(seven, ["l", "-slt", inner], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
        const type = (r.status ?? 1) === 0 ? peArchiveType(r.stdout ?? "") : undefined;
        if (type === undefined) { problems.push(`${label}: 7z can't read ${relative(root, inner)}`); continue; }
        if (type === "PE") continue;
      }
      if (depth >= MAX_DEPTH) { problems.push(`${label}: ${relative(root, inner)} nests deeper than ${MAX_DEPTH} archives`); continue; }
      const opened = open(inner, cleanup);
      if (opened !== undefined) count += scanRoot(`${label}/${relative(root, inner)}`, opened, depth + 1, cleanup);
    }
    return count;
  };
  try {
    for (const asset of assets) {
      const cleanup: Array<() => void> = [];
      try {
        // The asset's own bytes, then what is inside it.
        if (!runGuard([asset])) problems.push(`the name scan found the owner's identity in ${basename(asset)} (the guard printed where)`);
        let count = 1;
        if (SEARCHED.has(formatOf(asset))) count += searchAppended(basename(asset), asset, 1, cleanup);
        const opened = open(asset, cleanup);
        if (opened !== undefined) {
          const inside = scanRoot(basename(asset), opened, 1, cleanup);
          if (inside === 0) problems.push(`${basename(asset)} yielded no file to read`);
          count += inside;
        }
        read += count;
      } finally {
        for (const c of cleanup.reverse()) c();
      }
    }
    for (const app of apps) {
      const cleanup: Array<() => void> = [];
      try {
        const count = scanRoot(basename(app), app, 1, cleanup);
        if (count === 0) problems.push(`${app} holds no file to read`);
        read += count;
      } finally {
        for (const c of cleanup.reverse()) c();
      }
    }
    return { problems, read, accepted };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------------------------------
// The builds' scan of their whole output folder (#244), through nameScan.
// -------------------------------------------------------------------------------------------------------------------

/** Subtrees of the built output the build-time scan leaves out: empty, see the header. */
export const CLOVER_NAME_SCAN_EXCLUSIONS: readonly RegExp[] = [];

/** Every regular file under `paths` (lstat: a symlink is neither counted nor followed, like `find -type f`). */
export function countFiles(paths: readonly string[]): number {
  let n = 0;
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else if (st.isFile()) n++;
  };
  for (const p of paths) walk(p);
  return n;
}

export type NameScanResult = { ran: true; targets: string[]; scanned: number; total: number } | { ran: false; reason: string };

/**
 * Scans a build's `outDir` (see the header): the plan's targets through nameScan, folders as trees and files as
 * assets, each opened to the bottom. Throws on a hit, on anything the scan couldn't read, on a partition that doesn't
 * cover every file, and, when `required` (a signed release), on a missing guard.
 */
export function runNameScan(outDir: string, opts: { required: boolean; guard?: string; exclusions?: readonly RegExp[]; quiet?: boolean } = { required: false }): NameScanResult {
  const guard = opts.guard ?? nameGuardPath();
  if (!existsSync(guard)) {
    if (opts.required) throw new Error(`the identity scan can't run: ${guard} is missing, and a signed release never ships unscanned (CLOVER_NAME_GUARD names another)`);
    return { ran: false, reason: `no name guard at ${guard}` };
  }
  const exclusions = opts.exclusions ?? CLOVER_NAME_SCAN_EXCLUSIONS;
  const plan = nameScanPlan({
    root: outDir,
    listDir: (p) => readdirSync(p, { withFileTypes: true }).filter((e) => !e.isSymbolicLink()).map((e) => e.name),
    isDir: (p) => lstatSync(p).isDirectory(),
    isExcluded: (rel) => exclusions.some((re) => re.test(rel)),
  });
  const total = countFiles([outDir]);
  const scanned = countFiles(plan.targets);
  const skipped = plan.excluded.length === 0 ? 0 : countFiles(plan.excluded);
  if (scanned + skipped !== total) throw new Error(`the identity scan's partition is wrong (${scanned} scanned + ${skipped} excluded ≠ ${total} files): refusing a gate that may not cover the release`);
  const folders = plan.targets.filter((t) => lstatSync(t).isDirectory());
  const files = plan.targets.filter((t) => !folders.includes(t));
  const r = nameScan(files, folders, { guard, ...(opts.quiet ? { quiet: true } : {}) });
  if (r.problems.some((p) => p.includes("found the owner's identity"))) throw new Error(`the identity scan found a hit in the built release (the guard named the file above): ${r.problems.join("; ")}`);
  if (r.problems.length > 0) throw new Error(`the identity scan couldn't read the whole built release: ${r.problems.join("; ")}`);
  return { ran: true, targets: plan.targets.map((t) => relative(outDir, t) || "."), scanned, total };
}
