// A release build for macOS or Windows (plan §4 M-M2): the app with the daemon and its link sidecar inside, its
// installers and its update files for a channel, in apps/desktop/out/dist/. Linux's release build is
// scripts/build-packages.ts with the same --channel.
//
//   bun scripts/release/build.ts [--channel latest|beta] [--sign] [--dry-run]
//
// It runs on the OS it builds for (macOS on Apple silicon, Windows x64):
//   1. builds the app (apps/desktop's `build`); stages the bundled plugins (the committed files under plugins/) in
//      apps/desktop/out/plugins and measures them; builds the daemon (scripts/build-daemon.ts) with that manifest
//      compiled in, and clover-link (cargo)
//   2. stages the daemon, the sidecar, plugin Bun and (macOS) the process holder in apps/desktop/out/daemon/, where
//      electron-builder.yml's extraResources picks them up
//   3. with --sign on macOS, signs the staged binaries with the Developer ID (hardened runtime, timestamp, each its own
//      identifier and entitlements: lib.ts's RESOURCE_BINARIES), then the package gate (scripts/bundled-binaries.ts:
//      plugin Bun and the holder there, under their own identifiers), again on the built app
//   4. runs electron-builder for the OS's targets (`--publish never`, always) with the channel; with --sign, the
//      identity and notarization on macOS, and forced signing and the update publisher on Windows; then checks the
//      app's resources/plugins is exactly the tree the core's manifest names, with nothing left out and no symlink
//      (bundled-plugins.ts)
//   5. with --sign on macOS: signs, notarizes and staples the dmg, measures the update file's dmg entry again,
//      and checks the app and the app inside the update zip (every signature, the app's against Clover's requirement:
//      its identifier and team, the daemon's and the sidecar's
//      entitlements, the seal, Gatekeeper's verdict, the staple) and the dmg (its signature, its staple, Gatekeeper
//      on opening it); on Windows, the Authenticode signatures of the installer, Clover.exe, clover-core.exe,
//      clover-link.exe and clover-plugin-bun.exe, by the publisher
//   6. copies the daemon out of the app (signed with it, on a signed build) as clover-core-<version>-<target>, with its
//      update file for each channel served (lib.ts's `writeCoreAssets`), for a server's daemon to update itself from;
//      plugin Bun beside it likewise; and the app's resources/plugins packed as clover-plugins-<version>-<target>.tar.gz
//      with its update file (`writePluginsAssets`), the tree that core's manifest names
//   7. runs the identity scan over everything in out/dist (scripts/release/name-scan.ts; a signed release fails
//      closed without the owner's guard), then records the commit it built (BUILD-COMMIT-<os>.txt; every build needs a fully clean checkout), on latest copies
//      the update files to the beta names (lib.ts's `writeServedCopies`), and checks the installers and update files are all there, each update file against the files it names, and
//      writes SHA256SUMS-<os>.txt beside them
//
// Signing is the owner's: without --sign the build is unsigned (CI's release workflow), whatever the environment
// holds, and electron-builder is told not to look for an identity. With --sign every input must be there, or it
// stops before building:
//   macOS     CLOVER_MAC_IDENTITY     the identity's full name, "Developer ID Application: <name> (<TEAMID>)", in the
//                                     login keychain; its team must be Clover's (CLOVER_TEAM_ID)
//             APPLE_KEYCHAIN_PROFILE  notarytool's stored profile (`xcrun notarytool store-credentials`)
//   Windows   WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD   the Authenticode certificate, as electron-builder takes it
//             CLOVER_WIN_PUBLISHER    its subject's common name, which electron-updater checks each update against
// None is printed, logged or written anywhere. Nothing is published.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonOutput, runScriptLine, type DaemonTarget } from "../build-daemon";
import { CLOVER_TEAM_ID } from "../../packages/core/src/auth/app-token-acl";
import { BUNDLED_MANIFEST_FILE, type BundledManifest } from "../../packages/core/src/bundled-plugins-dir";
import { LINK_BUILD, LINK_OUTPUT, linkBuildEnv } from "../build-packages";
import { bundledBinaryProblems, bundledFiles } from "../bundled-binaries";
import { sealProblems } from "../seal-bun-doors";
import { runNameScan } from "./name-scan";
import { buildBundledPlugins, bundledPluginsProblems, STAGED_PLUGINS, walkTree, writeStagedManifest } from "./bundled-plugins";
import {
  authenticodeCommand, authenticodeProblems, channelArgs, checkCoreFeed, checkoutCommit, checkUpdateInfo, codesignArgs, codesignDmgArgs, CORE_TARGET, entitlementsIn,
  expectedArtifacts, feedFile, formatUpdateInfo, identityTeam, parseEntitlementKeys, writeBuildCommit,
  notarizeArgs, parseChannel, parseCodesignDisplay, parseUpdateInfo, refreshEntry, RESOURCE_BINARIES, signatureProblems,
  checkPluginBunFeed, checkPluginsFeed, writeCoreAssets, writePluginBunAssets, writePluginsAssets, writeServedCopies, type Channel,
} from "./lib";
import { coreFeedFile, pluginBunFeedFile, pluginsFeedFile } from "../../packages/update-feed/src/index";

