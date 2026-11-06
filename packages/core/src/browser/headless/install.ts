// Installing the pinned headless shell where no app runs (spec §12.1, "Where no app runs"; ported from spike S7's
// `src/cft/install.ts` with its "What M2's port needs" list applied). It fails closed:
// * no pin for this platform, no install (and no launch);
// * the download's size and SHA-256 must match the pin before anything is unpacked (and the server's MD5, when it
//   sends one, must match what arrived);
// * the unpacked tree must match the pin's digest of the whole tree (every file's SHA-256 and executable bit, every
//   symlink's target), and a reused install is checked against that same pinned digest again before each launch, so
//   no file of it can be swapped, added or removed between launches. The digest is pinned in `integrity.json` beside the
//   archive's hash, never read back from anything on disk.
// Installs live under the folder the caller gives (the daemon passes `<home>/browser/`), never in `~/.cache` or the
// user's own Chrome: `<dir>/cft/<version>-<platform>/`. An install is unpacked into a staging folder and renamed into
// place, so a half-written one is never used.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import ruled from "../../../../../plugins/clover/plugins/browser/headless-shell.pins.json" with { type: "json" };
import integrity from "./integrity.json" with { type: "json" };
import { entryData, extractAll, listEntries } from "./unzip";

/** One platform's archive, pinned: its size, its SHA-256, and the digest of the tree it unpacks to (`treeDigest`). */
export interface PlatformPin {
  bytes: number;
  sha256: string;
  tree: string;
  /** The archive's URL (the pin file's); otherwise made from `base`. */
  url?: string;
}

/** The pinned build: Chrome for Testing's `chrome-headless-shell`, one archive per platform. */
export interface HeadlessPin {
  version: string;
  why: string;
  base: string;
  artifact: "chrome-headless-shell";
  platforms: Partial<Record<string, PlatformPin>>;
}

/** The production pin, in the controller's shape (`plugins/clover/plugins/browser/headless-shell.pins.json`): lane M's
 *  CI check keeps its milestone on the Chromium of the app's Electron. */
export interface HeadlessShellPins {
  electron: string;
  chromium: string;
  milestone: number;
  assets: { platform: string; url: string; sha256: string }[];
}

/** The pin as the installer uses it: each asset of the pin file, with the bytes and tree digest `integrity.json` holds
 *  for that same archive (matched by SHA-256). An asset without both, or whose URL isn't Chrome for Testing's, isn't
 *  pinned at all, so it is never installed (fail closed). Pure. */
export function pinFrom(file: HeadlessShellPins, extra: { why: string; platforms: Partial<Record<string, { sha256: string; bytes: number; tree: string }>> }): HeadlessPin {
  const platforms: Partial<Record<string, PlatformPin>> = {};
  for (const a of file.assets) {
    const more = extra.platforms[a.platform];
    if (more === undefined || more.sha256 !== a.sha256 || !/^[0-9a-f]{64}$/.test(a.sha256)) continue;
    if (!a.url.startsWith(`${CFT_BASE}/${file.chromium}/${a.platform}/`)) continue;
    platforms[a.platform] = { bytes: more.bytes, sha256: a.sha256, tree: more.tree, url: a.url };
  }
  return { version: file.chromium, why: extra.why, base: CFT_BASE, artifact: "chrome-headless-shell", platforms };
}

export const CFT_BASE = "https://storage.googleapis.com/chrome-for-testing-public";

export const HEADLESS_PIN: HeadlessPin = pinFrom(ruled as HeadlessShellPins, integrity);

export type InstallErrorCode = "no_pin" | "download" | "size" | "sha256" | "md5" | "tree" | "unpack";

