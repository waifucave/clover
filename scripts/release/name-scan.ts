// The release's name scan (plan §4 M-M2): every file a release ships, read for the owner's identity before the
// draft goes up. Git hooks see only what enters the repo; a build can still carry an absolute builder path or a name
// in a binary (the predecessor app's 0.2.001 leak), so the gate reads the built files themselves. The patterns live
// OUTSIDE this repo, in the owner's local-only guard (~/norma-private/git-hooks/name-guard.sh `artifacts`): a tracked
// copy would publish the strings it keeps out. So the gate fails closed on a machine without the guard, or without a
// tool it needs to open an asset, and only the owner's Mac cuts a release.
//
// What it reads, for each asset: the asset's own bytes, and everything inside it, opened without running anything:
//   dmg        mounted read-only and unbrowsed (hdiutil attach -readonly -nobrowse), its whole tree, .DS_Store too
//   zip, 7z    extracted (bsdtar, 7z); the Windows installer (NSIS) through 7z, and the app archive inside it
//   deb        its control and data archives, each extracted (and decompressed, and the tar inside opened)
//   rpm        its payload (bsdtar)
//   AppImage   its squashfs, at the offset where the ELF runtime ends (unsquashfs -o)
//   gz, br, zst, xz, and the block maps (gzip)   decompressed
// and nested archives the same way, down to MAX_DEPTH. Beside the contents it reads every path inside each asset and
// every link's target (a list it hands the guard as a file), and fails on a link to an absolute path. It fails when
// an asset yields no file to read. The unpacked apps (the signed Clover.app, CI's win-unpacked) are read whole.
// Read raw, deliberately: any other file, such as app.asar (an uncompressed concatenation) and .pak files.
//
// Accepted (not read by the guard), each for its own reason, and widening this list is a security decision:
//   resources/daemon/srt-win.THIRD_PARTY_NOTICES.txt   third parties' license texts, with their authors' names and
//       addresses, which can collide with a pattern by chance. CI generates it from pinned sources (srt-win.ts:
//       sandbox-runtime's LICENSE and cargo-about's report), never the owner's machine, and it carries no build
//       path. Only that name in that place, in an app's resources; its path is still in the names list.
import { spawnSync } from "node:child_process";
import { brotliDecompressSync } from "node:zlib";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

export const NAME_SCAN_ACCEPTED: readonly RegExp[] = [/(^|\/)resources\/daemon\/srt-win\.THIRD_PARTY_NOTICES\.txt$/];
export const MAX_DEPTH = 4;

export function guardPath(home: string | undefined): string {
  return join(home ?? "", "norma-private", "git-hooks", "name-guard.sh");
}

export type Opener = "dmg" | "zip" | "7z" | "nsis" | "deb" | "rpm" | "tar" | "appimage" | "gz" | "br" | "zst" | "xz" | "raw";

/** How a file is opened for reading (by its name). */
export function openerFor(name: string): Opener {
  if (name.endsWith(".dmg")) return "dmg";
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".7z")) return "7z";
  if (/^Clover-Setup-.+\.exe$/.test(name)) return "nsis";
  if (name.endsWith(".deb")) return "deb";
  if (name.endsWith(".rpm")) return "rpm";
  if (name.endsWith(".tar")) return "tar";
  if (name.endsWith(".AppImage")) return "appimage";
  if (name.endsWith(".gz") || name.endsWith(".blockmap")) return "gz";
  if (name.endsWith(".br")) return "br";
  if (name.endsWith(".zst")) return "zst";
  if (name.endsWith(".xz")) return "xz";
  return "raw";
}

/** The tool each opener needs, beyond Bun itself. */
export const TOOLS: Readonly<Partial<Record<Opener, string>>> = { dmg: "hdiutil", zip: "bsdtar", rpm: "bsdtar", deb: "bsdtar", tar: "bsdtar", "7z": "7z", nsis: "7z", appimage: "unsquashfs", xz: "xz" };

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
    if (openerFor(basename(p)) !== "raw") w.nested.push(p);
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

export function nameScan(assets: readonly string[], apps: readonly string[], home = process.env.HOME): { problems: string[]; read: number; accepted: string[] } {
  const guard = guardPath(home);
  if (!existsSync(guard)) return { problems: [`the name scan needs the owner's local guard (${guard}); this machine can't cut a release`], read: 0, accepted: [] };
  const needed = new Set(assets.map((a) => TOOLS[openerFor(basename(a))]).filter((t): t is string => t !== undefined));
  const missing = [...needed].filter((t) => tool(t) === undefined);
  if (missing.length > 0) return { problems: [`the name scan needs ${missing.join(", ")} to open the release's assets`], read: 0, accepted: [] };
  const work = mkdtempSync(join(tmpdir(), "clover-name-scan-"));
  const problems: string[] = [];
  const accepted: string[] = [];
  let read = 0;
  let n = 0;
  const runGuard = (files: string[]): boolean => {
    for (let i = 0; i < files.length; i += 500) {
      const r = spawnSync(guard, ["artifacts", ...files.slice(i, i + 500)], { stdio: ["ignore", "inherit", "inherit"] });
      if ((r.status ?? 1) !== 0) return false;
    }
    return true;
  };
  /** Opens `file` into a new folder (or a mount, which `cleanup` undoes) and returns it, or undefined if it holds nothing to open. */
  const open = (file: string, cleanup: Array<() => void>): string | undefined => {
    const how = openerFor(basename(file));
    if (how === "raw") return undefined;
    const into = join(work, `${n++}-${basename(file)}`);
    mkdirSync(into, { recursive: true });
    const bytes = (): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(file));
    const ok = (() => {
      switch (how) {
        case "dmg":
          if (!sh(["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", into, file])) return false;
          cleanup.push(() => { sh(["hdiutil", "detach", into, "-force"]); });
          return true;
        case "zip": case "rpm": case "tar": return sh(["bsdtar", "-xf", file, "-C", into]);
        case "7z": case "nsis": return sh([tool("7z")!, "x", "-y", `-o${into}`, file]);
        case "deb": {
          if (!sh(["bsdtar", "-xf", file, "-C", into])) return false;
          // The control and data archives are opened in turn, as nested archives.
          return true;
        }
        case "appimage": return sh(["unsquashfs", "-no-progress", "-o", String(elfEnd(bytes())), "-d", join(into, "squashfs-root"), file]);
        case "gz": writeFileSync(join(into, basename(file).replace(/\.gz$/, "")), Bun.gunzipSync(bytes())); return true;
        case "br": writeFileSync(join(into, basename(file).replace(/\.br$/, "")), brotliDecompressSync(bytes())); return true;
        case "zst": writeFileSync(join(into, basename(file).replace(/\.zst$/, "")), Bun.zstdDecompressSync(bytes())); return true;
        case "xz": {
          const r = spawnSync("xz", ["-dc", file], { maxBuffer: 2 * 1024 * 1024 * 1024 });
          if ((r.status ?? 1) !== 0) return false;
          writeFileSync(join(into, basename(file).replace(/\.xz$/, "")), r.stdout);
          return true;
        }
      }
    })();
    if (!ok) { problems.push(`${basename(file)} doesn't open for the scan`); return undefined; }
    return into;
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
