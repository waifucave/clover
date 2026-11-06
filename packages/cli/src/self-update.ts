// A server's daemon updating itself (spec §3.1, plan §4 M-M2). Only a server install does (`<home>/install.json` says
// `server`, written by `clover-core server install`, whose binary lives at `<home>/bin/clover-core`); the app updates
// itself and the daemon inside it, and a deb or rpm updates through apt or dnf.
//
// Every few hours the daemon reads its update file from this repository's newest release its channel allows
// (`<channel>-core-<target>.yml`, packages/update-feed), and takes a newer version in this order, stopping at the first
// thing that fails:
//   1. the update file's signature (`.sig`, the key the binary carries), before a byte of it is read
//   2. the binary's own signature, then its SHA-512 and size against the update file
//   3. only then the new binary runs, once: `--version`, with nothing in its environment but PATH, for at most 10 s,
//      and it must name the version the update file promised
// The checked binary waits beside the old one (`clover-core.new`) until the daemon is idle (the update gate,
// src/update/gate.ts in core); then the steps before a restart run (the lease renews), the daemon drains, the old binary
// is renamed `clover-core.old`, the new one takes its name, and the daemon exits with UPDATE_RESTART_EXIT_CODE, which
// `clover-core supervise` answers by starting it at once.
//
// The boot after a swap is watched (`beginUpdatedBoot`, the first thing `daemon run` does): each start of the new
// version counts, a start that ran GOOD_BOOT_MS (or stopped cleanly) clears the count and removes the old binary, and
// the third start (two crashes) puts the old binary back and restarts into it; that version is then never taken
// again. On Windows a running binary can't be deleted, so a `.old` that is still in use stays until a later good boot.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  coreBinaryFile, coreFeedFile, parseCoreFeed, SIGNATURE_SUFFIX, verifyFeed, type CoreFeed, type CoreTarget, type FeedChannel,
} from "@waifucave/clover-update-feed";

export const UPDATE_REPO = "waifucave/clover";
export const SELF_UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
/** How long the new binary's `--version` may take. */
export const VERSION_CHECK_MS = 10_000;
/** A start of a new version that ran this long is good. */
export const GOOD_BOOT_MS = 30_000;
/** The third start of a new version (two crashes) rolls it back. */
export const ROLLBACK_AT_BOOT = 3;

/** The release target this process is, or undefined (no self-update elsewhere). */
export function coreTargetOf(platform: string, arch: string): CoreTarget | undefined {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && arch === "x64") return "windows-x64";
  return undefined;
}

/** Whether `a` is a newer semver than `b` (a prerelease is older than its release). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(v);
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : undefined;
  };
  const x = parse(a), y = parse(b);
  if (x === undefined || y === undefined) return false;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! > y.n[i]!;
  if (x.pre === y.pre) return false;
  if (x.pre === undefined) return true;
  if (y.pre === undefined) return false;
  const xs = x.pre.split("."), ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i], q = ys[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q);
    if (pn !== qn) return !pn;
    return p > q;
  }
  return false;
}

// ---- the boot after a swap ----

/** `<home>/update/`: the boot count after a swap, and the versions rolled back. */
export function updateDir(home: string): string {
  return join(home, "update");
}

interface BootRecord {
  version: string;
  boots: number;
}

function readJson<T>(path: string): T | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

const bootFile = (home: string) => join(updateDir(home), "boot.json");
const rolledBackFile = (home: string) => join(updateDir(home), "rolled-back.json");

/** The versions this server rolled back, never taken again. */
export function rolledBack(home: string): string[] {
  const v = readJson<unknown>(rolledBackFile(home));
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export type BootVerdict = "normal" | "watching" | "rolled-back";

/**
 * LANE C: the boot-count hook, the first thing `daemon run` does (packages/cli/src/main.ts). After a swap, counts this
 * start of the new version; at the third (two crashes) puts `<bin>.old` back in place of `bin` and says `rolled-back`,
 * and the caller exits with UPDATE_RESTART_EXIT_CODE so `supervise` starts the old version at once. Never throws.
 */
export function beginUpdatedBoot(home: string, bin: string, log: (line: string) => void = () => {}): BootVerdict {
  try {
    const record = readJson<BootRecord>(bootFile(home));
    if (record === undefined || typeof record.version !== "string" || typeof record.boots !== "number") return "normal";
    const boots = record.boots + 1;
    if (boots < ROLLBACK_AT_BOOT) {
      writeJson(bootFile(home), { version: record.version, boots });
      log(`update: start ${boots} of ${record.version}`);
      return "watching";
    }
    const old = `${bin}.old`;
    if (!existsSync(old)) {
      log(`update: ${record.version} crashed ${boots - 1} times and there is no old binary to go back to`);
      rmSync(bootFile(home), { force: true });
      return "normal";
    }
    rmSync(`${bin}.bad`, { force: true });
    renameSync(bin, `${bin}.bad`);
    renameSync(old, bin);
    writeJson(rolledBackFile(home), [...new Set([...rolledBack(home), record.version])]);
    rmSync(bootFile(home), { force: true });
    log(`update: ${record.version} crashed ${boots - 1} times; the previous version is back`);
    return "rolled-back";
  } catch (err) {
    log(`update: the boot check failed: ${err instanceof Error ? err.message : String(err)}`);
    return "normal";
  }
}

/** LANE C: a start that ran GOOD_BOOT_MS, or stopped cleanly: the new version stays, and the old binary goes (on
 *  Windows, once nothing runs from it any more). Never throws. */
export function bootWasGood(home: string, bin: string): void {
  try {
    if (!existsSync(bootFile(home))) {
      // A `.old` a running supervisor still held at an earlier good boot (Windows) goes now, if it can.
      rmSync(`${bin}.old`, { force: true });
      return;
    }
    rmSync(bootFile(home), { force: true });
    rmSync(`${bin}.old`, { force: true });
    rmSync(`${bin}.bad`, { force: true });
  } catch {
    // Windows: still in use. A later good boot tries again.
  }
}

// ---- the check and the swap ----

/** One HTTP GET's body, or undefined on anything but a 200. */
export type Fetcher = (url: string, accept?: string) => Promise<Uint8Array | undefined>;

export const httpFetch: Fetcher = async (url, accept) => {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "clover-core", ...(accept ? { Accept: accept } : {}) }, redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined;
  } catch {
    return undefined;
  }
};