export class InstallError extends Error {
  constructor(readonly code: InstallErrorCode, message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/** Chrome for Testing's name for a platform, or undefined where it publishes no headless shell we pin. Pure. */
export function cftPlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : undefined;
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : arch === "x64" ? "linux64" : undefined;
  if (platform === "win32") return arch === "x64" ? "win64" : arch === "ia32" ? "win32" : undefined;
  return undefined;
}

/** The browser's executable inside an install. Pure. */
export function binaryIn(installDir: string, plat: string): string {
  return join(installDir, `chrome-headless-shell-${plat}`, `chrome-headless-shell${plat.startsWith("win") ? ".exe" : ""}`);
}

export function archiveUrl(pin: HeadlessPin, plat: string): string {
  return pin.platforms[plat]?.url ?? `${pin.base}/${pin.version}/${plat}/${pin.artifact}-${plat}.zip`;
}

export function installDirFor(dir: string, pin: HeadlessPin, plat: string): string {
  return join(dir, "cft", `${pin.version}-${plat}`);
}

/** The MD5 in a GCS `x-goog-hash` header ("crc32c=…, md5=…"), as hex. Pure. */
export function googMd5Hex(header: string | null): string | undefined {
  if (header === null) return undefined;
  const m = /md5=([A-Za-z0-9+/=]+)/.exec(header);
  return m === null ? undefined : Buffer.from(m[1]!, "base64").toString("hex");
}

/** One line of a tree's digest: a file (`F path sha256 x|-`) or a symlink (`L path target`). Windows archives carry no
 *  modes, so their files are all `-`; elsewhere `x` is the owner's executable bit. Directories don't count. */
type TreeLine = string;

function digestOf(lines: TreeLine[]): string {
  return createHash("sha256").update([...lines].sort().join("\n")).digest("hex");
}

/** The digest of the tree an archive unpacks to, from the archive alone (pin time and install time). */
export function treeDigestOfArchive(zip: Uint8Array, plat: string): string {
  const lines: TreeLine[] = [];
  for (const entry of listEntries(zip)) {
    if (entry.isDir) continue;
    const name = entry.name.replace(/\\/g, "/");
    const data = entryData(zip, entry, (d) => Bun.hash.crc32(d));
    if (entry.isSymlink) {
      lines.push(`L ${name} ${new TextDecoder().decode(data)}`);
      continue;
    }
    const exec = !plat.startsWith("win") && entry.mode !== undefined && (entry.mode & 0o100) !== 0;
    lines.push(`F ${name} ${createHash("sha256").update(data).digest("hex")} ${exec ? "x" : "-"}`);
  }
  return digestOf(lines);
}

async function fileSha256(path: string): Promise<string> {
  // Streamed, so a 200 MB binary never blocks the daemon's event loop for its whole hash.
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

/** The digest of an unpacked tree on disk, as `treeDigestOfArchive` spells it. */
export async function treeDigestOfDir(root: string, plat: string): Promise<string> {
  const lines: TreeLine[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const p = join(root, r);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) lines.push(`L ${r} ${readlinkSync(p)}`);
      else if (st.isDirectory()) await walk(r);
      else if (st.isFile()) lines.push(`F ${r} ${await fileSha256(p)} ${!plat.startsWith("win") && (st.mode & 0o100) !== 0 ? "x" : "-"}`);
      else lines.push(`? ${r}`); // a fifo, a socket, a device: never part of an install
    }
  };
  await walk("");
  return digestOf(lines);
}

export interface InstallOptions {
  /** The folder installs live under (the daemon's `<home>/browser/`). */
  dir: string;
  pin?: HeadlessPin;
  /** Chrome for Testing's platform name (default: this machine's). */
  platform?: string;
  fetch?: (url: string) => Promise<Response>;
  log?: (line: string) => void;
}

export interface Installed {
  version: string;
  platform: string;
  /** The install's folder. */
  dir: string;
  /** The browser's executable. */
  bin: string;
  /** It was there already, and matched the pin. */
  reused: boolean;
}

