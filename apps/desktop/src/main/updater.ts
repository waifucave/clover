// The app's updates (spec §3.1, plan §4 M-M2): electron-updater over the GitHub releases electron-builder publishes to
// (apps/desktop/electron-builder.yml's `publish`, its channel baked into app-update.yml), with one change: every update
// file it reads (`latest-mac.yml`, `beta.yml`, …) must carry a good Ed25519 signature in the `.sig` beside it,
// checked against the key the app carries (packages/update-feed), before electron-updater parses a byte of it. The
// update's own SHA-512 is in that file, so the download is trusted only once the file is: the Linux AppImage has no OS
// signature check, and a GitHub account someone else got into can't put up a release the app takes. A file that
// doesn't verify (or an app built before the key exists) makes the check fail, and the app stays as it is.
//
// The check sits in the provider's own request path (VerifiedGitHubProvider wraps its HTTP executor), so the bytes
// verified are the bytes parsed: nothing is fetched twice. Downgrades are off (a replayed older signed file can't
// roll the app back). Packaged apps only; on Linux only the AppImage updates itself (the deb and the rpm update
// through apt and dnf).
//
// The idle gate (spec §3.1: "An update waits until the daemon is between turns and no agent runs, then stops the pair,
// installs both and starts them again"): the update downloads in the background and never installs on its own at a
// quit (`autoInstallOnAppQuit` off). While one is ready, `InstallGate` asks the daemon every minute (`update.status`);
// at the first idle answer it asks `update.apply` (the daemon readies its restart and answers `now`), says
// `pair.exiting{update}`, stops the pair, waits for the daemon to go and installs, starting the new app after. The
// user's own Quit (whose question already says what would stop) installs too once the pair has stopped, without
// starting the app again. Nothing here ever installs over a running turn.
import type { RequestOptions } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider";
import { verifyFeed, SIGNATURE_SUFFIX, type FeedVerdict } from "@waifucave/clover-update-feed";

/** An update file's name, as the release holds it (packages/update-feed's FEED_NAME). */
const FEED_FILE = /^(latest|beta)(-mac|-linux|-linux-arm64)?\.yml$/;

/** The update file a request asks for, by its URL path's last segment; undefined for anything else (the release
 *  list, the download itself). */
export function feedFileOf(path: string | null | undefined): string | undefined {
  if (path === null || path === undefined) return undefined;
  const name = decodeURIComponent(path.split("?")[0]!.split("/").pop() ?? "");
  return FEED_FILE.test(name) ? name : undefined;
}

export class FeedRefused extends Error {
  constructor(readonly file: string, readonly verdict: Exclude<FeedVerdict, { ok: true }>) {
    super(`the update file ${file} is refused: ${verdict.reason}`);
  }
}

interface Executor {
  request(options: RequestOptions, cancellationToken: unknown, data?: unknown): Promise<string | null | undefined>;
}

/**
 * An executor that answers as `inner` does, except that an update file's text is returned only once its `.sig`
 * (fetched through the same executor, from the same place) verifies over exactly those bytes; otherwise it throws.
 */
export function verifyingExecutor<E extends Executor>(inner: E, publicKey?: string | null): E {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== "request") return Reflect.get(target, prop, receiver);
      return async (options: RequestOptions, token: unknown, data?: unknown): Promise<string | null | undefined> => {
        const text = await target.request(options, token, data);
        const file = feedFileOf(options.path);
        if (file === undefined) return text;
        let signature: string | undefined;
        try {
          signature = (await target.request({ ...options, path: `${options.path!.split("?")[0]}${SIGNATURE_SUFFIX}` }, token)) ?? undefined;
        } catch {
          signature = undefined;
        }
        const bytes = new TextEncoder().encode(text ?? "");
        const verdict = publicKey === undefined ? verifyFeed(file, bytes, signature) : verifyFeed(file, bytes, signature, publicKey);
        if (!verdict.ok) throw new FeedRefused(file, verdict);
        return text;
      };
    },
  });
}