/** Runs `path --version` with nothing in its environment but PATH, for at most VERSION_CHECK_MS: its output, or
 *  undefined when it failed or ran too long. */
export async function runVersion(path: string, timeoutMs = VERSION_CHECK_MS): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([path, "--version"], { env: { PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The answer by the deadline, or none: a child it left holding the pipe doesn't hold the check.
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => { proc.kill(); resolve(undefined); }, timeoutMs); });
    const answer = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) => (code === 0 && proc.signalCode === null ? out.trim() : undefined));
    const said = await Promise.race([answer, late]);
    clearTimeout(timer);
    return said;
  } catch {
    return undefined;
  }
}

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

export interface SelfUpdaterDeps {
  home: string;
  /** The installed binary (`<home>/bin/clover-core`), the one replaced. */
  bin: string;
  version: string;
  target: CoreTarget;
  channel: FeedChannel;
  /** The key the binary carries, but in tests. */
  publicKey?: string | null;
  repo?: string;
  fetch?: Fetcher;
  runVersion?: (path: string) => Promise<string | undefined>;
  gate: { whenIdle(everyMs?: number, signal?: AbortSignal): Promise<void>; prepareRestart(timeoutMs?: number, log?: (line: string) => void): Promise<void> };
  /** Stops the daemon (`RunningDaemon.stop`), before the binaries change places. */
  drain(): Promise<void>;
  /** The process exits (with UPDATE_RESTART_EXIT_CODE after a swap). */
  exit(code: number): void;
  restartCode: number;
  log(line: string): void;
  idlePollMs?: number;
}

export type CheckResult =
  | { kind: "up to date" }
  | { kind: "ready"; version: string }
  | { kind: "refused"; why: string };

/** A server's daemon's own update (core's `SelfUpdate`, served by `update.status` and `update.apply`). */
export class SelfUpdater {
  #found: CoreFeed | undefined;
  #ready = false;
  #applying: Promise<void> | undefined;
  readonly #stop = new AbortController();

  constructor(private readonly d: SelfUpdaterDeps) {}

  available(): string | undefined {
    return this.#found?.version;
  }

  ready(): boolean {
    return this.#ready;
  }

