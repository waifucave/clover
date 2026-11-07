// The compiled core runs only its own code. A `bun build --compile` binary is the whole Bun runtime, and Bun reads
// a few environment variables before the app's code starts that make it run someone else's (lane M's door audit,
// measured on Bun 1.4.4 against `clover-core`):
//
//   BUN_BE_BUN=1                       the binary IS plain Bun: `clover-core x.js`, `clover-core -e …`
//   BUN_OPTIONS=--preload x.js         (also -r, --require, --import, --config=<a bunfig with a preload>) runs x.js
//                                      before main, whatever the arguments
//   BUN_INSPECT=ws://…?wait=1          opens a debugger port: Runtime.evaluate runs anything in the process
//   BUN_INSPECT_CONNECT_TO=unix://…    connects the debugger out to a socket of the caller's choosing
//   NODE_PATH                          steers module resolution (the runtime ladder's package rung; that rung is now
//                                      off in a compiled binary too, runtime-sdk/executable.ts)
//
// On macOS the Keychain items trust the signed `clover-core` alone, so any of these hands the user's tokens and
// provider keys to whoever can start the binary. No Bun flag turns them off, so this build step does, before the
// binary is signed: every occurrence of each name in Bun's own code is overwritten, same length, with a name NO
// ENVIRONMENT CAN CARRY. A plain renamed token would only move the door: anyone can read it out of the binary and set
// it (measured: a capital-letter token worked exactly like BUN_BE_BUN). So the replacement starts with a NUL:
//   - in Bun's native code the lookup is libc `getenv` (a C string, measured: a NUL in the middle made the prefix
//     settable) or a comparison of the whole slice against each environment entry's key. As a C string the name is
//     empty, and `getenv("")` finds nothing (measured on macOS; glibc and musl return NULL for an empty name); as a
//     slice it holds a NUL, which no key can. A name with `=` would not do: macOS's `getenv` stops the name at `=`.
//   - in Bun's built-in JavaScript the reads are `process.env.NAME` / `Bun.env.NAME` and quoted lists. A member read
//     `.NAME` becomes `["\0…"]` and a quoted `"NAME"` becomes `"\0…"` (the escape, so the source stays valid JS, an
//     assignment target included): a key holding U+0000, which no environment has.
// The rest of each replacement is capital letters derived from the name, so a rebuild is byte-for-byte the same.
// The app's own bundle — the module graph Bun embeds in its `.bun` section (`__BUN,__bun` in a Mach-O) — is never
// touched: the core's own code names some of these variables on purpose (the run home's environment refusals).
//
// `--check` is the byte check: no sealed name is left outside the module graph. `scripts/verify-sealed-core.ts` then
// runs the sealed, signed binary with each door set and asserts that nothing foreign runs and no debugger opens.
//
//   bun scripts/seal-bun-doors.ts <binary> [--target <daemon target>]   seal in place (macOS: re-sign ad hoc)
//   bun scripts/seal-bun-doors.ts <binary> --check                     the byte check only
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** The names sealed, longest first so a name inside a longer one (BUN_INSPECT in BUN_INSPECT_CONNECT_TO) is never
 *  half-sealed. BUN_INSPECT_NOTIFY and BUN_INSPECT_PRELOAD only matter with a debugger, and are sealed with it. */
export const SEALED_ENV_NAMES = ["BUN_INSPECT_CONNECT_TO", "BUN_INSPECT_PRELOAD", "BUN_INSPECT_NOTIFY", "BUN_INSPECT", "BUN_OPTIONS", "BUN_BE_BUN", "NODE_PATH"] as const;

/** The names Bun must still contain before sealing (so a Bun that renamed one fails the build, not silently). */
export const REQUIRED_NATIVE_NAMES = ["BUN_BE_BUN", "BUN_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO"] as const;

/** Capital letters derived from `name`, `length` long: the visible rest of each replacement. */
export function sealFiller(name: string, length: number): string {
  const digest = createHash("sha256").update(`clover-sealed-env:${name}`).digest();
  let out = "";
  for (let i = 0; out.length < length; i++) out += String.fromCharCode(65 + (digest[i % digest.length]! + i) % 26);
  return out;
}