/** electron-updater's GitHub provider, reading update files only through `verifyingExecutor`. */
export class VerifiedGitHubProvider extends GitHubProvider {
  constructor(...args: ConstructorParameters<typeof GitHubProvider>) {
    super(...args);
    const self = this as unknown as { executor: Executor };
    self.executor = verifyingExecutor(self.executor);
  }
}

/** The publish settings electron-builder bakes into the app (resources/app-update.yml: plain `key: value` lines). */
export function parseUpdateConfig(text: string): { owner: string; repo: string; channel: string } | undefined {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(line);
    if (m) fields.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, "$2"));
  }
  const owner = fields.get("owner"), repo = fields.get("repo");
  if (fields.get("provider") !== "github" || !owner || !repo) return undefined;
  return { owner, repo, channel: fields.get("channel") || "latest" };
}

/** Whether this app updates itself: packaged, and on Linux only as an AppImage. */
export function updatesItself(packaged: boolean, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (!packaged) return false;
  if (platform === "linux") return typeof env.APPIMAGE === "string" && env.APPIMAGE !== "";
  return platform === "darwin" || platform === "win32";
}

/** What installed this app, for `<home>/install.json` (packages/core's install marker): the app's own installers, or
 *  on Linux outside an AppImage a deb or rpm. Only a server install's daemon updates itself; this marker says it isn't. */
export function installKindOf(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): "app" | "package" {
  return platform === "linux" && !(typeof env.APPIMAGE === "string" && env.APPIMAGE !== "") ? "package" : "app";
}

