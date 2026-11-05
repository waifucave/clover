// Installing a pinned Chrome for Testing where no app runs: the version and each archive's SHA-256 are pinned in
// pins.json (the archive host publishes no checksums of its own beyond transport MD5s, so the pin is ours, taken once
// and committed). Downloaded with fetch, hashed while it streams, checked against the pin and the server's MD5,
// unpacked by our own zip reader into <home>/browsers/cft/<version>/<artifact>-<platform>, then renamed into place,
// so a half-done install is never used. Bun only.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pins from "./pins.json" with { type: "json" };
import { extractAll } from "./unzip.ts";

export type Artifact = "chrome-headless-shell" | "chrome";

export interface Pin { bytes: number; sha256: string }

/** Chrome for Testing's platform name for this machine. */
export function cftPlatform(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux64";
  if (platform === "win32") return arch === "ia32" ? "win32" : "win64";
  throw new Error(`no Chrome for Testing for ${platform}-${arch}`);
}

/** The browser's executable inside the unpacked archive. Pure. */
export function binaryIn(artifact: Artifact, plat: string): string {
  const exe = plat.startsWith("win") ? ".exe" : "";
  if (artifact === "chrome-headless-shell") return join(`chrome-headless-shell-${plat}`, `chrome-headless-shell${exe}`);
  if (plat.startsWith("mac")) return join(`chrome-${plat}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  return join(`chrome-${plat}`, `chrome${exe}`);
}

export function archiveUrl(artifact: Artifact, plat: string, version: string = pins.version): string {
  return `${pins.base}/${version}/${plat}/${artifact}-${plat}.zip`;
}

export function pinFor(artifact: Artifact, plat: string): Pin | undefined {
  return (pins.artifacts as Record<string, Record<string, Pin>>)[artifact]?.[plat];
}

/** The MD5 in a GCS `x-goog-hash` header ("crc32c=…, md5=…"), as hex. Pure. */
export function googMd5Hex(header: string | null): string | undefined {
  if (header === null) return undefined;
  const m = /md5=([A-Za-z0-9+/=]+)/.exec(header);
  return m === null ? undefined : Buffer.from(m[1]!, "base64").toString("hex");
}

export interface InstallResult {
  artifact: Artifact;
  platform: string;
  version: string;
  dir: string;
  bin: string;
  reused: boolean;
  zipBytes: number;
  unpackedBytes: number;
  files: number;
  symlinks: number;
  downloadMs: number;
  extractMs: number;
  sha256: string;
  /** The pin had a SHA-256 and the archive matched it. */
  verified: boolean;
  /** The pin had no SHA-256 yet: this run's hash is the one to commit. */
  trustOnFirstUse: boolean;
  serverMd5Matched?: boolean;
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p); else total += st.size;
    }
  };
  walk(dir);
  return total;
}

export async function install(home: string, artifact: Artifact, log: (s: string) => void = () => undefined): Promise<InstallResult> {
  const plat = cftPlatform();
  const version = pins.version;
  const root = join(home, "browsers", "cft", version);
  const dir = join(root, `${artifact}-${plat}`);
  const bin = join(dir, binaryIn(artifact, plat));
  const pin = pinFor(artifact, plat);
  const marker = join(dir, ".clover-installed.json");
  if (existsSync(marker) && existsSync(bin)) {
    const done = JSON.parse(readFileSync(marker, "utf8")) as InstallResult;
    return { ...done, reused: true };
  }
  mkdirSync(root, { recursive: true });
  const url = archiveUrl(artifact, plat, version);
  const tmpZip = join(root, `.download-${artifact}-${process.pid}.zip`);
  const t0 = Date.now();
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`download ${url}: HTTP ${res.status}`);
  const expected = Number(res.headers.get("content-length") ?? pin?.bytes ?? 0);
  const sha = new Bun.CryptoHasher("sha256");
  const md5 = new Bun.CryptoHasher("md5");
  const writer = Bun.file(tmpZip).writer();
  let got = 0, nextLog = 0.1;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    sha.update(value);
    md5.update(value);
    writer.write(value);
    got += value.length;
    if (expected > 0 && got / expected >= nextLog) { log(`  ${Math.round((got / expected) * 100)}%`); nextLog += 0.1; }
  }
  await writer.end();
  const downloadMs = Date.now() - t0;
  const sha256 = sha.digest("hex");
  const serverMd5 = googMd5Hex(res.headers.get("x-goog-hash"));
  const serverMd5Matched = serverMd5 === undefined ? undefined : serverMd5 === md5.digest("hex");
  if (pin !== undefined && pin.bytes > 0 && got !== pin.bytes) { rmSync(tmpZip, { force: true }); throw new Error(`size ${got} is not the pinned ${pin.bytes}`); }
  if (serverMd5Matched === false) { rmSync(tmpZip, { force: true }); throw new Error("the server's MD5 does not match what arrived"); }
  const pinnedSha = pin?.sha256 ?? "";
  if (pinnedSha !== "" && pinnedSha !== sha256) { rmSync(tmpZip, { force: true }); throw new Error(`SHA-256 ${sha256} is not the pinned ${pinnedSha}`); }
  if (pinnedSha === "") log(`PIN ${artifact} ${plat} sha256 ${sha256} (no pin yet: trust on first use)`);
  const t1 = Date.now();
  const staging = join(root, `.staging-${artifact}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  const zip = new Uint8Array(await Bun.file(tmpZip).arrayBuffer());
  const stats = extractAll(zip, staging, (d) => Bun.hash.crc32(d));
  rmSync(tmpZip, { force: true });
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  const extractMs = Date.now() - t1;
  const result: InstallResult = {
    artifact, platform: plat, version, dir, bin, reused: false, zipBytes: got, unpackedBytes: dirSize(dir), files: stats.files,
    symlinks: stats.symlinks, downloadMs, extractMs, sha256, verified: pinnedSha !== "" && pinnedSha === sha256,
    trustOnFirstUse: pinnedSha === "", serverMd5Matched,
  };
  writeFileSync(marker, JSON.stringify(result, null, 2));
  if (!existsSync(bin)) throw new Error(`no browser at ${bin} after unpacking`);
  return result;
}
