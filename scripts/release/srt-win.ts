// srt-win.exe, the Windows Bash fence's launcher (lane C, spec §9.1): built from sandbox-runtime's source at a
// pinned commit (Apache-2.0), with a static CRT so no VC++ runtime ships beside it, and checked against the digest
// core pins for it (`SRT_WIN_PINS`, packages/core/src/fence/windows-launcher.ts), which core checks again before
// every launch. The pin is the file's Authenticode digest (`authenticodeDigest`), not its SHA-256: signing adds a
// signature, and a timestamp that differs every time, but leaves the digest as it was (the controller's ruling). The release build stages it in resources\daemon\, beside clover-core.exe and clover-link.exe.
//
//   bun scripts/release/srt-win.ts [--arch x64|arm64[,…]] [--print] [--dry-run]
//
// Windows only, with Rust (rustup: the source pins its own toolchain in rust-toolchain.toml, which rustup reads
// because cargo runs from the source's root). For each architecture it:
//   1. fetches anthropics/sandbox-runtime at SRT_WIN_SOURCE.tag into a temp folder and checks the tag is the pinned
//      commit
//   2. builds vendor/srt-win-src (`cargo build --release --locked --target <triple>`, the test hooks off), with a
//      static CRT, and with the linker and paths set so the same source gives the same bytes on any machine
//      (`/Brepro`, no PDB path, source paths remapped). The same bytes from two clean builds is proven on CI's one
//      Windows runner image (ci.yml's srt-win job); another machine or image is not yet measured
//   3. copies it to dist/srt-win/<arch>/srt-win.exe, prints its Authenticode digest, and fails unless it is the pinned one
//      (`--print` only prints: for measuring a build before its pin is set)
//   4. writes dist/srt-win/THIRD_PARTY_NOTICES.txt: sandbox-runtime's LICENSE and the licenses of the crates it
//      compiles in (cargo-about, run in the source's root)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The source: sandbox-runtime 0.0.81, as lane C vendors it. */
export const SRT_WIN_SOURCE = {
  repo: "https://github.com/anthropics/sandbox-runtime",
  tag: "v0.0.81",
  commit: "c40cf14a65d025e3cd27f071f13a73c12b3b1f92",
  dir: "vendor/srt-win-src",
  license: "LICENSE",
} as const;

export const SRT_WIN_ARCHES = ["x64", "arm64"] as const;
export type SrtWinArch = (typeof SRT_WIN_ARCHES)[number];

export const SRT_WIN_TRIPLES: Readonly<Record<SrtWinArch, string>> = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };

/** Where the built launcher lands, relative to the repo root (the release build stages it from here). */
export function srtWinOutput(arch: SrtWinArch): string {
  return `dist/srt-win/${arch}/srt-win.exe`;
}
export const SRT_WIN_NOTICES = "dist/srt-win/THIRD_PARTY_NOTICES.txt";

/**
 * A PE file's Authenticode digest, SHA-256, in hex: the image but the three things a signature changes, read in file
 * order, and padded with zeros to a multiple of 8 bytes (as signtool pads before the signature), so it is the same
 * before and after signing, and across signings. Left out: the optional header's CheckSum (4 bytes), the certificate
 * table's entry in the data directory (8 bytes, index 4), and the certificate table itself.
 *
 * Fails closed (throws) on a file that isn't a well-formed PE, and on one whose certificate entry could hide code: a
 * certificate table, when present, must start after the headers and at or after the end of the last section's raw
 * data, end exactly at the end of the file, start 8-byte aligned, and have only zero padding before it. Core's
 * launch-time check enforces the same rules (lane C's).
 */