export type BuildOs = "mac" | "win";

/** The app's bundle identifier (apps/desktop/electron-builder.yml's appId). */
export const CLOVER_APP_IDENTIFIER = "com.waifucave.clover";
/** The code requirement the signed Clover.app must satisfy: its identifier, Apple's Developer ID chain, Clover's team. */
export const CLOVER_APP_REQUIREMENT = `identifier "${CLOVER_APP_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`;

export interface ReleaseBuildArgs {
  os: BuildOs;
  channel: Channel;
  sign: boolean;
  dryRun: boolean;
}

/** The OS this machine builds for, or undefined (only Apple silicon Macs and x64 Windows build releases here). */
export function buildOsFor(platform: string, arch: string): BuildOs | undefined {
  if (platform === "darwin" && arch === "arm64") return "mac";
  if (platform === "win32" && arch === "x64") return "win";
  return undefined;
}

export function parseReleaseBuildArgs(argv: readonly string[], platform: string, arch: string): ReleaseBuildArgs {
  let channel: Channel = "latest";
  let sign = false;
  let dryRun = false;
  let os: BuildOs | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--sign") sign = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--channel") channel = parseChannel(argv[++i]);
    else if (a.startsWith("--channel=")) channel = parseChannel(a.slice("--channel=".length));
    // A dry run may print another OS's steps.
    else if (a === "--os" || a.startsWith("--os=")) {
      const v = a === "--os" ? argv[++i] : a.slice("--os=".length);
      if (v !== "mac" && v !== "win") throw new Error(`--os takes mac or win (not ${String(v)})`);
      os = v;
    } else throw new Error(`unknown argument ${a} (usage: release/build [--channel latest|beta] [--sign] [--dry-run])`);
  }
  const host = buildOsFor(platform, arch);
  if (os !== undefined && os !== host && !dryRun) throw new Error(`this machine builds ${host ?? "no release"}: --os ${os} is for a dry run elsewhere`);
  os ??= host;
  if (os === undefined) throw new Error(`a release builds on an Apple silicon Mac or on x64 Windows (this is ${platform}-${arch}); Linux's is scripts/build-packages.ts`);
  return { os, channel, sign, dryRun };
}