  /** Install the checked update at the next idle moment (now, when idle). */
  apply(): void {
    if (!this.#ready || this.#applying !== undefined) return;
    this.#applying = this.d.gate.whenIdle(this.d.idlePollMs ?? 60_000, this.#stop.signal)
      .then(() => this.swap())
      .catch((err: unknown) => {
        this.#applying = undefined;
        if (!this.#stop.signal.aborted) this.d.log(`update: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** Checks now, then every `everyMs`; a checked update installs at the next idle moment. Returns a stop. */
  start(everyMs = SELF_UPDATE_CHECK_MS): () => void {
    const run = (): void => {
      if (this.#ready) return;
      void this.check().then((r) => {
        if (r.kind === "ready") this.apply();
        else if (r.kind === "refused") this.d.log(`update: refused: ${r.why}`);
      });
    };
    run();
    const t = setInterval(run, everyMs);
    t.unref?.();
    return () => {
      clearInterval(t);
      this.#stop.abort();
    };
  }

  #get(url: string, accept?: string): Promise<Uint8Array | undefined> {
    return (this.d.fetch ?? httpFetch)(url, accept);
  }

  #verify(name: string, bytes: Uint8Array, signature: Uint8Array | undefined) {
    const sig = signature === undefined ? undefined : new TextDecoder().decode(signature);
    return this.d.publicKey === undefined ? verifyFeed(name, bytes, sig) : verifyFeed(name, bytes, sig, this.d.publicKey);
  }

  /** The newest release this channel allows that carries this target's update file. */
  async #release(feedName: string): Promise<Release | undefined> {
    const body = await this.#get(`https://api.github.com/repos/${this.d.repo ?? UPDATE_REPO}/releases?per_page=30`, "application/vnd.github+json");
    if (body === undefined) return undefined;
    let releases: unknown;
    try {
      releases = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return undefined;
    }
    if (!Array.isArray(releases)) return undefined;
    return (releases as Release[]).find((r) => r && !r.draft && (this.d.channel === "beta" || !r.prerelease) && Array.isArray(r.assets) && r.assets.some((a) => a?.name === feedName));
  }

  /** Finds, downloads and checks a newer version, leaving it beside the binary as `<bin>.new`. */
  async check(): Promise<CheckResult> {
    const feedName = coreFeedFile(this.d.channel, this.d.target);
    const release = await this.#release(feedName);
    if (release === undefined) return { kind: "up to date" };
    const asset = (name: string) => release.assets.find((a) => a.name === name)?.browser_download_url;
    const feedBytes = await this.#get(asset(feedName)!);
    if (feedBytes === undefined) return { kind: "refused", why: `${feedName} could not be read` };
    // 1. The update file's signature, before a byte of it is read.
    const sigUrl = asset(`${feedName}${SIGNATURE_SUFFIX}`);
    const feedVerdict = this.#verify(feedName, feedBytes, sigUrl === undefined ? undefined : await this.#get(sigUrl));
    if (!feedVerdict.ok) return { kind: "refused", why: `${feedName}: ${feedVerdict.reason}` };
    let feed: CoreFeed;
    try {
      feed = parseCoreFeed(new TextDecoder().decode(feedBytes));
    } catch (err) {
      return { kind: "refused", why: `${feedName}: ${(err as Error).message}` };
    }
    if (!isNewer(feed.version, this.d.version)) return { kind: "up to date" };
    if (rolledBack(this.d.home).includes(feed.version)) return { kind: "refused", why: `${feed.version} was rolled back here` };
    if (feed.file !== coreBinaryFile(feed.version, this.d.target)) return { kind: "refused", why: `${feedName} names ${feed.file}, not this target's binary` };
    this.#found = feed;
    const binUrl = asset(feed.file);
    const binBytes = binUrl === undefined ? undefined : await this.#get(binUrl);
    if (binBytes === undefined) return { kind: "refused", why: `${feed.file} could not be read` };
    // 2. The binary's signature, then its SHA-512 and size against the update file.
    const binSigUrl = asset(`${feed.file}${SIGNATURE_SUFFIX}`);
    const binVerdict = this.#verify(feed.file, binBytes, binSigUrl === undefined ? undefined : await this.#get(binSigUrl));
    if (!binVerdict.ok) return { kind: "refused", why: `${feed.file}: ${binVerdict.reason}` };
    if (createHash("sha512").update(binBytes).digest("base64") !== feed.sha512 || binBytes.length !== feed.size) {
      return { kind: "refused", why: `${feed.file}'s sha512 or size doesn't match ${feedName}` };
    }
    // 3. Only now does it run: `--version`, PATH alone, 10 s.
    const staged = `${this.d.bin}.new`;
    rmSync(staged, { force: true });
    writeFileSync(staged, binBytes, { mode: 0o755 });
    chmodSync(staged, 0o755);
    const said = await (this.d.runVersion ?? runVersion)(staged);
    if (said !== `clover ${feed.version}`) {
      rmSync(staged, { force: true });
      return { kind: "refused", why: `${feed.file}'s --version said ${said === undefined ? "nothing (it failed or ran over 10 s)" : JSON.stringify(said.slice(0, 80))}, not clover ${feed.version}` };
    }
    this.#ready = true;
    this.d.log(`update: ${feed.version} is checked and waits for an idle moment`);
    return { kind: "ready", version: feed.version };
  }

  /** The swap: the steps before a restart, drain, the old binary to `.old`, the new one in, and the restart exit. */
  async swap(): Promise<void> {
    const feed = this.#found;
    const bin = this.d.bin, staged = `${bin}.new`, old = `${bin}.old`;
    if (!this.#ready || feed === undefined || !existsSync(staged)) throw new Error("no checked update to install");
    // A `.old` a running supervisor still holds (Windows) would block the rename: refused before anything stops.
    try {
      rmSync(old, { force: true });
    } catch {
      throw new Error(`${old} is still in use; the update waits for the next restart`);
    }
    this.d.log(`update: installing ${feed.version} (from ${this.d.version})`);
    await this.d.gate.prepareRestart(5_000, this.d.log);
    await this.d.drain();
    try {
      renameSync(bin, old);
      try {
        renameSync(staged, bin);
      } catch (err) {
        renameSync(old, bin);
        throw err;
      }
      writeJson(bootFile(this.d.home), { version: feed.version, boots: 0 });
    } catch (err) {
      this.d.log(`update: the swap failed, the old version stays: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Drained either way: the supervisor starts whichever binary is in place now.
    this.d.exit(this.d.restartCode);
  }
}