/** Where an occurrence sits: Bun's native code, a JS member read (`.NAME`), or a quoted JS string (`"NAME"`). */
export type Site = "native" | "member" | "quoted";

export function siteOf(bytes: Uint8Array, at: number, length: number): Site {
  const before = bytes[at - 1], after = bytes[at + length];
  if (before === 0x2e) return "member";
  if ((before === 0x22 || before === 0x27 || before === 0x60) && after === before) return "quoted";
  return "native";
}

/** What an occurrence of `name` becomes, and where it starts (a member read replaces its dot too). */
export function sealedReplacement(name: string, site: Site): { bytes: Uint8Array; offset: number } {
  const enc = new TextEncoder();
  if (site === "member") return { bytes: enc.encode(`["\\0${sealFiller(name, name.length - 5)}"]`), offset: -1 };
  if (site === "quoted") return { bytes: enc.encode(`\\0${sealFiller(name, name.length - 2)}`), offset: 0 };
  return { bytes: Uint8Array.of(0, ...enc.encode(sealFiller(name, name.length - 1))), offset: 0 };
}

export type ExecutableFormat = "macho" | "elf" | "pe";

/** Where the app's module graph is: `[start, end)` in file offsets. Throws when the binary has none. */
export function moduleGraphRange(bytes: Uint8Array): { format: ExecutableFormat; start: number; end: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, len: number) => String.fromCharCode(...bytes.subarray(at, at + len)).replace(/\0+$/, "");
  if (v.getUint32(0, true) === 0xfeedfacf) {
    const ncmds = v.getUint32(16, true);
    let at = 32;
    for (let i = 0; i < ncmds; i++) {
      const cmd = v.getUint32(at, true), size = v.getUint32(at + 4, true);
      if (cmd === 0x19 && ascii(at + 8, 16) === "__BUN") {
        const nsects = v.getUint32(at + 64, true);
        for (let s = 0; s < nsects; s++) {
          const sect = at + 72 + s * 80;
          if (ascii(sect, 16) === "__bun") {
            const offset = v.getUint32(sect + 48, true), sz = Number(v.getBigUint64(sect + 40, true));
            return { format: "macho", start: offset, end: offset + sz };
          }
        }
      }
      at += size;
    }
    throw new Error("a Mach-O with no __BUN,__bun section: not a Bun standalone binary");
  }
  if (v.getUint32(0, false) === 0x7f454c46) {
    const shoff = Number(v.getBigUint64(0x28, true)), shentsize = v.getUint16(0x3a, true), shnum = v.getUint16(0x3c, true), shstrndx = v.getUint16(0x3e, true);
    const strOff = Number(v.getBigUint64(shoff + shstrndx * shentsize + 0x18, true));
    for (let i = 0; i < shnum; i++) {
      const sh = shoff + i * shentsize;
      const nameAt = strOff + v.getUint32(sh, true);
      let end = nameAt;
      while (bytes[end] !== 0) end++;
      if (ascii(nameAt, end - nameAt) === ".bun") {
        const offset = Number(v.getBigUint64(sh + 0x18, true)), size = Number(v.getBigUint64(sh + 0x20, true));
        return { format: "elf", start: offset, end: offset + size };
      }
    }
    throw new Error("an ELF with no .bun section: not a Bun standalone binary");
  }
  if (v.getUint16(0, true) === 0x5a4d) {
    const pe = v.getUint32(0x3c, true), nsec = v.getUint16(pe + 6, true), opt = v.getUint16(pe + 20, true);
    for (let i = 0; i < nsec; i++) {
      const sec = pe + 24 + opt + i * 40;
      if (ascii(sec, 8) === ".bun") return { format: "pe", start: v.getUint32(sec + 20, true), end: v.getUint32(sec + 20, true) + v.getUint32(sec + 16, true) };
    }
    throw new Error("a PE with no .bun section: not a Bun standalone binary");
  }
  throw new Error("not a Mach-O, ELF or PE binary");
}

