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
//   gz, br, zst, xz, bz2, lzma, lz4, lzip, and the block maps (gzip)   decompressed
// and nested archives the same way, down to MAX_DEPTH. A file is known by its bytes (formatOf: the magic numbers of
// each format above) as well as its name, so a renamed archive (`hidden.tgz`, `blob.bin`) is opened all the same; a
// file in a format the scan knows but can't open here (a tool missing, or the bytes don't open) fails the scan
// rather than being read raw. Beside the contents it reads every path inside each asset and every link's target (a
// list it hands the guard as a file), and fails on a link to an absolute path. It fails when an asset yields no file
// to read. The unpacked apps (the signed Clover.app, CI's win-unpacked) are read whole.
// Every file is also read raw, as it is, opened or not: .pak files, and anything with no format above.
//
// Accepted (not read by the guard), each for its own reason, and widening this list is a security decision:
//   resources/daemon/srt-win.THIRD_PARTY_NOTICES.txt   third parties' license texts, with their authors' names and
//       addresses, which can collide with a pattern by chance. CI generates it from pinned sources (srt-win.ts:
//       sandbox-runtime's LICENSE and cargo-about's report), never the owner's machine, and it carries no build
//       path. Only that name in that place, in an app's resources; its path is still in the names list.
import { extractAll as extractAsar } from "@electron/asar";
import { spawnSync } from "node:child_process";
import { brotliDecompressSync } from "node:zlib";
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
  | "gz" | "br" | "zst" | "xz" | "bz2" | "lzma" | "lz4" | "lzip" | "raw";

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

/**
 * How a file is opened for reading, by its bytes: `head` is its first 512 bytes (or all of it), `tail` its last 512.
 * Undefined when no format's magic number matches (brotli has none; it is known by name only).
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
  if (tail.length === 512 && at(tail, 0, ascii("koly"))) return "dmg";
  return undefined;
}

/** How `path` is opened: by its bytes first, and by its name when its bytes match no format. */
export function formatOf(path: string): Opener {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const head = new Uint8Array(Math.min(512, size));
    readSync(fd, head, 0, head.length, 0);
    const tail = new Uint8Array(size >= 1024 ? 512 : 0);
    if (tail.length > 0) readSync(fd, tail, 0, 512, size - 512);
    const byName = openerFor(basename(path));
    // The release's own installer is a PE file (no magic of its own here) that 7z opens as NSIS.
    if (byName === "nsis") return byName;
    return magicOf(head, tail) ?? byName;
  } finally {
    closeSync(fd);
  }
}

/** The tool each opener needs, beyond Bun itself. */
export const TOOLS: Readonly<Partial<Record<Opener, string>>> = {
  dmg: "hdiutil", zip: "bsdtar", rpm: "bsdtar", deb: "bsdtar", ar: "bsdtar", tar: "bsdtar",
  "7z": "7z", nsis: "7z", cab: "7z", msi: "7z", rar: "7z", crx: "7z",
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

/** The one absolute link a disk image may hold: the drag-to-install `Applications` → `/Applications` at its root, as
 *  electron-builder's dmg carries it. Nothing is behind it to read (it is never followed); anywhere else, or to any
 *  other target, an absolute link is still a problem. */
export const DMG_ROOT_LINKS: Readonly<Record<string, string>> = Object.freeze({ Applications: "/Applications" });

/** One tree, without following links: what to read, what's accepted, the names, and links to absolute paths (but
 *  those `rootLinks` names, at the root, to exactly their target). */
export function walkTree(root: string, rootLinks: Readonly<Record<string, string>> = {}): Walked {
  const w: Walked = { read: [], accepted: [], names: [], problems: [], nested: [] };
  const visit = (p: string): void => {
    const rel = relative(root, p).split("\\").join("/");
    if (rel !== "") w.names.push(rel);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(p);
      w.names.push(target);
      if (isAbsolute(target) && !(Object.hasOwn(rootLinks, rel) && rootLinks[rel] === target)) w.problems.push(`${rel} links to an absolute path (${target})`);
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
  /** The roots that are mounted disk images (their `DMG_ROOT_LINKS` are allowed). */
  const dmgRoots = new Set<string>();
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
    const into = join(work, `${n++}-${basename(file)}`);
    mkdirSync(into, { recursive: true });
    const bytes = (): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(file));
    const out = join(into, decompressedName(basename(file)));
    const stream = (cmd: string[]): boolean => {
      const r = spawnSync(cmd[0]!, [...cmd.slice(1), file], { maxBuffer: 2 * 1024 * 1024 * 1024 });
      if ((r.status ?? 1) !== 0) return false;
      writeFileSync(out, r.stdout);
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
          dmgRoots.add(into);
          cleanup.push(() => { sh(["hdiutil", "detach", into, "-force"]); });
          return true;
        case "zip": case "rpm": case "tar": case "ar": return sh(["bsdtar", "-xf", file, "-C", into]);
        case "7z": case "nsis": case "cab": case "msi": case "rar": case "crx": return sh([tool("7z")!, "x", "-y", `-o${into}`, file]);
        case "deb": {
          if (!sh(["bsdtar", "-xf", file, "-C", into])) return false;
          // The control and data archives are opened in turn, as nested archives.
          return true;
        }
        case "appimage": return sh(["unsquashfs", "-no-progress", "-o", String(elfEnd(bytes())), "-d", join(into, "squashfs-root"), file]);
        case "squashfs": return sh(["unsquashfs", "-no-progress", "-d", join(into, "squashfs-root"), file]);
        case "asar": extractAsar(file, join(into, "asar")); return true;
        case "gz": writeFileSync(out, Bun.gunzipSync(bytes())); return true;
        case "br": writeFileSync(out, brotliDecompressSync(bytes())); return true;
        case "zst": writeFileSync(out, Bun.zstdDecompressSync(bytes())); return true;
        case "xz": return stream(["xz", "-dc"]);
        case "lzma": return stream(["xz", "--format=lzma", "-dc"]);
        case "bz2": return stream(["bzip2", "-dc"]);
        case "lz4": return stream(["lz4", "-dc"]);
        case "lzip": return stream(["lzip", "-dc"]);
        case "raw": return false;
      }
    }
    if (!ok) { problems.push(`${basename(file)} doesn't open for the scan`); return undefined; }
    return into;
  };
  /** Reads one root (and what opens inside it) with the guard; returns how many files it read. */
  const scanRoot = (label: string, root: string, depth: number, cleanup: Array<() => void>): number => {
    const w = walkTree(root, dmgRoots.has(root) ? DMG_ROOT_LINKS : {});
    problems.push(...w.problems.map((p) => `${label}: ${p}`));
    accepted.push(...w.accepted);
    const names = join(work, `${n++}-names.txt`);
    writeFileSync(names, `${w.names.join("\n")}\n`);
    if (!runGuard([...w.read, names])) problems.push(`the name scan found the owner's identity in ${label} (the guard printed where)`);
    let count = w.read.length;
    for (const inner of w.nested) {
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
