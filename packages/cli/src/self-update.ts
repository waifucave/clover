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
// src/update/gate.ts in core). Then the gate closes (no new turn starts), the steps before a restart run (the lease
// renews), idle is checked again, `.new` is checked again (its SHA-512 and size, just before it is used), the old
// binary is renamed `clover-core.old` and the new one takes its name, and only then the daemon drains and exits with
// UPDATE_RESTART_EXIT_CODE, which `clover-core supervise` answers by starting it at once. A swap that fails before the
// drain leaves the daemon running on the old binary, the gate open, and that version waiting out a back-off.
//
// Downloads are bounded: an update file or a signature at most 64 KiB, the binary at most its signed size. All of these
// files live in the home's fenced set (core's `selfGrantDenyWrite`): no session can plant a binary, a rollback or the
// marker.
//
// The boot after a swap is watched (`beginUpdatedBoot`, the first thing `daemon run` does): each start of the new
// version counts, a start that ran GOOD_BOOT_MS (or stopped cleanly) clears the count and removes the old binary, and
// the third start (two crashes) puts the old binary back and restarts into it; that version is then never taken
// again. On Windows a running binary can't be deleted, so a `.old` that is still in use stays until a later good boot.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
/** The most an update file or a `.sig` may be. */
export const MAX_FEED_BYTES = 64 * 1024;
/** After a failed swap, how long that version waits before it is tried again (doubling, to a day). */
export const SWAP_BACKOFF_MS = 60 * 60 * 1000;

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
  rmSync(bootFile(home), { force: true });
  // The old binary, a rolled-back one, and any old one a running supervisor held at a swap and so was moved aside
  // (Windows: `retireOld`); each that is still in use stays for a later good boot.
  for (const f of retiredBinaries(bin)) {
    try {
      rmSync(f, { force: true });
    } catch {
      // still in use (Windows)
    }
  }
}

/** `.old`, `.bad` and the `.old-<time>` copies moved aside, beside `bin`. */
function retiredBinaries(bin: string): string[] {
  const dir = dirname(bin), base = basename(bin);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n === `${base}.old` || n === `${base}.bad` || n.startsWith(`${base}.old-`)).map((n) => join(dir, n));
}

/** Clears the way for `.old`: removed, or (Windows, where a running supervisor holds it) moved aside to be removed at
 *  a later good boot. False when neither works. */
function retireOld(bin: string): boolean {
  const old = `${bin}.old`;
  try {
    rmSync(old, { force: true });
    return true;
  } catch {
    try {
      renameSync(old, `${old}-${Date.now()}`);
      return true;
    } catch {
      return false;
    }
  }
}

// ---- the check and the swap ----

/** One HTTP GET's body, or undefined on anything but a 200, or a body over `maxBytes`. */
export type Fetcher = (url: string, opts: { accept?: string; maxBytes: number }) => Promise<Uint8Array | undefined>;

/** A body read up to `maxBytes`: undefined (the read stopped) once it is longer. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | undefined> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const httpFetch: Fetcher = async (url, opts) => {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "clover-core", ...(opts.accept ? { Accept: opts.accept } : {}) }, redirect: "follow", signal: AbortSignal.timeout(5 * 60_000) });
    if (!r.ok) return undefined;
    const declared = Number(r.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await r.body?.cancel().catch(() => {});
      return undefined;
    }
    return await readCapped(r.body, opts.maxBytes);
  } catch {
    return undefined;
  }
};

/** The new binary's environment for `--version`: PATH alone, and on Windows the two variables a process can't start
 *  without (Winsock and CNG read `SystemRoot`), which CI's installers job runs the built daemon under. */
export function versionEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? env.Path ?? "" };
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.SYSTEMROOT;
    const windir = env.windir ?? env.WINDIR;
    if (root !== undefined) out.SystemRoot = root;
    if (windir !== undefined) out.windir = windir;
  }
  return out;
}

/** Runs `path --version` with `versionEnv`'s environment, for at most VERSION_CHECK_MS: its output, or undefined when
 *  it failed or ran too long. */