export function authenticodeDigest(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (why: string): never => { throw new Error(`not a PE image: ${why}`); };
  const u16 = (at: number): number => (at + 2 <= bytes.length ? view.getUint16(at, true) : fail("truncated"));
  const u32 = (at: number): number => (at + 4 <= bytes.length ? view.getUint32(at, true) : fail("truncated"));
  if (bytes.length < 0x40 || u16(0) !== 0x5a4d) fail("no MZ header");
  const pe = u32(0x3c);
  if (u32(pe) !== 0x00004550) fail("no PE signature");
  const sections = u16(pe + 6);
  const optionalSize = u16(pe + 20);
  const optional = pe + 24;
  const magic = u16(optional);
  if (magic !== 0x10b && magic !== 0x20b) fail(`optional header magic 0x${magic.toString(16)}`);
  const sizeOfHeaders = u32(optional + 60);
  const checksum = optional + 64;
  const directories = optional + (magic === 0x20b ? 112 : 96);
  if (u32(directories - 4) < 5) fail("no certificate table entry");
  const certEntry = directories + 4 * 8;
  if (certEntry + 8 > optional + optionalSize) fail("the data directories run past the optional header");
  const certOffset = u32(certEntry);
  const certSize = u32(certEntry + 4);
  // Where the image ends: the end of the headers, or of the last section's raw data.
  let imageEnd = sizeOfHeaders;
  for (let i = 0; i < sections; i++) {
    const at = optional + optionalSize + i * 40;
    const raw = u32(at + 16);
    const ptr = u32(at + 20);
    if (raw > 0) imageEnd = Math.max(imageEnd, ptr + raw);
  }
  if (imageEnd > bytes.length) fail("its sections run past the end of the file");
  let hashedEnd = bytes.length;
  if (certSize !== 0) {
    if (certOffset < sizeOfHeaders) fail("the certificate table starts inside the headers");
    if (certOffset < imageEnd) fail("the certificate table overlaps a section's data");
    if (certOffset + certSize !== bytes.length) fail("the certificate table doesn't end at the end of the file");
    if (certOffset % 8 !== 0) fail("the certificate table isn't 8-byte aligned");
    for (let i = imageEnd; i < certOffset; i++) if (bytes[i] !== 0) fail("there is data between the image and the certificate table");
    hashedEnd = certOffset;
  }
  const hash = createHash("sha256");
  hash.update(bytes.subarray(0, checksum));
  hash.update(bytes.subarray(checksum + 4, certEntry));
  hash.update(bytes.subarray(certEntry + 8, hashedEnd));
  if (hashedEnd % 8 !== 0) hash.update(new Uint8Array(8 - (hashedEnd % 8)));
  return hash.digest("hex");
}

/** Core's pin file (lane C's). */
export const PIN_FILE = "packages/core/src/fence/windows-launcher.ts";

/**
 * The pins in core's launcher file: `SRT_WIN_PINS = { x64: "<hex>", arm64: "<hex>" }`. Undefined for an architecture
 * the file doesn't pin (or no file yet).
 */
export function parsePins(source: string | undefined): Partial<Record<SrtWinArch, string>> {
  if (source === undefined) return {};
  const block = /SRT_WIN_PINS[^=]*=\s*(?:Object\.freeze\()?\{([^}]*)\}/.exec(source)?.[1];
  if (block === undefined) return {};
  const out: Partial<Record<SrtWinArch, string>> = {};
  for (const arch of SRT_WIN_ARCHES) {
    const m = new RegExp(`\\b${arch}\\s*:\\s*["']([0-9a-f]{64})["']`).exec(block);
    if (m) out[arch] = m[1]!;
  }
  return out;
}

/**
 * The build's environment: a static CRT, a reproducible link (no timestamp, no PDB path) and the machine's paths
 * remapped, so the hash depends on the source and the toolchain alone. `cargoHome` and `src` are this machine's.
 */
export function buildEnv(env: Record<string, string | undefined>, src: string, cargoHome: string): Record<string, string | undefined> {
  const flags = [
    "-C target-feature=+crt-static",
    "-C link-arg=/Brepro",
    "-C link-arg=/DEBUG:NONE",
    "-C debuginfo=0",
    `--remap-path-prefix=${src}=/srt`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
  ];
  // CARGO_ENCODED_RUSTFLAGS (0x1f between flags): a path with a space (the owner's checkout has one) stays one flag.
  const { RUSTFLAGS: _ignored, ...rest } = env;
  return { ...rest, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"), CARGO_INCREMENTAL: "0" };
}

export function cargoArgs(arch: SrtWinArch, src: string): string[] {
  return ["cargo", "build", "--release", "--locked", "--manifest-path", join(src, SRT_WIN_SOURCE.dir, "Cargo.toml"), "--target", SRT_WIN_TRIPLES[arch]];
}

/** What's wrong with a built launcher's hash against core's pin (`print` only reports). */
export function pinProblems(arch: SrtWinArch, sha256: string, pins: Partial<Record<SrtWinArch, string>>, print: boolean): string[] {
  if (print) return [];
  const pin = pins[arch];
  if (pin === undefined) return [`core pins no srt-win.exe for ${arch} (${PIN_FILE}'s SRT_WIN_PINS)`];
  return pin === sha256 ? [] : [`srt-win.exe for ${arch} has the Authenticode digest ${sha256}, but core pins ${pin}`];
}

export interface SrtWinArgs {
  arches: SrtWinArch[];
  print: boolean;
  dryRun: boolean;
}

export function parseSrtWinArgs(argv: readonly string[]): SrtWinArgs {
  let arches: SrtWinArch[] = ["x64"];
  let print = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--print") print = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--arch" || a.startsWith("--arch=")) {
      const list = (a === "--arch" ? argv[++i] : a.slice("--arch=".length)) ?? "";
      const named = list.split(",").filter(Boolean);
      const unknown = named.filter((x) => !(SRT_WIN_ARCHES as readonly string[]).includes(x));
      if (named.length === 0 || unknown.length > 0) throw new Error(`--arch takes x64 and/or arm64${unknown.length ? ` (not ${unknown.join(", ")})` : ""}`);
      arches = [...new Set(named)] as SrtWinArch[];
    } else throw new Error(`unknown argument ${a} (usage: release/srt-win [--arch x64|arm64[,…]] [--print] [--dry-run])`);
  }
  return { arches, print, dryRun };
}

