// The Windows launcher's pin (lane C, C-M2 part 2; the controller's ruling, agreed with lane M's installer #207).
//
// `srt-win.exe` is pinned by its **PE Authenticode digest**, not its file SHA-256: signing attaches a signature and
// a timestamp that differs on every signing, and both sit outside the digest. The digest is SHA-256 over the file in
// file order, leaving out three things a signature changes:
//   1. the optional header's `CheckSum` (4 bytes);
//   2. the certificate table's entry in the data directory (8 bytes, index 4);
//   3. the attached certificate table itself.
// It is the digest `signtool sign` signs over (for a file whose sections follow its headers in order, as a linker
// writes them), so it is the same before and after signing. The reference definition is lane M's
// `authenticodeDigest` in `scripts/release/srt-win.ts`; this is that function, in core, where the launch checks it.
//
// Lane M's CI builds both architectures from sandbox-runtime `v0.0.81` (commit `c40cf14…`) with a static CRT and
// posts their digests. Until then the pins below are the npm 0.0.81 binaries' digests (the controller's interim
// values): they let the fence be measured, and lane M's build check replaces them when its static-CRT build lands.
// Every launch checks the digest and fails closed with exit 3 on a mismatch; once Windows signing exists, the launch
// also checks that the signature is Clover's (a native check, still to be built).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

/** The architectures lane M builds. */
export type SrtWinArch = "x64" | "arm64";

/**
 * The pinned launcher digests, one per architecture. Shape is load-bearing: lane M's build check parses this exact
 * constant (`parsePins` in `scripts/release/srt-win.ts`), so keep it a frozen object literal with `x64` and `arm64`.
 * x64 is the measured Authenticode digest of the lane-C patched static-CRT build (per-principal records);
 * arm64 is lane M's unpatched static-CRT build and is STALE until lane M's CI rebuilds the patched source —
 * an arm64 launch fails closed (exit 3) until then.
 */
export const SRT_WIN_PINS = Object.freeze({
  x64: "df9ba649b3fe26be5d324a8474db83eb04c5c253c412e63e9533747e682ddc92",
  arm64: "cf562110127e7612084de53782b0307326074d4e1958ca2c5262a974f6bc19c6",
});

/** The running process's launcher architecture. Windows on ARM reports `arm64`; everything else `x64`. */
export function srtWinArch(arch: string = process.arch): SrtWinArch {
  return arch === "arm64" ? "arm64" : "x64";
}

/** Where the launcher lives: beside the running `clover-core` binary (lane M's installer puts it there), or
 *  `CLOVER_SRT_WIN` in dev and tests. */
export function srtWinPath(execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLOVER_SRT_WIN;
  if (override) return override;
  // Always a Windows path, whatever OS renders it (tests on macOS included).
  return win32.join(win32.dirname(execPath), "srt-win.exe");
}

/**
 * A PE file's Authenticode digest, SHA-256, in hex: the whole file but the three things a signature changes, read in
 * file order. Throws on a file that isn't a PE image. (Lane M's `scripts/release/srt-win.ts` has the same function;
 * this copy is what the launch checks, so core never has to trust the release script.)
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
  const count = view.getUint32(optional + (magic === 0x20b ? 0x6c : 0x5c), true);
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

/** Validate the certificate table per Addendum 4: it must start after the headers and after the last section's
 *  raw data, end at EOF, and have 8-byte aligned zero padding before it. Throws if invalid. */
