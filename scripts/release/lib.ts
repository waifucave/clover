// Clover's release (plan §4 M-M2): the update channels and feeds, the artifacts each OS's release holds, and the
// signing and notarization commands, as pure functions the release scripts (build.ts, publish.ts) and their tests
// share. Nothing here runs a command or reads a secret; `writeServedCopies` is its one write, into a build's output.
//
// The feed: electron-updater's GitHub provider over this public repository's releases (electron-builder.yml's
// `publish`), the same releases the Homebrew cask and winget download from. A release is tagged v<version> and holds
// every OS's installers and update files. Two channels, as Sparkle had:
//   latest   a full release; its update files are copied to the beta names too (`writeServedCopies`: electron-builder
//            writes only the channel it is given), so a beta user takes stable releases too
//   beta     a pre-release, with beta files only; promoting it to latest adds the latest files and makes it a full
//            release (publish.ts --promote)
// electron-updater reads `<channel>-mac.yml`, `<channel>.yml` (Windows), `<channel>-linux.yml` and
// `<channel>-linux-arm64.yml` from the newest release its channel allows.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const CHANNELS = ["latest", "beta"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The feed, as electron-builder.yml's `publish` names it. */
export const FEED = { provider: "github", owner: "waifucave", repo: "clover" } as const;

export type ReleaseOs = "mac" | "win" | "linux-x64" | "linux-arm64";

/** The update file electron-updater reads for `os` on `channel`. */
export function feedFile(channel: Channel, os: ReleaseOs): string {
  switch (os) {
    case "mac": return `${channel}-mac.yml`;
    case "win": return `${channel}.yml`;
    case "linux-x64": return `${channel}-linux.yml`;
    case "linux-arm64": return `${channel}-linux-arm64.yml`;
  }
}

/** The channels a release on `channel` writes update files for: a full release serves beta users too. */
export function channelsServed(channel: Channel): Channel[] {
  return channel === "latest" ? ["latest", "beta"] : ["beta"];
}

/** The installers a release holds for `os` (electron-builder.yml's artifact names; the cask and winget use them). */
export function installers(version: string, os: ReleaseOs): string[] {
  switch (os) {
    case "mac": return [`Clover-${version}.dmg`, `Clover-${version}-mac.zip`];
    case "win": return [`Clover-Setup-${version}.exe`];
    case "linux-x64": return [`clover_${version}_amd64.deb`, `clover-${version}.x86_64.rpm`, `Clover-${version}-x86_64.AppImage`];
    // electron-builder spells the architecture per format: the rpm's file says arm64 where the package says aarch64.
    case "linux-arm64": return [`clover_${version}_arm64.deb`, `clover-${version}.arm64.rpm`, `Clover-${version}-arm64.AppImage`];
  }
}

/** Every file `os`'s release build must leave: its installers and its update files for each channel served. */
export function expectedArtifacts(version: string, os: ReleaseOs, channel: Channel): string[] {
  return [...installers(version, os), ...channelsServed(channel).map((c) => feedFile(c, os))];
}

/** After electron-builder: each update file `oses`' build wrote for `channel`, copied under the other channels it serves
 *  (`latest-mac.yml` → `beta-mac.yml`). The copies name the same files. Returns the files written. */
export function writeServedCopies(outDir: string, channel: Channel, oses: readonly ReleaseOs[]): string[] {
  const written: string[] = [];
  for (const os of oses) {
    const from = join(outDir, feedFile(channel, os));
    if (!existsSync(from)) continue;
    for (const other of channelsServed(channel).filter((c) => c !== channel)) {
      copyFileSync(from, join(outDir, feedFile(other, os)));
      written.push(feedFile(other, os));
    }
  }
  return written;
}

/** The electron-builder flag that sets the channel the update files are written for. */
export function channelArgs(channel: Channel): string[] {
  return [`-c.publish.channel=${channel}`];
}