function occurrences(bytes: Uint8Array, needle: Uint8Array, skip: { start: number; end: number }): number[] {
  const out: number[] = [];
  const first = needle[0]!;
  for (let i = bytes.indexOf(first); i !== -1 && i <= bytes.length - needle.length; i = bytes.indexOf(first, i + 1)) {
    if (i >= skip.start && i < skip.end) { i = skip.end - 1; continue; }
    let match = true;
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) { match = false; break; }
    if (match) out.push(i);
  }
  return out;
}

export interface SealResult { format: ExecutableFormat; sealed: Record<string, number>; alreadySealed: boolean }

/** Seals `bytes` in place. Throws when Bun no longer carries a name it must (a new Bun needs a new audit). */
export function sealBunDoors(bytes: Uint8Array): SealResult {
  const graph = moduleGraphRange(bytes);
  const enc = new TextEncoder();
  const sealed: Record<string, number> = {};
  for (const name of SEALED_ENV_NAMES) {
    const at = occurrences(bytes, enc.encode(name), graph);
    for (const i of at) {
      const r = sealedReplacement(name, siteOf(bytes, i, name.length));
      bytes.set(r.bytes, i + r.offset);
    }
    sealed[name] = at.length;
  }
  const alreadySealed = REQUIRED_NATIVE_NAMES.every((n) => sealed[n] === 0 && occurrences(bytes, sealedReplacement(n, "native").bytes, graph).length > 0);
  if (!alreadySealed) {
    const missing = REQUIRED_NATIVE_NAMES.filter((n) => sealed[n] === 0);
    if (missing.length > 0) throw new Error(`Bun no longer names ${missing.join(", ")} where this step looks: audit the new Bun's doors before shipping it (scripts/seal-bun-doors.ts)`);
  }
  return { format: graph.format, sealed, alreadySealed };
}

/** The byte check: every sealed name is gone from outside the module graph, and each required token is there. */
export function sealProblems(bytes: Uint8Array): string[] {
  const graph = moduleGraphRange(bytes);
  const enc = new TextEncoder();
  const problems: string[] = [];
  for (const name of SEALED_ENV_NAMES) {
    const left = occurrences(bytes, enc.encode(name), graph);
    if (left.length > 0) problems.push(`${name} is still in Bun's code at ${left.map((o) => `0x${o.toString(16)}`).join(", ")}`);
  }
  for (const name of REQUIRED_NATIVE_NAMES) {
    if (occurrences(bytes, sealedReplacement(name, "native").bytes, graph).length === 0) problems.push(`${name}'s sealed token is missing: the binary was not sealed by this step`);
  }
  return problems;
}

/** Seals the file at `path`; on macOS a Mach-O is re-signed ad hoc so it runs (a release or the dev daemon signs it
 *  for real afterwards). Returns what was sealed. */
export function sealFile(path: string, platform: NodeJS.Platform = process.platform): SealResult {
  const bytes = new Uint8Array(readFileSync(path));
  const result = sealBunDoors(bytes);
  if (!result.alreadySealed) {
    writeFileSync(path, bytes);
    if (result.format === "macho" && platform === "darwin") {
      const r = spawnSync("codesign", ["--force", "--sign", "-", path], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`codesign (ad hoc) after sealing failed: ${r.stderr.trim()}`);
    }
  }
  const problems = sealProblems(new Uint8Array(readFileSync(path)));
  if (problems.length > 0) throw new Error(`the sealed binary fails the byte check: ${problems.join("; ")}`);
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (path === undefined) {
    console.error("usage: bun scripts/seal-bun-doors.ts <binary> [--check]");
    process.exit(2);
  }
  try {
    if (args.includes("--check")) {
      const problems = sealProblems(new Uint8Array(readFileSync(path)));
      for (const p of problems) console.error(`seal-bun-doors: ${p}`);
      if (problems.length === 0) console.log(`seal-bun-doors: ${path}: sealed (${SEALED_ENV_NAMES.join(", ")})`);
      process.exit(problems.length === 0 ? 0 : 1);
    }
    const r = sealFile(path);
    console.log(`seal-bun-doors: ${path}: ${r.alreadySealed ? "already sealed" : Object.entries(r.sealed).map(([n, c]) => `${n}×${c}`).join(" ")}`);
  } catch (err) {
    console.error(`seal-bun-doors: ${(err as Error).message}`);
    process.exit(1);
  }
}