export async function runVersion(path: string, timeoutMs = VERSION_CHECK_MS): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([path, "--version"], { env: versionEnv(process.env, process.platform), stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
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
  gate: {
    whenIdle(everyMs?: number, signal?: AbortSignal): Promise<void>;
    closeForRestart(opts?: { reopenAfterMs?: number; timeoutMs?: number; log?: (line: string) => void }): Promise<boolean>;
    reopen(): void;
    commit(): void;
  };
  /** Stops the daemon (`RunningDaemon.stop`), before the binaries change places. */
  drain(): Promise<void>;
  /** The process exits (with UPDATE_RESTART_EXIT_CODE after a swap). */
  exit(code: number): void;
  restartCode: number;
  log(line: string): void;
  idlePollMs?: number;
  /** How long a close the swap doesn't follow stays closed (the gate's own default is a minute). */
  reopenAfterMs?: number;
  now?(): number;
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
  /** Versions whose swap failed: not tried again before `until`. */
  readonly #failed = new Map<string, { until: number; wait: number }>();

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
    const attempt = async (): Promise<void> => {
      // Idle, then closed for the restart and idle still; work that started meanwhile sends it back to waiting.
      for (;;) {
        await this.d.gate.whenIdle(this.d.idlePollMs ?? 60_000, this.#stop.signal);
        if (await this.d.gate.closeForRestart({ timeoutMs: 5_000, log: this.d.log, ...(this.d.reopenAfterMs !== undefined ? { reopenAfterMs: this.d.reopenAfterMs } : {}) })) break;
      }
      await this.swap();
    };
    this.#applying = attempt()
      .catch((err: unknown) => {
        if (!this.#stop.signal.aborted) this.d.log(`update: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => { this.#applying = undefined; });
  }

  /** Checks now, then every `everyMs`; a checked update installs at the next idle moment. Returns a stop. */
  start(everyMs = SELF_UPDATE_CHECK_MS): () => void {
    const run = (): void => {
      if (this.#ready) return;
      void this.check().then((r) => {
        if (r.kind === "ready") this.apply();
        else if (r.kind === "refused") this.d.log(`update: refused: ${r.why}`);
      }, (err: unknown) => this.d.log(`update: the check failed: ${err instanceof Error ? err.message : String(err)}`));
    };
    run();
    const t = setInterval(run, everyMs);
    t.unref?.();
    return () => {
      clearInterval(t);
      this.#stop.abort();
    };
  }

  #get(url: string, maxBytes: number, accept?: string): Promise<Uint8Array | undefined> {
    return (this.d.fetch ?? httpFetch)(url, { maxBytes, ...(accept ? { accept } : {}) });
  }

  #verify(name: string, bytes: Uint8Array, signature: Uint8Array | undefined) {
    const sig = signature === undefined ? undefined : new TextDecoder().decode(signature);
    return this.d.publicKey === undefined ? verifyFeed(name, bytes, sig) : verifyFeed(name, bytes, sig, this.d.publicKey);
  }

  /** The newest release this channel allows that carries this target's update file. */
  async #release(feedName: string): Promise<Release | undefined> {
    const body = await this.#get(`https://api.github.com/repos/${this.d.repo ?? UPDATE_REPO}/releases?per_page=30`, 4 * 1024 * 1024, "application/vnd.github+json");
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
    const feedBytes = await this.#get(asset(feedName)!, MAX_FEED_BYTES);
    if (feedBytes === undefined) return { kind: "refused", why: `${feedName} could not be read (or is over ${MAX_FEED_BYTES} bytes)` };
    // 1. The update file's signature, before a byte of it is read.
    const sigUrl = asset(`${feedName}${SIGNATURE_SUFFIX}`);
    const feedVerdict = this.#verify(feedName, feedBytes, sigUrl === undefined ? undefined : await this.#get(sigUrl, MAX_FEED_BYTES));
    if (!feedVerdict.ok) return { kind: "refused", why: `${feedName}: ${feedVerdict.reason}` };
    let feed: CoreFeed;
    try {
      feed = parseCoreFeed(new TextDecoder().decode(feedBytes));
    } catch (err) {
      return { kind: "refused", why: `${feedName}: ${(err as Error).message}` };
    }
    if (!isNewer(feed.version, this.d.version)) return { kind: "up to date" };
    if (rolledBack(this.d.home).includes(feed.version)) return { kind: "refused", why: `${feed.version} was rolled back here` };
    const failed = this.#failed.get(feed.version);
    if (failed !== undefined && (this.d.now ?? Date.now)() < failed.until) return { kind: "refused", why: `${feed.version}'s swap failed; it is tried again later` };
    if (feed.file !== coreBinaryFile(feed.version, this.d.target)) return { kind: "refused", why: `${feedName} names ${feed.file}, not this target's binary` };
    this.#found = feed;
    const binUrl = asset(feed.file);
    // At most its signed size: a longer download stops there.
    const binBytes = binUrl === undefined ? undefined : await this.#get(binUrl, feed.size);
    if (binBytes === undefined) return { kind: "refused", why: `${feed.file} could not be read (or is over its ${feed.size} bytes)` };
    // 2. The binary's signature, then its SHA-512 and size against the update file.
    const binSigUrl = asset(`${feed.file}${SIGNATURE_SUFFIX}`);
    const binVerdict = this.#verify(feed.file, binBytes, binSigUrl === undefined ? undefined : await this.#get(binSigUrl, MAX_FEED_BYTES));
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

  /**
   * The swap, with the gate already closed for the restart (`apply`): `.new` checked again, the old binary moved to
   * `.old` and the new one into its place, then the drain and the restart exit. A failure before the drain leaves the
   * old binary in place and the daemon running, reopens the gate, and puts the version on a back-off.
   */
  async swap(): Promise<void> {
    const feed = this.#found;
    const bin = this.d.bin, staged = `${bin}.new`, old = `${bin}.old`;
    try {
      if (!this.#ready || feed === undefined || !existsSync(staged)) throw new Error("no checked update to install");
      // `.new` waited, maybe for hours: it is the checked binary only if it still hashes to the signed SHA-512.
      const bytes = readFileSync(staged);
      if (bytes.length !== feed.size || createHash("sha512").update(bytes).digest("base64") !== feed.sha512) {
        rmSync(staged, { force: true });
        throw new Error(`${staged} is no longer the checked ${feed.version}; it was removed`);
      }
      if (!retireOld(bin)) throw new Error(`${old} is still in use and can't be moved aside`);
      // The boot count first: a kill between here and the restart still has the new version's starts watched (and a
      // stray count with no `.old` behind it clears itself at the next start).
      writeJson(bootFile(this.d.home), { version: feed.version, boots: 0 });
      renameSync(bin, old);
      try {
        renameSync(staged, bin);
      } catch (err) {
        renameSync(old, bin);
        throw err;
      }
    } catch (err) {
      this.#swapFailed(feed?.version, err);
      return;
    }
    // Committed: the gate stays closed however long the drain takes.
    this.d.gate.commit();
    this.d.log(`update: ${feed.version} is in place (from ${this.d.version}); restarting`);
    try {
      await this.d.drain();
    } finally {
      // The new binary is in place: the restart starts it, whatever the drain said.
      this.d.exit(this.d.restartCode);
    }
  }

  #swapFailed(version: string | undefined, err: unknown): void {
    const prev = version === undefined ? undefined : this.#failed.get(version);
    const wait = Math.min(24 * 60 * 60 * 1000, prev === undefined ? SWAP_BACKOFF_MS : prev.wait * 2);
    if (version !== undefined) this.#failed.set(version, { until: (this.d.now ?? Date.now)() + wait, wait });
    this.#ready = false;
    this.d.gate.reopen();
    for (const f of [bootFile(this.d.home), `${this.d.bin}.new`]) {
      try {
        rmSync(f, { force: true });
      } catch {
        // `.new` goes with the next check's (it writes `.new` afresh); a count with no `.old` clears itself at a start
      }
    }
    this.d.log(`update: installing ${version ?? "the update"} failed, the daemon keeps running on ${this.d.version} and tries again in ${Math.round(wait / 60_000)} min: ${err instanceof Error ? err.message : String(err)}`);
  }
}