export function parseChannel(value: string | undefined): Channel {
  if (value === undefined || !(CHANNELS as readonly string[]).includes(value)) throw new Error(`--channel takes ${CHANNELS.join(" or ")}${value === undefined ? "" : ` (not ${value})`}`);
  return value as Channel;
}

// ---- the update files ----

/** One file in an update file: electron-updater checks its SHA-512 (base64) and size. */
export interface FeedEntry {
  url: string;
  sha512: string;
  size?: number;
  blockMapSize?: number;
}

export interface UpdateInfo {
  version: string;
  files: FeedEntry[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
  [key: string]: unknown;
}

export function sha512Base64(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

export function parseUpdateInfo(text: string): UpdateInfo {
  const info = Bun.YAML.parse(text) as Partial<UpdateInfo> | null;
  if (info === null || typeof info !== "object" || typeof info.version !== "string" || !Array.isArray(info.files)) throw new Error("not an update file: it needs a version and files");
  for (const f of info.files) if (typeof f?.url !== "string" || typeof f?.sha512 !== "string") throw new Error("not an update file: each file needs a url and a sha512");
  return info as UpdateInfo;
}

export function formatUpdateInfo(info: UpdateInfo): string {
  return Bun.YAML.stringify(info, null, 2);
}

/**
 * The update file with `url`'s entry measured again from `bytes` (stapling a dmg after electron-builder wrote the
 * file changes its bytes). Its block map goes, as the block map no longer matches; the top-level `path` and `sha512`
 * follow when they name it.
 */
export function refreshEntry(info: UpdateInfo, url: string, bytes: Uint8Array): UpdateInfo {
  const sha512 = sha512Base64(bytes);
  if (!info.files.some((f) => f.url === url)) throw new Error(`the update file has no ${url}`);
  const files = info.files.map((f) => {
    if (f.url !== url) return f;
    const { blockMapSize: _gone, ...rest } = f;
    return { ...rest, sha512, size: bytes.length };
  });
  return { ...info, files, ...(info.path === url ? { sha512 } : {}) };
}

/** What's wrong with an update file against the files it names (`read` gives a file's bytes, or undefined). */
export function checkUpdateInfo(info: UpdateInfo, version: string, read: (name: string) => Uint8Array | undefined): string[] {
  const problems: string[] = [];
  if (info.version !== version) problems.push(`it is for ${info.version}, not ${version}`);
  for (const f of info.files) {
    const bytes = read(f.url);
    if (bytes === undefined) { problems.push(`${f.url} is missing`); continue; }
    if (sha512Base64(bytes) !== f.sha512) problems.push(`${f.url}'s sha512 doesn't match`);
    if (f.size !== undefined && f.size !== bytes.length) problems.push(`${f.url}'s size is ${bytes.length}, not ${f.size}`);
  }
  if (info.path !== undefined && !info.files.some((f) => f.url === info.path)) problems.push(`its path ${info.path} is not among its files`);
  return problems;
}

// ---- macOS signing and notarization ----

/** The team in a Developer ID identity's name: `Developer ID Application: <name> (<TEAMID>)`. */
export function identityTeam(identity: string): string {
  const m = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(identity);
  if (!m) throw new Error(`a release signs with a Developer ID Application identity, named in full ("Developer ID Application: <name> (<TEAMID>)"), not ${JSON.stringify(identity)}`);
  return m[1]!;
}

/**
 * The binaries Clover's own build puts in the app's resources, which it signs itself (electron-builder.yml's
 * `signIgnore` leaves them to it): each with the hardened runtime, a secure timestamp, its own identifier, and
 * only the entitlements it needs. The daemon is Bun, whose JIT needs `allow-jit` and, until the SIP-on check drops
 * it, `allow-unsigned-executable-memory` (scripts/clover-core.entitlements); the link sidecar is Rust and needs none.
 */
/** The bundled plugins' folder in the app's resources (electron-builder.yml): the registry's `bundledDirs` entry. The
 *  core resolves it as <dirname(clover-core)>/../plugins, the daemon living in resources/daemon/. */
export const BUNDLED_PLUGINS_DIR = "plugins";
/** The top-level plugins every build ships (each with its manifest). */
export const BUNDLED_PLUGIN_IDS = ["clover", "alpha"] as const;

/** What's wrong with a packaged app's bundled plugins under `resources`: each top-level plugin's manifest is there,
 *  and no test, tsconfig or node_modules came along. */
export function bundledPluginsProblems(resources: string, exists: (path: string) => boolean, walk: (dir: string) => string[]): string[] {
  const dir = join(resources, BUNDLED_PLUGINS_DIR);
  const problems = BUNDLED_PLUGIN_IDS.filter((id) => !exists(join(dir, id, "clover.json"))).map((id) => `${join(dir, id, "clover.json")} is missing: the ${id} plugin isn't bundled`);
  const stray = walk(dir).filter((rel) => /(^|\/)(node_modules|tests?)\//.test(rel) || /\.test\.tsx?$/.test(rel) || /(^|\/)tsconfig[^/]*\.json$/.test(rel));
  if (stray.length > 0) problems.push(`${dir} holds files a release leaves out: ${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ", …" : ""}`);
  return problems;
}

export const RESOURCE_BINARIES = [
  { file: "clover-core", identifier: "com.waifucave.clover.core", entitlements: "scripts/clover-core.entitlements" },
  { file: "clover-link", identifier: "com.waifucave.clover.link", entitlements: undefined },
] as const;

export function codesignArgs(path: string, identity: string, identifier: string, entitlements?: string): string[] {
  return ["codesign", "--force", "--sign", identity, "--options", "runtime", "--timestamp", "--identifier", identifier,
    ...(entitlements === undefined ? [] : ["--entitlements", entitlements]), path];
}

/** A disk image is signed without the hardened runtime (it isn't code that runs). */
export function codesignDmgArgs(path: string, identity: string): string[] {
  return ["codesign", "--force", "--sign", identity, "--timestamp", path];
}

/** notarytool with a stored profile (`xcrun notarytool store-credentials`): its credentials stay in the keychain. */
export function notarizeArgs(path: string, keychainProfile: string): string[] {
  return ["xcrun", "notarytool", "submit", path, "--keychain-profile", keychainProfile, "--wait"];
}

export interface CodeSignature {
  identifier?: string;
  teamId?: string;
  runtime: boolean;
  timestamped: boolean;
  adhoc: boolean;
}

/** `codesign -dvvv <path>`'s report (it writes to stderr). */
export function parseCodesignDisplay(out: string): CodeSignature {
  const field = (name: string): string | undefined => new RegExp(`^${name}=(.*)$`, "m").exec(out)?.[1]?.trim();
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(out)?.[1] ?? "";
  const team = field("TeamIdentifier");
  return {
    ...(field("Identifier") !== undefined ? { identifier: field("Identifier")! } : {}),
    ...(team !== undefined && team !== "not set" ? { teamId: team } : {}),
    runtime: flags.split(",").includes("runtime"),
    timestamped: /^Timestamp=/m.test(out),
    adhoc: flags.split(",").includes("adhoc") || /^Signature=adhoc$/m.test(out),
  };
}

/** What's wrong with one signed file for a release by `teamId` (notarization refuses each of these). */
export function signatureProblems(name: string, sig: CodeSignature, teamId: string, identifier?: string): string[] {
  const problems: string[] = [];
  if (sig.adhoc || sig.teamId === undefined) problems.push(`${name} is not signed with a Developer ID`);
  else if (sig.teamId !== teamId) problems.push(`${name} is signed by team ${sig.teamId}, not ${teamId}`);
  if (!sig.runtime) problems.push(`${name} has no hardened runtime`);
  if (!sig.timestamped) problems.push(`${name} has no secure timestamp`);
  if (identifier !== undefined && sig.identifier !== identifier) problems.push(`${name}'s identifier is ${sig.identifier ?? "(none)"}, not ${identifier}`);
  return problems;
}