/** Installs the pinned headless shell (or checks the one there against its pin again), failing closed. */
export async function installHeadlessShell(opts: InstallOptions): Promise<Installed> {
  const pin = opts.pin ?? HEADLESS_PIN;
  const log = opts.log ?? (() => undefined);
  const plat = opts.platform ?? cftPlatform();
  const p = plat === undefined ? undefined : pin.platforms[plat];
  if (plat === undefined || p === undefined || !/^[0-9a-f]{64}$/.test(p.sha256) || !/^[0-9a-f]{64}$/.test(p.tree) || !(p.bytes > 0)) {
    throw new InstallError("no_pin", `there's no pinned headless browser for ${plat ?? `${process.platform}-${process.arch}`}, so none is installed (pins: ${Object.keys(pin.platforms).join(", ")})`);
  }
  const dir = installDirFor(opts.dir, pin, plat);
  const bin = binaryIn(dir, plat);
  if (existsSync(dir)) {
    // Checked again on every use: the whole tree against the pinned digest.
    if (existsSync(bin) && (await treeDigestOfDir(dir, plat)) === p.tree) return { version: pin.version, platform: plat, dir, bin, reused: true };
    log(`the headless browser at ${dir} isn't the pinned one (a file changed, was added or went): installing it again`);
    rmSync(dir, { recursive: true, force: true });
  }
  const root = join(opts.dir, "cft");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const url = archiveUrl(pin, plat);
  log(`downloading ${url}`);
  const zip = await download(url, p, opts.fetch ?? ((u) => fetch(u)));
  // The archive matched its pin; its tree must too (an unpack bug never hands over a different browser).
  const staging = join(root, `.staging-${plat}-${process.pid}-${Date.now()}`);
  try {
    if (treeDigestOfArchive(zip, plat) !== p.tree) throw new InstallError("tree", "the archive matched its SHA-256 but not its tree's pinned digest");
    extractAll(zip, staging, (d) => Bun.hash.crc32(d));
    if ((await treeDigestOfDir(staging, plat)) !== p.tree) throw new InstallError("tree", "the unpacked browser doesn't match the pinned tree");
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    if (e instanceof InstallError) throw e;
    throw new InstallError("unpack", `unpacking the headless browser failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!existsSync(bin)) throw new InstallError("unpack", `no browser at ${bin} after unpacking`);
  log(`installed the headless browser ${pin.version} for ${plat} at ${dir}`);
  return { version: pin.version, platform: plat, dir, bin, reused: false };
}

/** The archive, in memory, once its size, SHA-256 and (when the server gives one) MD5 match. Nothing is written to disk
 *  before that. */
async function download(url: string, p: PlatformPin, fetchFn: (url: string) => Promise<Response>): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    throw new InstallError("download", `downloading ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok || res.body === null) throw new InstallError("download", `downloading ${url} failed: HTTP ${res.status}`);
  const announced = res.headers.get("content-length");
  if (announced !== null && Number(announced) !== p.bytes) {
    await res.body.cancel().catch(() => undefined);
    throw new InstallError("size", `the download is ${announced} bytes, not the pinned ${p.bytes}`);
  }
  const sha = new Bun.CryptoHasher("sha256");
  const md5 = new Bun.CryptoHasher("md5");
  const out = new Uint8Array(p.bytes);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (got + value.length > p.bytes) {
      await reader.cancel().catch(() => undefined);
      throw new InstallError("size", `the download is longer than the pinned ${p.bytes} bytes`);
    }
    out.set(value, got);
    got += value.length;
    sha.update(value);
    md5.update(value);
  }
  if (got !== p.bytes) throw new InstallError("size", `the download is ${got} bytes, not the pinned ${p.bytes}`);
  const sha256 = sha.digest("hex");
  if (sha256 !== p.sha256) throw new InstallError("sha256", `the download's SHA-256 ${sha256} isn't the pinned ${p.sha256}`);
  const serverMd5 = googMd5Hex(res.headers.get("x-goog-hash"));
  if (serverMd5 !== undefined && serverMd5 !== md5.digest("hex")) throw new InstallError("md5", "the server's MD5 doesn't match what arrived");
  return out;
}
