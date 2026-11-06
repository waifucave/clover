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
//      (`/Brepro`, no PDB path, source paths remapped)
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
 * A PE file's Authenticode digest, SHA-256, in hex: the whole file but the three things a signature changes, read
 * in file order. Left out: the optional header's CheckSum (4 bytes), the certificate table's entry in the data
 * directory (8 bytes, index 4), and the certificate table itself (the attached signatures, which sit after the
 * image). It is the digest `signtool sign` signs over (for a file whose sections follow its headers in order, as a
 * linker writes them), so it is the same before and after signing, and across signings. Throws on a file that
 * isn't a PE image.
 */
export function authenticodeDigest(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (why: string): never => { throw new Error(`not a PE image: ${why}`); };
  if (bytes.length < 0x40 || view.getUint16(0, true) !== 0x5a4d) fail("no MZ header");
  const pe = view.getUint32(0x3c, true);
  if (pe + 24 > bytes.length || view.getUint32(pe, true) !== 0x00004550) fail("no PE signature");
  const optional = pe + 24;
  const magic = view.getUint16(optional, true);
  if (magic !== 0x10b && magic !== 0x20b) fail(`optional header magic 0x${magic.toString(16)}`);
  const checksum = optional + 64;
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const count = view.getUint32(directories - 4, true);
  if (count < 5) fail("no certificate table entry");
  const certEntry = directories + 4 * 8;
  if (certEntry + 8 > bytes.length) fail("truncated data directories");
  const certOffset = view.getUint32(certEntry, true);
  const certSize = view.getUint32(certEntry + 4, true);
  if (certSize !== 0 && (certOffset < certEntry + 8 || certOffset + certSize > bytes.length)) fail("the certificate table is outside the file");
  const hash = createHash("sha256");
  hash.update(bytes.subarray(0, checksum));
  hash.update(bytes.subarray(checksum + 4, certEntry));
  if (certSize === 0) hash.update(bytes.subarray(certEntry + 8));
  else {
    hash.update(bytes.subarray(certEntry + 8, certOffset));
    hash.update(bytes.subarray(certOffset + certSize));
  }
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
  return { ...env, RUSTFLAGS: flags.join(" "), CARGO_INCREMENTAL: "0" };
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
