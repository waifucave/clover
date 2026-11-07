// The compiled core runs only its own code. A `bun build --compile` binary is the whole Bun runtime, and Bun reads
// a few environment variables before the app's code starts that make it run someone else's (lane M's door audit,
// measured on Bun 1.4.4 against `clover-core`):
//
//   BUN_BE_BUN=1                       the binary IS plain Bun: `clover-core x.js`, `clover-core -e …`
//   BUN_OPTIONS=--preload x.js         (also -r, --require, --import, --config=<a bunfig with a preload>) runs x.js
//                                      before main, whatever the arguments
//   BUN_INSPECT=ws://…?wait=1          opens a debugger port: Runtime.evaluate runs anything in the process
//   BUN_INSPECT_CONNECT_TO=unix://…    connects the debugger out to a socket of the caller's choosing
//   BUN_INTERNAL_WEBVIEW_HOST          (macOS) turns the binary into Bun.WebView's host process instead of the core:
//                                      the sweep found it (it hangs, or crashes, never running main); the core uses
//                                      no Bun.WebView, so its own spawn of that host (`…=3`) is sealed with it
//   NODE_PATH                          steers module resolution (the runtime ladder's package rung; that rung is now
//                                      off in a compiled binary too, runtime-sdk/executable.ts)
//
// On macOS the Keychain items trust the signed `clover-core` alone, so any of these hands the user's tokens and
// provider keys to whoever can start the binary. BUN_CONFIG_VERBOSE_FETCH needs no foreign code at all: it prints the
// core's request headers — `x-api-key`, and with `curl` the `Authorization: Bearer` — to stderr, which daemon.log
// keeps. No Bun flag turns any of them off, so this build step does, before the binary is signed: every occurrence of
// each name in Bun's own code is overwritten, same length, with a name the environment cannot carry to the process.
// A plain renamed token only moves the door (it can be read out of the binary and set: measured), and what makes a
// name unsettable depends on how the OS hands the environment over, so it is chosen per binary format:
//
//   Mach-O (macOS)  `DYLD_` + letters. Bun reads these through libc `getenv`, and Darwin's `getenv` cuts a name at its
//                   first `=` or NUL, so no spelling is unsettable there (measured: a NUL-led name matched `=1`, and
//                   one `=<payload>` entry set every sealed name at once). But dyld removes every `DYLD_*` variable
//                   from a hardened-runtime process's environment before `main` (measured: `DYLD_<token>=…`, `DYLD_=1`,
//                   `=1`, `=<payload>` all left the core itself). That holds only while the signature has the hardened
//                   runtime and no `allow-dyld-environment-variables`: `sealFile` signs ad hoc that way, every real
//                   signature (the release's, the dev daemon's) does too, and verify:sealed-core asserts both.
//   ELF (Linux)     a NUL, then letters. glibc's and musl's `getenv("")` return NULL, and Bun's own environment map
//                   splits each entry at its first `=`, so its keys never hold a NUL. verify:sealed-core measures it on
//                   the Linux runners with `=…` entries through a raw execve. In Bun's built-in JavaScript a member read
//                   `.NAME` becomes `["\0…"]` and a quoted `"NAME"` becomes `"\0…"`: a key holding U+0000.
//   PE (Windows)    not sealed. Every Windows process carries `=C:=…` entries, so a NUL-led name could read as set on
//                   every start, and no Windows store trusts a binary (Credential Manager, DPAPI: any process of the
//                   user reads them), so there is nothing to protect that a seal could. verify:sealed-core asserts a
//                   Windows binary is NOT sealed, so a half-seal never ships.
//
// The letters derive from the name, so a rebuild is byte-for-byte the same. The app's own bundle — the module graph
// Bun embeds in its `.bun` section (`__BUN,__bun` in a Mach-O) — is never touched: the core's own code names some of
// these variables on purpose (the run home's environment refusals).
//
// `--check` is the byte check: no sealed name is left outside the module graph. `scripts/verify-sealed-core.ts` then
// runs the sealed, signed binary with each door set and asserts that nothing foreign runs and no debugger opens.
//
//   bun scripts/seal-bun-doors.ts <binary> [--target <daemon target>]   seal in place (macOS: re-sign ad hoc)
//   bun scripts/seal-bun-doors.ts <binary> --check                     the byte check only
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The names sealed, longest first so a name inside a longer one (BUN_INSPECT in BUN_INSPECT_CONNECT_TO) is never
 *  half-sealed. BUN_INSPECT_NOTIFY and BUN_INSPECT_PRELOAD only matter with a debugger, and are sealed with it. */
export const SEALED_ENV_NAMES = ["BUN_INTERNAL_WEBVIEW_HOST", "BUN_CONFIG_VERBOSE_FETCH", "BUN_INSPECT_CONNECT_TO", "BUN_INSPECT_PRELOAD", "BUN_INSPECT_NOTIFY", "BUN_INSPECT", "BUN_OPTIONS", "BUN_BE_BUN", "NODE_PATH"] as const;