export function validateCertificateTable(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (why: string): never => { throw new Error(`certificate table validation failed: ${why}`); };
  if (bytes.length < 0x40 || view.getUint16(0, true) !== 0x5a4d) fail("no MZ header");
  const pe = view.getUint32(0x3c, true);
  if (pe + 24 > bytes.length || view.getUint32(pe, true) !== 0x00004550) fail("no PE signature");
  const optional = pe + 24;
  const magic = view.getUint16(optional, true);
  if (magic !== 0x10b && magic !== 0x20b) fail(`optional header magic 0x${magic.toString(16)}`);
  const checksum = optional + 64;
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const count = view.getUint32(optional + (magic === 0x20b ? 0x6c : 0x5c), true);
  if (count < 5) return; // no certificate table entry: nothing to validate
  const certEntry = directories + 4 * 8;
  if (certEntry + 8 > bytes.length) fail("truncated data directories");
  const certOffset = view.getUint32(certEntry, true);
  const certSize = view.getUint32(certEntry + 4, true);
  if (certSize === 0) return; // no certificate table: nothing to validate

  // 1. Certificate table must start after the end of the headers.
  // The headers end at `certEntry + 8` (the end of the data directories).
  if (certOffset < certEntry + 8) fail("starts before the end of the headers");

  // 2. Certificate table must start after the end of the last section's raw data.
  // Find the last section's end (PointerToRawData + SizeOfRawData).
  const numSections = view.getUint16(pe + 6, true);
  const sectionTable = pe + 24 + view.getUint16(pe + 20, true); // after optional header
  let lastSectionEnd = 0;
  for (let i = 0; i < numSections; i++) {
    const ptr = sectionTable + i * 40;
    const pointerToRawData = view.getUint32(ptr + 20, true);
    const sizeOfRawData = view.getUint32(ptr + 16, true);
    const sectionEnd = pointerToRawData + sizeOfRawData;
    if (sectionEnd > lastSectionEnd) lastSectionEnd = sectionEnd;
  }
  if (certOffset < lastSectionEnd) fail("starts before the end of the last section's raw data");

  // 3. Certificate table must end exactly at the end of the file.
  if (certOffset + certSize !== bytes.length) fail("doesn't end exactly at the end of the file");

  // 4. Padding before the certificate table must be 8-byte aligned and zero.
  // The padding is the gap between the end of the last section (or headers if no sections)
  // and the certificate table offset. It must be a multiple of 8 and all zeros.
  const paddingStart = Math.max(lastSectionEnd, certEntry + 8);
  const paddingEnd = certOffset;
  if (paddingEnd > paddingStart) {
    if ((paddingEnd - paddingStart) % 8 !== 0) fail("non-8-byte-aligned padding before the certificate table");
    for (let i = paddingStart; i < paddingEnd; i++) {
      if (bytes[i] !== 0) fail("non-zero padding before the certificate table");
    }
  }
}

/** What the launch needs to know about the launcher: present, and the digest of what is there. */
export interface LauncherDigest {
  readonly present: boolean;
  readonly digest: string | null;
}

/** The launcher's Authenticode digest; `{ present: false }` when it is missing or isn't a PE image, or when
 *  the certificate table fails validation (Addendum 4). */
export function launcherDigest(path: string): LauncherDigest {
  try {
    if (!existsSync(path)) return { present: false, digest: null };
    const bytes = readFileSync(path);
    validateCertificateTable(bytes);
    return { present: true, digest: authenticodeDigest(bytes) };
  } catch {
    // A file that isn't a PE image, or whose certificate table is invalid, is not the launcher:
    // fail closed, never "present with no digest".
    return { present: false, digest: null };
  }
}

/** Whether `path` is the launcher pinned for `arch`. `true` only on an exact digest match. */
export function launcherPinned(path: string, arch: SrtWinArch = srtWinArch(), pins: Readonly<Record<SrtWinArch, string>> = SRT_WIN_PINS): boolean {
  const { present, digest } = launcherDigest(path);
  return present && digest !== null && digest === pins[arch];
}

/** Why the launcher can't be used, or null when it is the pinned one. Exit 3 is the launch's fail-closed code. */
export function launcherProblem(path: string, arch: SrtWinArch = srtWinArch(), pins: Readonly<Record<SrtWinArch, string>> = SRT_WIN_PINS): string | null {
  const { present, digest } = launcherDigest(path);
  if (!present) return "the launcher isn't installed";
  const pin = pins[arch];
  if (pin === undefined) return `no launcher is pinned for ${arch}`;
  if (digest !== pin) return `the launcher's digest is ${digest ?? "unreadable"}, not the pinned ${pin} for ${arch}`;
  return null;
}
