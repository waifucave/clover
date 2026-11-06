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
import type { RequestOptions } from "node:http";
import { readFileSync } from "node:fs";
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

export const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;

export interface UpdaterDeps {
  packaged: boolean;
  resourcesPath: string;
  /** The update is downloaded and installs when the app quits. */
  onReady(version: string): void;
  log(line: string): void;
}

/** Starts the checks (now, then every UPDATE_CHECK_MS); returns a stop. A no-op where the app doesn't update itself. */
export async function startUpdater(deps: UpdaterDeps): Promise<() => void> {
  if (!updatesItself(deps.packaged, process.platform, process.env)) return () => {};
  let config: ReturnType<typeof parseUpdateConfig>;
  try {
    config = parseUpdateConfig(readFileSync(join(deps.resourcesPath, "app-update.yml"), "utf8"));
  } catch {
    config = undefined;
  }
  if (config === undefined) {
    deps.log("updater: no GitHub publish settings in app-update.yml; this build doesn't update itself");
    return () => {};
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
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info: { version: string }) => deps.onReady(info.version));
  autoUpdater.on("error", (err: Error) => deps.log(`updater: ${err.message}`));
  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err: unknown) => deps.log(`updater: ${err instanceof Error ? err.message : String(err)}`));
  };
  check();
  const timer = setInterval(check, UPDATE_CHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