/** What --sign needs from the environment, or the names missing (never their values). */
export function signingInputs(os: BuildOs, env: Record<string, string | undefined>): { missing: string[]; problems: string[] } {
  const need = os === "mac" ? ["CLOVER_MAC_IDENTITY", "APPLE_KEYCHAIN_PROFILE"] : ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "CLOVER_WIN_PUBLISHER"];
  const missing = need.filter((k) => !env[k]);
  const problems: string[] = [];
  if (os === "mac" && env.CLOVER_MAC_IDENTITY) {
    try {
      // The team must be Clover's: the Keychain items' requirement for the core, and lane B's for plugin Bun
      // (`anchor apple generic and identifier … and certificate leaf[subject.OU] = CLOVER_TEAM_ID`), name it.
      const team = identityTeam(env.CLOVER_MAC_IDENTITY);
      if (team !== CLOVER_TEAM_ID) problems.push(`CLOVER_MAC_IDENTITY is team ${team}, not Clover's ${CLOVER_TEAM_ID}: the core's Keychain items and plugin Bun's check would refuse what it signs`);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return { missing, problems };
}

export const DAEMON_TARGET: Readonly<Record<BuildOs, DaemonTarget>> = { mac: "darwin-arm64", win: "windows-x64" };

/** The daemon inside the built app (the one the release ships, signed with the app on a signed build). */
export function daemonInApp(outDir: string, os: BuildOs): string {
  return os === "mac"
    ? join(outDir, "mac-arm64", "Clover.app", "Contents", "Resources", "daemon", "clover-core")
    : join(outDir, "win-unpacked", "resources", "daemon", "clover-core.exe");
}

/** The identity as electron-builder's `mac.identity` takes it: the full name less "Developer ID Application: ". */
export function builderIdentity(identity: string): string {
  const name = identity.replace(/^Developer ID Application: /, "");
  if (name === "" || name === identity) throw new Error("CLOVER_MAC_IDENTITY is a Developer ID Application identity named in full");
  return name;
}

/** electron-builder's command for the OS's release, run in apps/desktop. Secrets reach it through its environment only. */
export function releaseBuilderArgs(a: ReleaseBuildArgs, env: Record<string, string | undefined>): string[] {
  const base = a.os === "mac" ? ["electron-builder", "--mac", "dmg", "zip", "--arm64"] : ["electron-builder", "--win", "nsis", "--x64"];
  const out = [...base, "--publish", "never", ...channelArgs(a.channel)];
  if (!a.sign) return out;
  // electron-builder takes the identity without its "Developer ID Application: " prefix (it refuses one that has it,
  // and picks the certificate type itself); codesign takes the full name.
  if (a.os === "mac") return [...out, `-c.mac.identity=${builderIdentity(env.CLOVER_MAC_IDENTITY ?? "")}`, "-c.mac.notarize=true"];
  return [...out, "-c.win.forceCodeSigning=true", `-c.win.signtoolOptions.publisherName=${env.CLOVER_WIN_PUBLISHER}`];
}

/** The environment electron-builder runs with: an unsigned build never looks for an identity or a certificate. */
export function builderEnv(a: ReleaseBuildArgs, env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (a.sign) return env;
  const out: Record<string, string | undefined> = { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const k of ["CLOVER_MAC_IDENTITY", "CLOVER_WIN_PUBLISHER", "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "APPLE_KEYCHAIN_PROFILE", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) delete out[k];
  return out;
}

function run(cmd: readonly string[], cwd: string, env: Record<string, string | undefined> = process.env): { status: number; out: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", env: env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function must(say: string, cmd: readonly string[], cwd: string, env?: Record<string, string | undefined>): void {
  console.log(`release/build: ${say}…`);
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "inherit", env: (env ?? process.env) as NodeJS.ProcessEnv });
  if ((r.status ?? 1) !== 0) throw new Error(`${say} failed (exit ${r.status ?? "signal"})`);
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Whether `bytes` start a Mach-O file (thin, either byte order, 32 or 64 bit, or universal). */
export function isMachO(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

/** The Mach-O files under `dir` (paths relative to it, with `/`): the bundled plugins' native code. */
export function machOFiles(dir: string): string[] {
  return walkTree(dir).filter((e) => !e.link).map((e) => e.rel).filter((rel) => {
    const fd = openSync(join(dir, rel), "r");
    try {
      const head = new Uint8Array(4);
      return readSync(fd, head, 0, 4, 0) === 4 && isMachO(head);
    } finally {
      closeSync(fd);
    }
  }).sort();
}

/** A bundled plugin's native file's signing identifier: Clover's prefix and its path, as letters, digits and dots. */
export function nativeIdentifier(rel: string): string {
  return `com.waifucave.clover.plugin.${rel.replace(/[^A-Za-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "")}`;
}

/** One signed app's checks: its signatures, the resources' entitlements, its seal, Gatekeeper's verdict and its staple. */
function verifyMacApp(label: string, app: string, teamId: string, root: string, cwd: string): string[] {
  const problems: string[] = [];
  const display = (path: string) => parseCodesignDisplay(run(["codesign", "-dvvv", path], cwd).out);
  problems.push(...signatureProblems(label, display(app), teamId));
  for (const b of RESOURCE_BINARIES) {
    const path = join(app, "Contents", "Resources", "daemon", b.file);
    problems.push(...signatureProblems(`${label}'s ${b.file}`, display(path), teamId, b.identifier));
    // Exactly the entitlements it was meant to have: the daemon's file, and none for the sidecar.
    const have = parseEntitlementKeys(run(["codesign", "-d", "--entitlements", "-", "--xml", path], cwd).out);
    const want = b.entitlements === undefined ? [] : entitlementsIn(readFileSync(join(root, b.entitlements), "utf8"));
    if (have.join(",") !== want.join(",")) problems.push(`${label}'s ${b.file} has the entitlements [${have.join(", ")}], not [${want.join(", ")}]`);
  }
  // The bundled plugins' native code, signed before the manifest was measured (and left alone by electron-builder).
  const plugins = join(app, "Contents", "Resources", "plugins");
  if (existsSync(plugins)) {
    for (const rel of machOFiles(plugins)) problems.push(...signatureProblems(`${label}'s plugins/${rel}`, display(join(plugins, rel)), teamId, nativeIdentifier(rel)));
  }
  const deep = run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", `-R=${CLOVER_APP_REQUIREMENT}`, app], cwd);
  if (deep.status !== 0) problems.push(`codesign --verify --deep --strict against Clover's requirement refuses ${label}: ${deep.out.trim().slice(0, 400)}`);
  const gate = run(["spctl", "--assess", "--type", "execute", "--verbose=2", app], cwd);
  if (gate.status !== 0 || !/source=Notarized Developer ID/.test(gate.out)) problems.push(`Gatekeeper doesn't accept ${label} as notarized: ${gate.out.trim().slice(0, 400)}`);
  if (run(["xcrun", "stapler", "validate", app], cwd).status !== 0) problems.push(`${label} has no notarization staple`);
  return problems;
}

/**
 * The signed release's checks: the app, the app inside the update zip (what electron-updater installs), and the dmg
 * (its signature, its staple, and Gatekeeper's verdict on opening it).
 */
function verifyMac(outDir: string, version: string, teamId: string, root: string): string[] {
  const dmg = join(outDir, `Clover-${version}.dmg`);
  const problems = verifyMacApp("Clover.app", join(outDir, "mac-arm64", "Clover.app"), teamId, root, outDir);
  const unzipped = mkdtempSync(join(tmpdir(), "clover-release-zip-"));
  try {
    if (run(["ditto", "-x", "-k", join(outDir, `Clover-${version}-mac.zip`), unzipped], outDir).status !== 0) problems.push("the update zip doesn't unpack");
    else problems.push(...verifyMacApp("the update zip's Clover.app", join(unzipped, "Clover.app"), teamId, root, outDir));
  } finally {
    rmSync(unzipped, { recursive: true, force: true });
  }
  const dmgSig = parseCodesignDisplay(run(["codesign", "-dvvv", dmg], outDir).out);
  if (dmgSig.adhoc || dmgSig.teamId !== teamId) problems.push(`the dmg is not signed by team ${teamId}`);
  if (run(["xcrun", "stapler", "validate", dmg], outDir).status !== 0) problems.push("the dmg has no notarization staple");
  const open = run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg], outDir);
  if (open.status !== 0 || !/source=Notarized Developer ID/.test(open.out)) problems.push(`Gatekeeper doesn't accept the dmg as notarized: ${open.out.trim().slice(0, 400)}`);
  return problems;
}

/** The signed Windows release's checks: the installer, the app, and the daemon and sidecar beside it. */
function verifyWin(outDir: string, version: string, publisher: string): string[] {
  const unpacked = join(outDir, "win-unpacked");
  const files = [
    [`Clover-Setup-${version}.exe`, join(outDir, `Clover-Setup-${version}.exe`)],
    ["Clover.exe", join(unpacked, "Clover.exe")],
    ["clover-core.exe", join(unpacked, "resources", "daemon", "clover-core.exe")],
    ["clover-link.exe", join(unpacked, "resources", "daemon", "clover-link.exe")],
    ["clover-plugin-bun.exe", join(unpacked, "resources", "daemon", "clover-plugin-bun.exe")],
  ] as const;
  return files.flatMap(([name, path]) => authenticodeProblems(name, run(authenticodeCommand(path), outDir).out, publisher));
}

export async function main(argv: readonly string[], root: string): Promise<number> {
  let a: ReleaseBuildArgs;
  try {
    a = parseReleaseBuildArgs(argv, process.platform, process.arch);
  } catch (err) {
    console.error(`release/build: ${(err as Error).message}`);
    return 2;
  }
  if (a.sign) {
    const { missing, problems } = signingInputs(a.os, process.env);
    for (const m of missing) console.error(`release/build: --sign needs ${m} in the environment`);
    for (const p of problems) console.error(`release/build: ${p}`);
    if (missing.length + problems.length > 0) return 2;
  }
  const desktop = join(root, "apps", "desktop");
  const version = (JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { version: string }).version;
  const target = DAEMON_TARGET[a.os];
  const exe = a.os === "win" ? ".exe" : "";
  const builder = ["bun", "x", ...releaseBuilderArgs(a, process.env)];
  if (a.dryRun) {
    // The identity's name is not a secret, but a dry run has no need to print it.
    const shown = builder.map((c) => (c.startsWith("-c.mac.identity=") ? "-c.mac.identity=<CLOVER_MAC_IDENTITY>" : c.startsWith("-c.win.signtoolOptions.publisherName=") ? "-c.win.signtoolOptions.publisherName=<CLOVER_WIN_PUBLISHER>" : c));
    console.log(`release/build: ${a.os} ${version} on ${a.channel}, ${a.sign ? "signed" : "unsigned"}`);
    console.log(`release/build: the app: (in apps/desktop) bun run build`);
    console.log(`release/build: the bundled plugins: plugins/ at HEAD built for ${target} into apps/desktop/${STAGED_PLUGINS.split("\\").join("/")}, measured into out/${BUNDLED_MANIFEST_FILE}`);
    console.log(`release/build: the daemon: bun scripts/build-daemon.ts --target ${target} --plugins-manifest apps/desktop/out/${BUNDLED_MANIFEST_FILE}`);
    console.log(`release/build: the link sidecar: ${LINK_BUILD.join(" ")}`);
    if (a.sign && a.os === "mac") console.log(`release/build: sign each Mach-O file of the staged plugins (their native addons) before measuring: ${codesignArgs("out/plugins/<file>", "<CLOVER_MAC_IDENTITY>", nativeIdentifier("<file>")).join(" ")}`);
    if (a.sign && a.os === "mac") for (const b of RESOURCE_BINARIES) console.log(`release/build: sign ${b.file}: ${codesignArgs(`out/daemon/${b.file}`, "<CLOVER_MAC_IDENTITY>", b.identifier, b.entitlements).join(" ")}`);
    console.log(`release/build: package: (in apps/desktop) ${shown.join(" ")}`);
    if (a.sign && a.os === "mac") console.log(`release/build: the dmg: sign, ${notarizeArgs(`Clover-${version}.dmg`, "<APPLE_KEYCHAIN_PROFILE>").join(" ")}, xcrun stapler staple`);
    console.log(`release/build: the daemon's own update: ${daemonInApp("out/dist", a.os)} as its release file, with its update files`);
    console.log(`release/build: expects ${expectedArtifacts(version, a.os, a.channel).join(", ")}`);
    return 0;
  }
  try {
    const outDir = join(desktop, "out", "dist");
    const staged = join(desktop, "out", "daemon");
    // A release is of one commit, from a fully clean checkout of it (the build reads the whole tree).
    const commit = checkoutCommit(root);
    rmSync(outDir, { recursive: true, force: true });
    must("the app", ["bun", "run", "build"], desktop);
    // The bundled plugins' stage (the committed files only), its manifest, and the daemon's stage, where
    // electron-builder.yml packs them; all removed however the build ends (a stale stage would go into a later plain
    // `bun run dist`). The daemon is built after the plugins are staged: it carries their manifest.
    const stagedPlugins = join(desktop, STAGED_PLUGINS);
    const manifestFile = join(desktop, "out", BUNDLED_MANIFEST_FILE);
    let manifest: BundledManifest;
    try {
      // Built for this target from the committed files (lane B's buildPluginForShipping), natives included, then
      // measured: the manifest the daemon carries names exactly the built tree.
      const builtPlugins = await buildBundledPlugins(root, stagedPlugins, target);
      // A signed macOS build signs the plugins' native code (their addons) here, before the tree is measured, and
      // electron-builder.yml's signIgnore keeps the app's signing off it: signing changes a file's bytes, so the
      // manifest the core carries must name the signed ones. Notarization needs every Mach-O in the app signed.
      if (a.sign && a.os === "mac") {
        for (const rel of machOFiles(stagedPlugins)) {
          must(`sign the plugins' ${rel}`, codesignArgs(join(stagedPlugins, rel), process.env.CLOVER_MAC_IDENTITY!, nativeIdentifier(rel)), root);
        }
      }
      manifest = writeStagedManifest(stagedPlugins, manifestFile);
      console.log(`release/build: the bundled plugins: ${builtPlugins.files.length} files built (${builtPlugins.natives.length} native addon files), ${Object.keys(manifest.files).length} measured`);
      if (runScriptLine(`bun scripts/build-daemon.ts --target ${target} --plugins-manifest ${JSON.stringify(manifestFile)}`, root) !== 0) throw new Error("the daemon's build failed");
      must("the link sidecar", LINK_BUILD, root, linkBuildEnv(process.env, root));
      rmSync(staged, { recursive: true, force: true });
      mkdirSync(staged, { recursive: true });
      copyFileSync(join(root, ...daemonOutput(target).split("/")), join(staged, `clover-core${exe}`));
      copyFileSync(join(root, ...`${LINK_OUTPUT}${exe}`.split("/")), join(staged, `clover-link${exe}`));
      const built = dirname(join(root, ...daemonOutput(target).split("/")));
      for (const f of bundledFiles(target)) if (existsSync(join(built, f))) copyFileSync(join(built, f), join(staged, f));
      for (const f of readdirSync(staged)) chmodSync(join(staged, f), 0o755);
      // The seal (scripts/seal-bun-doors.ts) is checked on the very bytes that get signed: a core built some other way
      // never ships unsealed (on Windows, never half-sealed).
      const seal = sealProblems(new Uint8Array(readFileSync(join(staged, `clover-core${exe}`))));
      if (seal.length > 0) throw new Error(`the staged clover-core fails the seal's byte check: ${seal.join("; ")}`);
      if (a.sign && a.os === "mac") {
        for (const b of RESOURCE_BINARIES) {
          must(`sign ${b.file}`, codesignArgs(join(staged, b.file), process.env.CLOVER_MAC_IDENTITY!, b.identifier, b.entitlements === undefined ? undefined : join(root, b.entitlements)), root);
        }
      }
      // The package gate (scripts/bundled-binaries.ts): plugin Bun beside the core, and on macOS the process holder,
      // each under its own identifier — a packaged build never falls back to process-group tracking.
      const staging = bundledBinaryProblems(staged, target, { kind: "dist" });
      if (staging.length > 0) throw new Error(`the package gate: ${staging.join("; ")}`);
      must(`${a.os === "mac" ? "the dmg and the zip" : "the installer"} on ${a.channel}`, builder, desktop, builderEnv(a, process.env));
      const inApp = bundledBinaryProblems(dirname(daemonInApp(outDir, a.os)), target, { kind: "dist" });
      if (inApp.length > 0) throw new Error(`the package gate, in the built app: ${inApp.join("; ")}`);
    } finally {
      rmSync(staged, { recursive: true, force: true });
      rmSync(stagedPlugins, { recursive: true, force: true });
      rmSync(manifestFile, { force: true });
    }
    {
      // The bundled plugins, where the core looks for them (resources/plugins beside resources/daemon).
      const resources = a.os === "mac" ? join(outDir, "mac-arm64", "Clover.app", "Contents", "Resources") : join(outDir, "win-unpacked", "resources");
      const plugins = bundledPluginsProblems(resources, manifest, existsSync, walkTree);
      for (const p of plugins) console.error(`release/build: ${p}`);
      if (plugins.length > 0) return 1;
    }

    if (a.sign && a.os === "mac") {
      const dmgName = `Clover-${version}.dmg`;
      const dmg = join(outDir, dmgName);
      must("sign the dmg", codesignDmgArgs(dmg, process.env.CLOVER_MAC_IDENTITY!), outDir);
      must("notarize the dmg", notarizeArgs(dmg, process.env.APPLE_KEYCHAIN_PROFILE!), outDir);
      must("staple the dmg", ["xcrun", "stapler", "staple", dmg], outDir);
      // The staple changed the dmg's bytes: its entry in each update file is measured again.
      for (const f of readdirSync(outDir).filter((n) => n.endsWith("-mac.yml"))) {
        const path = join(outDir, f);
        const info = parseUpdateInfo(readFileSync(path, "utf8"));
        if (info.files.some((e) => e.url === dmgName)) writeFileSync(path, formatUpdateInfo(refreshEntry(info, dmgName, readFileSync(dmg))));
      }
      rmSync(`${dmg}.blockmap`, { force: true });
      const problems = verifyMac(outDir, version, identityTeam(process.env.CLOVER_MAC_IDENTITY!), root);
      for (const p of problems) console.error(`release/build: ${p}`);
      if (problems.length > 0) return 1;
    }
    if (a.sign && a.os === "win") {
      const problems = verifyWin(outDir, version, process.env.CLOVER_WIN_PUBLISHER!);
      for (const p of problems) console.error(`release/build: ${p}`);
      if (problems.length > 0) return 1;
    }
    writeCoreAssets(outDir, version, a.os, a.channel, daemonInApp(outDir, a.os));
    writePluginBunAssets(outDir, a.os, a.channel, join(dirname(daemonInApp(outDir, a.os)), bundledFiles(target)[0]!));
    // The bundled plugins for a server: the app's resources/plugins (held to the core's manifest above), packed.
    writePluginsAssets(outDir, version, a.os, a.channel, join(dirname(dirname(daemonInApp(outDir, a.os))), "plugins"));
    writeBuildCommit(outDir, a.os, commit);
    writeServedCopies(outDir, a.channel, [a.os]);

    const problems: string[] = [];
    for (const name of expectedArtifacts(version, a.os, a.channel)) if (!existsSync(join(outDir, name))) problems.push(`${name} is missing from ${outDir}`);
    for (const ch of a.channel === "latest" ? (["latest", "beta"] as const) : (["beta"] as const)) {
      const path = join(outDir, feedFile(ch, a.os));
      if (!existsSync(path)) continue;
      const read = (n: string) => (existsSync(join(outDir, n)) ? new Uint8Array(readFileSync(join(outDir, n))) : undefined);
      problems.push(...checkUpdateInfo(parseUpdateInfo(readFileSync(path, "utf8")), version, read).map((p) => `${feedFile(ch, a.os)}: ${p}`));
      const core = coreFeedFile(ch, CORE_TARGET[a.os]);
      if (existsSync(join(outDir, core))) problems.push(...checkCoreFeed(readFileSync(join(outDir, core), "utf8"), version, read).map((p) => `${core}: ${p}`));
      const bun = pluginBunFeedFile(ch, CORE_TARGET[a.os]);
      if (existsSync(join(outDir, bun))) problems.push(...checkPluginBunFeed(readFileSync(join(outDir, bun), "utf8"), read).map((p) => `${bun}: ${p}`));
      const plugins = pluginsFeedFile(ch, CORE_TARGET[a.os]);
      if (existsSync(join(outDir, plugins))) problems.push(...checkPluginsFeed(readFileSync(join(outDir, plugins), "utf8"), version, read).map((p) => `${plugins}: ${p}`));
    }
    for (const p of problems) console.error(`release/build: ${p}`);
    if (problems.length > 0) return 1;
    // The identity scan over everything built (scripts/release/name-scan.ts): fails closed on a signed release.
    const scan = runNameScan(outDir, { required: a.sign });
    console.log(scan.ran ? `release/build: identity scan: ${scan.scanned}/${scan.total} files, no hit` : `release/build: identity scan skipped (${scan.reason}); a signed release never skips it`);
    const shipped = readdirSync(outDir).filter((n) => /\.(dmg|zip|exe|yml|blockmap)$/.test(n) || n.startsWith("clover-core-") || n.startsWith("clover-plugin-bun-") || n.startsWith("clover-plugins-")).sort();
    writeFileSync(join(outDir, `SHA256SUMS-${a.os}.txt`), shipped.map((n) => `${sha256(join(outDir, n))}  ${n}`).join("\n") + "\n");
    console.log(`release/build: ${shipped.join(", ")} in ${outDir}${a.sign ? "" : " (unsigned)"}`);
    return 0;
  } catch (err) {
    console.error(`release/build: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