/** The names Bun must still contain before sealing (so a Bun that renamed one fails the build, not silently). */
export const REQUIRED_NATIVE_NAMES = ["BUN_BE_BUN", "BUN_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "BUN_CONFIG_VERBOSE_FETCH"] as const;

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

/** What an occurrence of `name` becomes in `format`, and where it starts (an ELF member read replaces its dot too). */
export function sealedReplacement(name: string, site: Site, format: ExecutableFormat = "elf"): { bytes: Uint8Array; offset: number } {
  const enc = new TextEncoder();
  if (format === "pe") throw new Error("a Windows binary is not sealed (scripts/seal-bun-doors.ts)");
  if (format === "macho") return { bytes: enc.encode(`DYLD_${sealFiller(name, name.length - 5)}`), offset: 0 };
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

/** Is a binary of this format sealed at all? Windows' is not (the header says why). */
export function sealsFormat(format: ExecutableFormat): boolean {
  return format !== "pe";
}

/** Seals `bytes` in place. Throws on a Windows binary, and when Bun no longer carries a name it must (a new Bun needs
 *  a new audit). */
export function sealBunDoors(bytes: Uint8Array): SealResult {
  const graph = moduleGraphRange(bytes);
  if (!sealsFormat(graph.format)) throw new Error("a Windows binary is not sealed (scripts/seal-bun-doors.ts)");
  const enc = new TextEncoder();
  const sealed: Record<string, number> = {};
  for (const name of SEALED_ENV_NAMES) {
    const at = occurrences(bytes, enc.encode(name), graph);
    for (const i of at) {
      const r = sealedReplacement(name, siteOf(bytes, i, name.length), graph.format);
      bytes.set(r.bytes, i + r.offset);
    }
    sealed[name] = at.length;
  }
  const alreadySealed = REQUIRED_NATIVE_NAMES.every((n) => sealed[n] === 0 && occurrences(bytes, sealedReplacement(n, "native", graph.format).bytes, graph).length > 0);
  if (!alreadySealed) {
    const missing = REQUIRED_NATIVE_NAMES.filter((n) => sealed[n] === 0);
    if (missing.length > 0) throw new Error(`Bun no longer names ${missing.join(", ")} where this step looks: audit the new Bun's doors before shipping it (scripts/seal-bun-doors.ts)`);
  }
  return { format: graph.format, sealed, alreadySealed };
}

/** The byte check: every sealed name is gone from outside the module graph, and each required replacement is there.
 *  A Windows binary must be the opposite: not sealed (its names all there, no replacement). */
export function sealProblems(bytes: Uint8Array): string[] {
  const graph = moduleGraphRange(bytes);
  const enc = new TextEncoder();
  const problems: string[] = [];
  if (!sealsFormat(graph.format)) {
    for (const name of REQUIRED_NATIVE_NAMES) {
      if (occurrences(bytes, enc.encode(name), graph).length === 0) problems.push(`${name} is missing from a Windows binary, which must not be sealed (no half-seal ships)`);
    }
    return problems;
  }
  for (const name of SEALED_ENV_NAMES) {
    const left = occurrences(bytes, enc.encode(name), graph);
    if (left.length > 0) problems.push(`${name} is still in Bun's code at ${left.map((o) => `0x${o.toString(16)}`).join(", ")}`);
  }
  for (const name of REQUIRED_NATIVE_NAMES) {
    if (occurrences(bytes, sealedReplacement(name, "native", graph.format).bytes, graph).length === 0) problems.push(`${name}'s sealed replacement is missing: the binary was not sealed by this step`);
  }
  return problems;
}

/** The entitlement that would let `DYLD_*` through to a hardened process, and so open a macOS seal. */
export const DYLD_ENTITLEMENT = "com.apple.security.cs.allow-dyld-environment-variables";

/** The core's entitlements file, which must never grant `DYLD_ENTITLEMENT`. */
export const CORE_ENTITLEMENTS = join(dirname(import.meta.dir), "scripts", "clover-core.entitlements");

/** The ad hoc signature a sealed Mach-O gets here: the hardened runtime and the core's entitlements, so the seal holds
 *  even before a release or the dev daemon signs it for real (both with the hardened runtime too). */
export function adHocSealSignArgs(path: string): string[] {
  return ["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", CORE_ENTITLEMENTS, path];
}

/** Seals the file at `path` (a Windows binary is left as it is). On macOS a Mach-O is re-signed ad hoc with the
 *  hardened runtime. Returns what was sealed, or undefined for a Windows binary. */
export function sealFile(path: string, platform: NodeJS.Platform = process.platform): SealResult | undefined {
  const bytes = new Uint8Array(readFileSync(path));
  if (!sealsFormat(moduleGraphRange(bytes).format)) {
    const problems = sealProblems(bytes);
    if (problems.length > 0) throw new Error(problems.join("; "));
    return undefined;
  }
  if (readFileSync(CORE_ENTITLEMENTS, "utf8").includes(DYLD_ENTITLEMENT)) throw new Error(`${CORE_ENTITLEMENTS} grants ${DYLD_ENTITLEMENT}, which would open the macOS seal`);
  const result = sealBunDoors(bytes);
  if (!result.alreadySealed) writeFileSync(path, bytes);
  if (result.format === "macho" && platform === "darwin") {
    const args = adHocSealSignArgs(path);
    const r = spawnSync(args[0]!, args.slice(1), { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`codesign (ad hoc, hardened runtime) after sealing failed: ${r.stderr.trim()}`);
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
      if (problems.length === 0) console.log(`seal-bun-doors: ${path}: ${sealsFormat(moduleGraphRange(new Uint8Array(readFileSync(path))).format) ? `sealed (${SEALED_ENV_NAMES.join(", ")})` : "a Windows binary, not sealed, as it must be"}`);
      process.exit(problems.length === 0 ? 0 : 1);
    }
    const r = sealFile(path);
    console.log(`seal-bun-doors: ${path}: ${r === undefined ? "a Windows binary: not sealed" : r.alreadySealed ? "already sealed" : Object.entries(r.sealed).map(([n, c]) => `${n}×${c}`).join(" ")}`);
  } catch (err) {
    console.error(`seal-bun-doors: ${(err as Error).message}`);
    process.exit(1);
  }
}