/** Writes `<home>/install.json` when it doesn't already say `kind`. A packaged app only; never throws. */
export function writeInstallMarker(home: string, kind: "app" | "package", log: (line: string) => void): void {
  const path = join(home, "install.json");
  const text = `${JSON.stringify({ kind })}\n`;
  try {
    if (readFileSync(path, "utf8") === text) return;
  } catch {
    // none yet
  }
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch (err) {
    log(`updater: install.json not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
/** While an update is ready, how often the app asks the daemon whether it is idle. */
export const IDLE_POLL_MS = 60_000;

export interface InstallGateDeps {
  /** `update.status`'s idle verdict; undefined when the daemon can't be asked (then nothing installs). */
  status(): Promise<{ idle: boolean; busy: readonly string[] } | undefined>;
  /** `update.apply`: `now` once the daemon is idle and ready for its restart. */
  apply(): Promise<"now" | "when-idle" | undefined>;
  /** `pair.exiting{update}`: the app leaves on purpose, and the pair stops with it. */
  exiting(): Promise<void>;
  /** Stops the app's side (the pair's connection, the browser, the tray) before the install. */
  stopApp(): void;
  /** Resolves once the daemon has gone (bounded), so the installer never meets its files in use. */
  daemonGone(): Promise<void>;
  /** electron-updater's quitAndInstall; `relaunch`: start the new app after (an idle install) or not (a Quit). */
  install(relaunch: boolean): void;
  /** Runs `fn` every `ms`; returns a stop. */
  every(ms: number, fn: () => void): () => void;
  log(line: string): void;
}

/** When a downloaded update installs: at the daemon's first idle moment, or at the user's Quit. */
export class InstallGate {
  #ready: string | undefined;
  #stopPolling: (() => void) | undefined;
  #checking = false;
  #installing = false;

  constructor(private readonly d: InstallGateDeps, private readonly pollMs = IDLE_POLL_MS) {}

  /** The version downloaded and waiting, if any. */
  get ready(): string | undefined {
    return this.#ready;
  }

  get installing(): boolean {
    return this.#installing;
  }

  /** An update finished downloading: ask now, then every `pollMs`, until an idle moment installs it. */
  downloaded(version: string): Promise<void> {
    this.#ready = version;
    this.#stopPolling ??= this.d.every(this.pollMs, () => void this.check());
    return this.check();
  }

  /** One poll: installs if the daemon is idle and agrees. */
  async check(): Promise<void> {
    if (this.#ready === undefined || this.#installing || this.#checking) return;
    this.#checking = true;
    try {
      const status = await this.d.status().catch(() => undefined);
      if (status === undefined) return this.d.log("updater: the daemon can't be asked whether it is idle; the update waits");
      if (!status.idle) return this.d.log(`updater: ${this.#ready} waits for an idle moment (${status.busy.join(", ") || "busy"})`);
      const at = await this.d.apply().catch(() => undefined);
      if (at !== "now") return this.d.log(`updater: the daemon isn't ready for the restart yet (${at ?? "no answer"})`);
      await this.#install(true);
    } finally {
      this.#checking = false;
    }
  }

  /** The user's Quit, after `pair.quit` stopped the pair: installs (without starting the app again) and owns the exit.
   *  False when there is nothing to install, and the caller exits as usual. */
  async quitting(): Promise<boolean> {
    if (this.#ready === undefined || this.#installing) return false;
    this.d.log(`updater: installing ${this.#ready} at the user's Quit`);
    await this.#install(false, false);
    return true;
  }

  async #install(relaunch: boolean, tellDaemon = true): Promise<void> {
    this.#installing = true;
    this.#stopPolling?.();
    this.#stopPolling = undefined;
    this.d.log(`updater: installing ${this.#ready}${relaunch ? " now the daemon is idle" : ""}`);
    if (tellDaemon) await this.d.exiting();
    this.d.stopApp();
    await this.d.daemonGone();
    this.d.install(relaunch);
  }

  /** Stops the polling (the app is leaving for another reason). */
  stop(): void {
    this.#stopPolling?.();
    this.#stopPolling = undefined;
  }
}

export interface UpdaterDeps {
  packaged: boolean;
  resourcesPath: string;
  /** The update is downloaded and checked, and installs at an idle moment (`InstallGate`). */
  onReady(version: string): void;
  log(line: string): void;
}

export interface Updater {
  stop(): void;
  /** Quits and installs the downloaded update; `relaunch` starts the new app after. */
  install(relaunch: boolean): void;
}

const NO_UPDATER: Updater = { stop: () => {}, install: () => {} };

/** Starts the checks (now, then every UPDATE_CHECK_MS). A no-op where the app doesn't update itself. */
export async function startUpdater(deps: UpdaterDeps): Promise<Updater> {
  if (!updatesItself(deps.packaged, process.platform, process.env)) return NO_UPDATER;
  let config: ReturnType<typeof parseUpdateConfig>;
  try {
    config = parseUpdateConfig(readFileSync(join(deps.resourcesPath, "app-update.yml"), "utf8"));
  } catch {
    config = undefined;
  }
  if (config === undefined) {
    deps.log("updater: no GitHub publish settings in app-update.yml; this build doesn't update itself");
    return NO_UPDATER;
  }
  const { autoUpdater } = (await import("electron-updater")).default;
  autoUpdater.logger = { info: (m: unknown) => deps.log(`updater: ${String(m)}`), warn: (m: unknown) => deps.log(`updater: ${String(m)}`), error: (m: unknown) => deps.log(`updater: ${String(m)}`), debug: () => {} };
  autoUpdater.setFeedURL({ provider: "custom", updateProvider: VerifiedGitHubProvider, owner: config.owner, repo: config.repo } as never);
  autoUpdater.channel = config.channel;
  // Beta takes the newest release of either kind (a beta is a GitHub prerelease); latest only full releases.
  autoUpdater.allowPrerelease = config.channel === "beta";
  // Setting the channel turns downgrades on; a signed older file must never take the app back.
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoDownload = true;
  // Never at an arbitrary quit (a crash's restart, a restart into safe mode): only through InstallGate.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("update-downloaded", (info: { version: string }) => deps.onReady(info.version));
  autoUpdater.on("error", (err: Error) => deps.log(`updater: ${err.message}`));
  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: unknown) => deps.log(`updater: ${err instanceof Error ? err.message : String(err)}`));
  };
  check();
  const timer = setInterval(check, UPDATE_CHECK_MS);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    install: (relaunch) => {
      // macOS (Squirrel) reads this instead of quitAndInstall's arguments: relaunch, or install as the app quits.
      autoUpdater.autoRunAppAfterInstall = relaunch;
      autoUpdater.quitAndInstall(true, relaunch);
    },
  };
}