function must(cmd: readonly string[], cwd: string, env?: Record<string, string | undefined>): string {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", env: (env ?? process.env) as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
  if ((r.status ?? 1) !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}… failed (exit ${r.status ?? "signal"}): ${(r.stderr ?? "").slice(-1500)}`);
  return r.stdout ?? "";
}

export function main(argv: readonly string[], root: string): number {
  let a: SrtWinArgs;
  try {
    a = parseSrtWinArgs(argv);
  } catch (err) {
    console.error(`srt-win: ${(err as Error).message}`);
    return 2;
  }
  if (a.dryRun) {
    console.log(`srt-win: ${SRT_WIN_SOURCE.repo} ${SRT_WIN_SOURCE.tag} (${SRT_WIN_SOURCE.commit}), ${SRT_WIN_SOURCE.dir}`);
    for (const arch of a.arches) console.log(`srt-win: ${arch}: ${cargoArgs(arch, "<src>").join(" ")} → ${srtWinOutput(arch)}${a.print ? " (print the hash)" : " (checked against core's pin)"}`);
    return 0;
  }
  if (process.platform !== "win32") { console.error("srt-win: it builds on Windows (the MSVC toolchain); use --dry-run elsewhere"); return 2; }
  const pinSource = existsSync(join(root, PIN_FILE)) ? readFileSync(join(root, PIN_FILE), "utf8") : undefined;
  const pins = parsePins(pinSource);
  const src = mkdtempSync(join(tmpdir(), "clover-srt-win-"));
  try {
    must(["git", "clone", "--quiet", "--depth", "1", "--branch", SRT_WIN_SOURCE.tag, SRT_WIN_SOURCE.repo, src], root);
    const head = must(["git", "rev-parse", "HEAD"], src).trim();
    if (head !== SRT_WIN_SOURCE.commit) throw new Error(`${SRT_WIN_SOURCE.tag} is ${head}, not the pinned ${SRT_WIN_SOURCE.commit}`);
    const cargoHome = process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo");
    const problems: string[] = [];
    for (const arch of a.arches) {
      // cargo runs from the source's root, so rustup takes its rust-toolchain.toml; the target is added to that toolchain.
      must(["rustup", "toolchain", "install"], src);
      must(["rustup", "target", "add", SRT_WIN_TRIPLES[arch]], src);
      console.log(`srt-win: building for ${arch}…`);
      must(cargoArgs(arch, src), src, buildEnv(process.env, src, cargoHome));
      const out = join(root, ...srtWinOutput(arch).split("/"));
      mkdirSync(dirname(out), { recursive: true });
      copyFileSync(join(src, SRT_WIN_SOURCE.dir, "target", SRT_WIN_TRIPLES[arch], "release", "srt-win.exe"), out);
      const bytes = new Uint8Array(readFileSync(out));
      const digest = authenticodeDigest(bytes);
      console.log(`srt-win: ${srtWinOutput(arch)} authenticode-sha256 ${digest} (file sha256 ${createHash("sha256").update(bytes).digest("hex")})`);
      problems.push(...pinProblems(arch, digest, pins, a.print));
    }
    // The notices: sandbox-runtime's own license, then every crate compiled in (cargo-about's plain-text report).
    const crates = must(["cargo", "about", "generate", "--config", join(root, "packaging", "windows", "about.toml"), "--manifest-path", join(src, SRT_WIN_SOURCE.dir, "Cargo.toml"), join(root, "packaging", "windows", "about.hbs")], src);
    const notices = [
      "srt-win.exe is built from sandbox-runtime (https://github.com/anthropics/sandbox-runtime),",
      `${SRT_WIN_SOURCE.tag}, commit ${SRT_WIN_SOURCE.commit}, under the Apache License 2.0:`,
      "",
      readFileSync(join(src, SRT_WIN_SOURCE.license), "utf8").trimEnd(),
      "",
      "It compiles in these crates, under their own licenses:",
      "",
      crates.trimEnd(),
      "",
    ].join("\n");
    writeFileSync(join(root, ...SRT_WIN_NOTICES.split("/")), notices);
    for (const p of problems) console.error(`srt-win: ${p}`);
    return problems.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(`srt-win: ${(err as Error).message}`);
    return 1;
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
