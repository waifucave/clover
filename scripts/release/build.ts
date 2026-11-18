// A release build for macOS or Windows (plan §4 M-M2): BOTH apps of one release (lane PK; spec §3.1 "One release for
// everything", R4), MOSS Code and MOSS, each with the same daemon, link sidecar, bundled tree and (macOS) host helper inside,
// their installers and their update files for a channel, in apps/desktop/out/dist/ (MOSS's beside MOSS Code's, its update
// files under MOSS's own names, `moss-latest-mac.yml`: scripts/release/two-apps.ts). There is no flag that builds one app
// alone: both package.json versions must be VERSION's before anything is built, and after packaging the two apps' engine,
// tree and host helper are checked byte for byte the same. Linux's release build is scripts/build-packages.ts with the same
// --channel (MOSS Code only, so far).
//
//   bun scripts/release/build.ts [--channel latest|beta] [--sign [--no-notarize] | --sign-dev | --test-build] [--dry-run]
//
// --sign --no-notarize (macOS only) is the owner's try on this Mac: --sign's Developer ID signing, hardened runtime and
// checks, with MOSS_MAC_IDENTITY alone, NEVER notarized or stapled (a locally built app carries no quarantine, so
// Gatekeeper asks for no ticket, and the daemon's caller check needs the signature, not notarization). It writes no
// update files at all (no app, core, plugin Bun or plugins feed, no served copies; electron-builder's are removed), so
// nothing that looks like an update exists for it, and publish refuses it (no stapled dmg, no update files). It goes to
// apps/desktop/out/sign-only (never out/dist: the build empties its folder first, and an unpublished release sitting in
// out/dist stays untouched), and its BUILD-COMMIT-mac.txt carries the sign-only mark on its second line
// (lib.ts's SIGN_ONLY_LABEL), which the release step refuses by name. The dmg keeps the release's name.
//
// It runs on the OS it builds for (macOS on Apple silicon, Windows x64):
//   1. builds the app (apps/desktop's `build`); stages the bundled plugins (the committed files under plugins/) in
//      apps/desktop/out/plugins and measures them; builds the daemon (scripts/build-daemon.ts) with that manifest
//      compiled in, and moss-link (cargo)
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
//      and checks the app and the app inside the update zip (every signature, the app's against MOSS's requirement:
//      its identifier and team, the daemon's and the sidecar's
//      entitlements, the seal, Gatekeeper's verdict, the staple) and the dmg (its signature, its staple, Gatekeeper
//      on opening it); on Windows, the Authenticode signatures of the installer, MOSS Code.exe, moss-core.exe,
//      moss-link.exe and moss-plugin-bun.exe, by the publisher
//   6. copies the daemon out of the app (signed with it, on a signed build) as moss-core-<version>-<target>, with its
//      update file for each channel served (lib.ts's `writeCoreAssets`), for a server's daemon to update itself from;
//      plugin Bun beside it likewise; and the app's resources/plugins packed as moss-plugins-<version>-<target>.tar.gz
//      with its update file (`writePluginsAssets`), the tree that core's manifest names
//   7. runs the identity scan over everything in out/dist (scripts/release/name-scan.ts; a signed release fails
//      closed without the owner's guard), then records the commit it built (BUILD-COMMIT-<os>.txt; every build needs a fully clean checkout), on latest copies
//      the update files to the beta names (lib.ts's `writeServedCopies`), and checks the installers and update files are all there, each update file against the files it names, and
//      writes SHA256SUMS-<os>.txt beside them
//
// Signing is the owner's: without --sign the build is unsigned (CI's release workflow), whatever the environment
// holds, and electron-builder is told not to look for an identity. With --sign every input must be there, or it
// stops before building:
//   macOS     MOSS_MAC_IDENTITY     the identity's full name, "Developer ID Application: <name> (<TEAMID>)", in the
//                                     login keychain; its team must be MOSS's (MOSS_TEAM_ID)
//             APPLE_KEYCHAIN_PROFILE  notarytool's stored profile (`xcrun notarytool store-credentials`)
//   Windows   WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD   the Authenticode certificate, as electron-builder takes it
//             MOSS_WIN_PUBLISHER    its subject's common name, which electron-updater checks each update against
// None is printed, logged or written anywhere. Nothing is published.
//
// --sign-dev (macOS only) is the owner's alpha, before the Developer ID is set up: the same build on the beta channel
// (an alpha is a beta; there is no third channel), signed with the owner's Apple Development identity of MOSS's team
// (found in the login keychain by its certificate's team, `security find-identity`, never by name; or
// MOSS_MAC_DEV_IDENTITY, its SHA-1, looked up in MOSS_MAC_DEV_KEYCHAIN when that names a keychain file: for that
// build only, by codesign's --keychain and electron-builder's CSC_KEYCHAIN, never the user's search list) and not notarized. The staged binaries get each its own identifier and
// entitlements and a designated requirement on MOSS's team (lib.ts's `codesignDevArgs`), which the Keychain items and
// plugin Bun's check accept and a later Developer ID build meets too; electron-builder signs the app with the same
// identity. The checks are the signed build's but for the timestamp, the staple and Gatekeeper's verdict: it installs
// on the Mac that built it (a downloaded copy would be stopped by Gatekeeper), and the owner's publish step refuses it
// (it requires a stapled dmg).
//
// --test-build (macOS only) is a test-marked build (scripts/test-build.ts) for the acceptance script: --sign's
// Developer ID signing (the daemon's caller check needs it), with MOSS_MAC_IDENTITY alone, NEVER notarized or
// stapled. Its core and app carry the compile-time marker: the core takes a throwaway keychain file and a temp home and
// refuses to start without them, and the app uses Chromium's mock keychain and an answer key in memory. It goes to
// apps/desktop/out/test-build (never out/dist, so a real release there is untouched and publish's `--from` never meets
// it), writes no update files (no core, plugin Bun or plugins feed, no served copies; electron-builder's are removed),
// and its BUILD-COMMIT-mac.txt names it a test build, which the release step refuses. Every build checks the marker in
// the staged core and the app's app.asar: a real build carries neither the label nor the test-only code, a test build
// both.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asarFiles, asarMarkerProblems, releaseMarkerProblems, testBuildMarkerProblems } from "../test-build";
import { daemonOutput, runScriptLine, type DaemonTarget } from "../build-daemon";
import { MOSS_TEAM_ID } from "../../packages/core/src/auth/app-token-acl";
import { BUNDLED_MANIFEST_FILE, type BundledManifest } from "../../packages/core/src/bundled-plugins-dir";
import { MOSS_APP_IDENTIFIER as MOSS_APP_IDENTIFIERS, MOSS_PROGRAM_IDENTIFIERS, appRequirement } from "../../packages/core/src/bundled-identities";
import { hostRequirement } from "../../packages/core/src/host/world";
import { CODE_APP, HOST_HELPER, HOST_HELPER_STASH, MOSS_APP as MOSS_BOTS_APP, MOSS_TEST_BUILD_ARTIFACT_ARGS, mossArtifacts, mossFeedFile, mossInstallers, mossServedCopies, mossTestBuildArtifacts, moveMossOutputs, oneVersionProblems, samePayloadProblems, type ReleaseApp } from "./two-apps";
import { LINK_BUILD, LINK_OUTPUT, linkBuildEnv } from "../build-packages";
import { bundledBinaryProblems, bundledFiles } from "../bundled-binaries";
import { sealProblems } from "../seal-bun-doors";
import { runNameScan } from "./name-scan";
import { resolveDevSigningIdentity } from "../dev-daemon-lib";
import { buildBundledPlugins, bundledPluginsProblems, STAGED_PLUGINS, walkTree, writeStagedManifest } from "./bundled-plugins";
import {
  authenticodeCommand, authenticodeProblems, buildCommitFile, channelArgs, checkCoreFeed, checkoutCommit, checkUpdateInfo, codesignArgs, codesignDmgArgs, CORE_TARGET, entitlementsIn,
  expectedArtifacts, feedFile, formatUpdateInfo, identityTeam, parseEntitlementKeys, writeBuildCommit,
  notarizeArgs, parseChannel, parseCodesignDisplay, parseUpdateInfo, refreshEntry, RESOURCE_BINARIES, signatureProblems, codesignDevArgs, teamRequirement,
  checkPluginBunFeed, checkPluginsFeed, writeCoreAssets, writePluginBunAssets, writePluginsAssets, writeServedCopies, type Channel,
} from "./lib";
import { coreFeedFile, pluginBunFeedFile, pluginsFeedFile } from "../../packages/update-feed/src/index";

export type BuildOs = "mac" | "win";

/** The app's bundle identifier (apps/desktop/electron-builder.yml's appId). */
export const MOSS_APP_IDENTIFIER = MOSS_APP_IDENTIFIERS.dist;
/** The code requirement the signed MOSS Code.app must satisfy: its identifier, Apple's Developer ID chain, MOSS's team.
 *  The same string a Developer ID daemon checks an `app` connection's peer against (`bundled-identities.ts`'s
 *  `appRequirement`). The owner's --sign-dev alpha is checked without the Developer ID clauses (`MOSS_APP_DEV_SIGNED_REQUIREMENT`). */
export const MOSS_APP_REQUIREMENT = appRequirement("dist", MOSS_TEAM_ID);
/** The --sign-dev alpha's app: the dist identifier, Apple's chain and MOSS's team (an Apple Development identity). */
export const MOSS_APP_DEV_SIGNED_REQUIREMENT = appRequirement("dist", MOSS_TEAM_ID, false);
/** MOSS's (the bots app's, `com.waifucave.moss`): the same rule under its own identifier, the one the engine checks MOSS's
 *  `app` hello against (`appPeerRequirement(…, "moss")`). */
export const MOSS_BOTS_REQUIREMENT = appRequirement("dist", MOSS_TEAM_ID, true, "moss");
export const MOSS_BOTS_DEV_SIGNED_REQUIREMENT = appRequirement("dist", MOSS_TEAM_ID, false, "moss");
/** The requirement an app is checked against after it is signed. */
function requirementOf(app: ReleaseApp, dev: boolean): string {
  return app.program === "moss" ? (dev ? MOSS_BOTS_DEV_SIGNED_REQUIREMENT : MOSS_BOTS_REQUIREMENT) : (dev ? MOSS_APP_DEV_SIGNED_REQUIREMENT : MOSS_APP_REQUIREMENT);
}

export interface ReleaseBuildArgs {
  os: BuildOs;
  channel: Channel;
  sign: boolean;
  /** The owner's dev-signed, unnotarized alpha (macOS, beta channel). */
  signDev: boolean;
  /** A test-marked build (scripts/test-build.ts): Developer ID signed (`sign` is true), never notarized, no feed. */
  testBuild?: boolean;
  /** `--sign --no-notarize`: Developer ID signed (`sign` is true), never notarized or stapled, no feed. */
  signOnly?: boolean;
  dryRun: boolean;
}

/** The OS this machine builds for, or undefined (only Apple silicon Macs and x64 Windows build releases here). */
export function buildOsFor(platform: string, arch: string): BuildOs | undefined {
  if (platform === "darwin" && arch === "arm64") return "mac";
  if (platform === "win32" && arch === "x64") return "win";
  return undefined;
}

export function parseReleaseBuildArgs(argv: readonly string[], platform: string, arch: string): ReleaseBuildArgs {
  let channel: Channel | undefined;
  let sign = false;
  let signDev = false;
  let testBuild = false;
  let noNotarize = false;
  let dryRun = false;
  let os: BuildOs | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--sign") sign = true;
    else if (a === "--test-build") testBuild = true;
    else if (a === "--no-notarize") noNotarize = true;
    else if (a === "--sign-dev") signDev = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--channel") channel = parseChannel(argv[++i]);
    else if (a.startsWith("--channel=")) channel = parseChannel(a.slice("--channel=".length));
    // A dry run may print another OS's steps.
    else if (a === "--os" || a.startsWith("--os=")) {
      const v = a === "--os" ? argv[++i] : a.slice("--os=".length);
      if (v !== "mac" && v !== "win") throw new Error(`--os takes mac or win (not ${String(v)})`);
      os = v;
    } else throw new Error(`unknown argument ${a} (usage: release/build [--channel latest|beta] [--sign [--no-notarize] | --sign-dev | --test-build] [--dry-run])`);
  }
  const host = buildOsFor(platform, arch);
  if (os !== undefined && os !== host && !dryRun) throw new Error(`this machine builds ${host ?? "no release"}: --os ${os} is for a dry run elsewhere`);
  os ??= host;
  if (os === undefined) throw new Error(`a release builds on an Apple silicon Mac or on x64 Windows (this is ${platform}-${arch}); Linux's is scripts/build-packages.ts`);
  if (signDev) {
    if (sign) throw new Error("--sign-dev is the owner's dev-signed alpha, --sign the Developer ID release: one or the other");
    if (os !== "mac") throw new Error("--sign-dev is for macOS (an Apple Development identity)");
    // An alpha is a beta (the controller's ruling): no third channel, and never latest.
    if (channel === "latest") throw new Error("--sign-dev builds the beta channel (an alpha is a beta), never latest");
    channel = "beta";
  }
  if (noNotarize) {
    if (!sign || signDev || testBuild) throw new Error("--no-notarize goes with --sign alone (the Developer ID build, signed but not notarized)");
    if (os !== "mac") throw new Error("--no-notarize is for macOS (notarization is Apple's)");
    // Signed like --sign, never notarized; no feed, so its channel names nothing.
    return { os, channel: channel ?? "beta", sign: true, signDev: false, signOnly: true, dryRun };
  }
  if (testBuild) {
    if (sign || signDev) throw new Error("--test-build signs with the Developer ID itself and is never notarized: not with --sign or --sign-dev");
    if (os !== "mac") throw new Error("--test-build is for macOS (the Developer ID signed app the caller check takes)");
    // Developer ID signed like --sign, never notarized; no feed, so its channel names nothing.
    return { os, channel: channel ?? "beta", sign: true, signDev: false, testBuild: true, dryRun };
  }
  return { os, channel: channel ?? "latest", sign, signDev, dryRun };
}

/** The identity --sign-dev signs with, by its SHA-1. */
export interface DevIdentity { hash: string; name: string }

/**
 * The owner's Apple Development identity of MOSS's team, for --sign-dev: MOSS_MAC_DEV_IDENTITY (a SHA-1) when
 * set, else the one `security find-identity -v -p codesigning` lists whose certificate's OU is MOSS's team
 * (dev-daemon-lib.ts's rule: an Apple Development certificate's name holds the person, not the team). A Developer ID
 * identity is refused: that's --sign's, with notarization. `subjectOf` answers a certificate's subject line.
 */
export function devSigningIdentity(input: { identitiesOutput: string; subjectOf: (name: string) => string | undefined; override?: string; teamId?: string }): DevIdentity {
  const override = input.override?.trim();
  if (override !== undefined && override !== "") {
    if (!/^[0-9A-F]{40}$/i.test(override)) throw new Error("MOSS_MAC_DEV_IDENTITY is an identity's SHA-1 (security find-identity -v -p codesigning), 40 hex digits");
    return { hash: override.toUpperCase(), name: "(MOSS_MAC_DEV_IDENTITY)" };
  }
  const chosen = resolveDevSigningIdentity({ identitiesOutput: input.identitiesOutput, teamId: input.teamId ?? MOSS_TEAM_ID, subjectOf: input.subjectOf });
  if (!chosen.name.startsWith("Apple Development:")) {
    // Its name isn't printed: a certificate's name is a person's or an organisation's.
    throw new Error(`team ${input.teamId ?? MOSS_TEAM_ID}'s only identity here (SHA-1 ${chosen.hash.toUpperCase()}) isn't an Apple Development one: a Developer ID builds with --sign (notarized)`);
  }
  return { hash: chosen.hash.toUpperCase(), name: chosen.name };
}

/** `devSigningIdentity` on this Mac's login keychain (read-only: find-identity and find-certificate). */
function liveDevSigningIdentity(): DevIdentity {
  const out = (cmd: string, args: string[], input?: string): { status: number; stdout: string } => {
    const r = spawnSync(cmd, args, { encoding: "utf8", ...(input === undefined ? {} : { input }) });
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };
  return devSigningIdentity({
    identitiesOutput: out("security", ["find-identity", "-v", "-p", "codesigning"]).stdout,
    override: process.env.MOSS_MAC_DEV_IDENTITY,
    subjectOf: (name) => {
      const pem = out("security", ["find-certificate", "-c", name, "-p"]).stdout;
      if (pem === "") return undefined;
      const r = out("openssl", ["x509", "-noout", "-subject"], pem);
      return r.status === 0 ? r.stdout : undefined;
    },
  });
}

/** What --sign needs from the environment, or the names missing (never their values). */
export function signingInputs(os: BuildOs, env: Record<string, string | undefined>, notNotarized = false): { missing: string[]; problems: string[] } {
  // A test build or a sign-only one is never notarized: it needs no notarytool profile.
  const need = os === "mac" ? (notNotarized ? ["MOSS_MAC_IDENTITY"] : ["MOSS_MAC_IDENTITY", "APPLE_KEYCHAIN_PROFILE"]) : ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "MOSS_WIN_PUBLISHER"];
  const missing = need.filter((k) => !env[k]);
  const problems: string[] = [];
  if (os === "mac" && env.MOSS_MAC_IDENTITY) {
    try {
      // The team must be MOSS's: the Keychain items' requirement for the core, and lane B's for plugin Bun
      // (`anchor apple generic and identifier … and certificate leaf[subject.OU] = MOSS_TEAM_ID`), name it.
      const team = identityTeam(env.MOSS_MAC_IDENTITY);
      if (team !== MOSS_TEAM_ID) problems.push(`MOSS_MAC_IDENTITY is team ${team}, not MOSS's ${MOSS_TEAM_ID}: the core's Keychain items and plugin Bun's check would refuse what it signs`);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return { missing, problems };
}

export const DAEMON_TARGET: Readonly<Record<BuildOs, DaemonTarget>> = { mac: "darwin-arm64", win: "windows-x64" };

/** The daemon inside the built app (the one the release ships, signed with the app on a signed build). */
export function daemonInApp(outDir: string, os: BuildOs, app: ReleaseApp = CODE_APP): string {
  return join(resourcesIn(outDir, os, app), "daemon", os === "mac" ? "moss-core" : "moss-core.exe");
}

/** A built app's resources folder: `<out>/mac-arm64/<App>.app/Contents/Resources`, or `<out>/win-unpacked/resources`. */
export function resourcesIn(outDir: string, os: BuildOs, app: ReleaseApp = CODE_APP): string {
  return os === "mac" ? join(outDir, "mac-arm64", `${app.product}.app`, "Contents", "Resources") : join(outDir, "win-unpacked", "resources");
}

/** The identity as electron-builder's `mac.identity` takes it: the full name less "Developer ID Application: ". */
export function builderIdentity(identity: string): string {
  const name = identity.replace(/^Developer ID Application: /, "");
  if (name === "" || name === identity) throw new Error("MOSS_MAC_IDENTITY is a Developer ID Application identity named in full");
  return name;
}

/** electron-builder's command for the OS's release, run in apps/desktop. Secrets reach it through its environment only.
 *  --sign-dev names the identity by its SHA-1 (`devIdentity`), with no timestamp and no notarization. */
export function releaseBuilderArgs(a: ReleaseBuildArgs, env: Record<string, string | undefined>, devIdentity?: string, app: ReleaseApp = CODE_APP): string[] {
  const base = a.os === "mac" ? ["electron-builder", "--mac", "dmg", "zip", "--arm64"] : ["electron-builder", "--win", "nsis", "--x64"];
  const out = [...base, "--publish", "never", ...channelArgs(a.channel)];
  if (a.signDev) {
    if (devIdentity === undefined || !/^[0-9A-F]{40}$/i.test(devIdentity)) throw new Error("--sign-dev needs its identity's SHA-1");
    return [...out, `-c.mac.identity=${devIdentity}`, "-c.mac.notarize=false", "-c.mac.timestamp=none"];
  }
  if (!a.sign) return out;
  // electron-builder takes the identity without its "Developer ID Application: " prefix (it refuses one that has it,
  // and picks the certificate type itself); codesign takes the full name.
  // A test build: the Developer ID, never notarized, into its own folder.
  if (a.os === "mac" && a.testBuild) return [...out, `-c.mac.identity=${builderIdentity(env.MOSS_MAC_IDENTITY ?? "")}`, "-c.mac.notarize=false", `-c.directories.output=${TEST_BUILD_OUT}`, ...(app.program === "moss" ? MOSS_TEST_BUILD_ARTIFACT_ARGS : TEST_BUILD_ARTIFACT_ARGS)];
  // A sign-only build: the Developer ID, never notarized, into its own folder.
  if (a.os === "mac" && a.signOnly) return [...out, `-c.mac.identity=${builderIdentity(env.MOSS_MAC_IDENTITY ?? "")}`, "-c.mac.notarize=false", `-c.directories.output=${SIGN_ONLY_OUT}`];
  if (a.os === "mac") return [...out, `-c.mac.identity=${builderIdentity(env.MOSS_MAC_IDENTITY ?? "")}`, "-c.mac.notarize=true"];
  return [...out, "-c.win.forceCodeSigning=true", `-c.win.signtoolOptions.publisherName=${env.MOSS_WIN_PUBLISHER}`];
}

/** What a sign-only build (`--sign --no-notarize`) leaves in `SIGN_ONLY_OUT`: the app's dmg and zip, the checksums and
 *  the commit (marked sign-only), and no update file of any kind. */
export function signOnlyOutputs(version: string): string[] {
  return [`MOSS-Code-${version}.dmg`, `MOSS-Code-${version}-mac.zip`, "SHA256SUMS-mac.txt", buildCommitFile("mac")];
}

/** Where a test build goes, relative to apps/desktop: never out/dist, where a real release is built and published from. */
export const TEST_BUILD_OUT = "out/test-build";

/** Where a sign-only build goes, relative to apps/desktop: never out/dist either (its wipe would take an unpublished
 *  release sitting there). */
export const SIGN_ONLY_OUT = "out/sign-only";

/** A test build's dmg and zip carry TEST in their names (electron-builder's artifactName; the zip takes the mac
 *  section's), so nobody takes one for a release. */
export const TEST_BUILD_ARTIFACT_ARGS = ["-c.dmg.artifactName=MOSS-Code-${version}-TEST.${ext}", "-c.mac.artifactName=MOSS-Code-${version}-TEST-mac.${ext}"] as const;

/** A test build's dmg and zip, as `TEST_BUILD_ARTIFACT_ARGS` names them. */
export function testBuildArtifacts(version: string): { dmg: string; zip: string } {
  return { dmg: `MOSS-Code-${version}-TEST.dmg`, zip: `MOSS-Code-${version}-TEST-mac.zip` };
}

/** What notarization reads from the environment (notarytool's profile, the Apple ID and API key forms). */
export const NOTARIZE_ENV = ["APPLE_KEYCHAIN_PROFILE", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"] as const;

/** The app's main process bundle inside a built app (`app.asar`, which carries out/main/index.js uncompressed). */
export function appAsar(outDir: string, os: BuildOs, app: ReleaseApp = CODE_APP): string {
  return join(resourcesIn(outDir, os, app), "app.asar");
}

/** The environment electron-builder runs with: an unsigned build never looks for an identity or a certificate, and a
 *  dev-signed one only for the identity it is named (nor anything notarization or a certificate file would use). */
export function builderEnv(a: ReleaseBuildArgs, env: Record<string, string | undefined>): Record<string, string | undefined> {
  // A test build or a sign-only one signs with the Developer ID but never reaches notarization: none of its inputs reach
  // electron-builder.
  if (a.testBuild || a.signOnly) {
    const out: Record<string, string | undefined> = { ...env };
    for (const k of NOTARIZE_ENV) delete out[k];
    return out;
  }
  if (a.sign && !a.signDev) return env;
  const out: Record<string, string | undefined> = { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const k of ["CSC_KEYCHAIN", "MOSS_MAC_DEV_KEYCHAIN", "MOSS_MAC_IDENTITY", "MOSS_WIN_PUBLISHER", "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "APPLE_KEYCHAIN_PROFILE", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) delete out[k];
  // A dev-signed build's identity may sit in a keychain named for it alone (electron-builder's CSC_KEYCHAIN).
  if (a.signDev && env.MOSS_MAC_DEV_KEYCHAIN) out.CSC_KEYCHAIN = env.MOSS_MAC_DEV_KEYCHAIN;
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

/** Whether `bytes` start a Mach-O file (thin, either byte order, 32 or 64 bit, or universal with 32- or 64-bit
 *  offsets). */
export function isMachO(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic);
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

/** The Mach-O files packed INSIDE an app.asar (by their bytes, whatever their names): each would be loaded from a
 *  temporary copy with its build-time signature, which the hardened runtime's library validation refuses. A release
 *  has none (electron-builder.yml's asarUnpack keeps the app's native add-ons out of the asar, where they're signed). */
export function packedMachO(files: ReadonlyMap<string, Uint8Array>): string[] {
  return [...files].filter(([, bytes]) => isMachO(bytes)).map(([path]) => path).sort();
}

/** A bundled plugin's native file's signing identifier: MOSS's prefix and its path, as letters, digits and dots. */
export function nativeIdentifier(rel: string): string {
  return `com.waifucave.moss.core.plugin.${rel.replace(/[^A-Za-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "")}`;
}

/** One signed app's checks: its signatures, the resources' entitlements, its seal, Gatekeeper's verdict and its staple. */
function verifyMacApp(label: string, app: string, teamId: string, root: string, cwd: string, dev = false, notarized = !dev, requirement: string = dev ? MOSS_APP_DEV_SIGNED_REQUIREMENT : MOSS_APP_REQUIREMENT): string[] {
  const problems: string[] = [];
  const display = (path: string) => parseCodesignDisplay(run(["codesign", "-dvvv", path], cwd).out);
  problems.push(...signatureProblems(label, display(app), teamId, undefined, { dev }));
  for (const b of RESOURCE_BINARIES) {
    const path = join(app, "Contents", "Resources", "daemon", b.file);
    problems.push(...signatureProblems(`${label}'s ${b.file}`, display(path), teamId, b.identifier, { dev, restrict: b.restrict }));
    // A dev-signed binary's designated requirement is the team one it was given (lib.ts's codesignDevArgs).
    if (dev) {
      const dr = /^designated => (.+)$/m.exec(run(["codesign", "-d", "-r-", path], cwd).out)?.[1]?.trim();
      if (dr !== teamRequirement(b.identifier, teamId)) problems.push(`${label}'s ${b.file}'s designated requirement is ${dr ?? "(none)"}, not MOSS's team's`);
    }
    // Exactly the entitlements it was meant to have: the daemon's file, and none for the sidecar.
    const have = parseEntitlementKeys(run(["codesign", "-d", "--entitlements", "-", "--xml", path], cwd).out);
    const want = b.entitlements === undefined ? [] : entitlementsIn(readFileSync(join(root, b.entitlements), "utf8"));
    if (have.join(",") !== want.join(",")) problems.push(`${label}'s ${b.file} has the entitlements [${have.join(", ")}], not [${want.join(", ")}]`);
  }
  // The bundled plugins' native code, signed before the manifest was measured (and left alone by electron-builder).
  const plugins = join(app, "Contents", "Resources", "plugins");
  if (existsSync(plugins)) {
    for (const rel of machOFiles(plugins)) {
      const path = join(plugins, rel);
      problems.push(...signatureProblems(`${label}'s plugins/${rel}`, display(path), teamId, nativeIdentifier(rel), { dev }));
      if (dev) {
        const dr = /^designated => (.+)$/m.exec(run(["codesign", "-d", "-r-", path], cwd).out)?.[1]?.trim();
        if (dr !== teamRequirement(nativeIdentifier(rel), teamId)) problems.push(`${label}'s plugins/${rel}'s designated requirement is ${dr ?? "(none)"}, not MOSS's team's`);
      }
    }
  }
  // The app's own native add-ons: none packed inside app.asar, and each one in app.asar.unpacked signed by the team
  // (library validation loads only code of the app's own team into it).
  const resources = join(app, "Contents", "Resources");
  for (const rel of packedMachO(asarFiles(new Uint8Array(readFileSync(join(resources, "app.asar")))))) {
    problems.push(`${label}'s app.asar packs native code (${rel}): it would load from an unsigned temporary copy, which library validation refuses; list it in electron-builder.yml's asarUnpack`);
  }
  const unpacked = join(resources, "app.asar.unpacked");
  if (existsSync(unpacked)) {
    for (const rel of machOFiles(unpacked)) problems.push(...signatureProblems(`${label}'s app.asar.unpacked/${rel}`, display(join(unpacked, rel)), teamId, undefined, { dev }));
  }
  const deep = run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", `-R=${requirement}`, app], cwd);
  if (deep.status !== 0) problems.push(`codesign --verify --deep --strict against MOSS's requirement refuses ${label}: ${deep.out.trim().slice(0, 400)}`);
  // The host helper the engine starts from this app: the very check the engine makes before it starts it (packages/core/src/host/
  // world.ts `hostRequirement`: the host's fixed identifier, Apple's chain, MOSS's team, a Developer ID leaf unless dev-signed).
  const helper = join(app, "Contents", "Frameworks", HOST_HELPER);
  if (!existsSync(helper)) problems.push(`${label} carries no host helper (${HOST_HELPER})`);
  else {
    const host = run(["codesign", "--verify", "--strict", "--verbose=2", `-R=${hostRequirement("dist", teamId, !dev)}`, helper], cwd);
    if (host.status !== 0) problems.push(`${label}'s host helper fails the engine's host requirement: ${host.out.trim().slice(0, 400)}`);
  }
  // Nothing notarizes a dev-signed alpha or a test build: no staple, and Gatekeeper would refuse a downloaded copy.
  if (!notarized) return problems;
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
  const problems: string[] = [];
  for (const app of [CODE_APP, MOSS_BOTS_APP]) {
    const dmg = join(outDir, `${app.artifact}-${version}.dmg`);
    problems.push(...verifyMacApp(`${app.product}.app`, join(outDir, "mac-arm64", `${app.product}.app`), teamId, root, outDir, false, true, requirementOf(app, false)));
    const unzipped = mkdtempSync(join(tmpdir(), "moss-release-zip-"));
    try {
      if (run(["ditto", "-x", "-k", join(outDir, `${app.artifact}-${version}-mac.zip`), unzipped], outDir).status !== 0) problems.push(`${app.product}'s update zip doesn't unpack`);
      else problems.push(...verifyMacApp(`the update zip's ${app.product}.app`, join(unzipped, `${app.product}.app`), teamId, root, outDir, false, true, requirementOf(app, false)));
    } finally {
      rmSync(unzipped, { recursive: true, force: true });
    }
    const dmgSig = parseCodesignDisplay(run(["codesign", "-dvvv", dmg], outDir).out);
    if (dmgSig.adhoc || dmgSig.teamId !== teamId) problems.push(`${app.product}'s dmg is not signed by team ${teamId}`);
    if (run(["xcrun", "stapler", "validate", dmg], outDir).status !== 0) problems.push(`${app.product}'s dmg has no notarization staple`);
    const open = run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg], outDir);
    if (open.status !== 0 || !/source=Notarized Developer ID/.test(open.out)) problems.push(`Gatekeeper doesn't accept ${app.product}'s dmg as notarized: ${open.out.trim().slice(0, 400)}`);
  }
  return problems;
}

/** A test build's or a sign-only build's checks: the Developer ID app and the app inside the zip, as the release's but
 *  for notarization (it is never notarized: no Gatekeeper verdict, no staple); a sign-only build's dmg too, by its
 *  signature. */
function verifyMacTest(outDir: string, version: string, teamId: string, root: string, signOnly = false): string[] {
  const problems: string[] = [];
  for (const app of [CODE_APP, MOSS_BOTS_APP]) {
    problems.push(...verifyMacApp(`${app.product}.app`, join(outDir, "mac-arm64", `${app.product}.app`), teamId, root, outDir, false, false, requirementOf(app, false)));
    const unzipped = mkdtempSync(join(tmpdir(), "moss-release-zip-"));
    try {
      const zip = signOnly ? `${app.artifact}-${version}-mac.zip` : app.program === "moss" ? mossTestBuildArtifacts(version).zip : testBuildArtifacts(version).zip;
      if (run(["ditto", "-x", "-k", join(outDir, zip), unzipped], outDir).status !== 0) problems.push(`${zip} doesn't unpack`);
      else problems.push(...verifyMacApp(`the zip's ${app.product}.app`, join(unzipped, `${app.product}.app`), teamId, root, outDir, false, false, requirementOf(app, false)));
    } finally {
      rmSync(unzipped, { recursive: true, force: true });
    }
  }
  return problems;
}

/** The dev-signed alpha's checks: each app and the app inside its update zip, each as `verifyMacApp` in dev mode. */
function verifyMacDev(outDir: string, version: string, teamId: string, root: string): string[] {
  const problems: string[] = [];
  for (const app of [CODE_APP, MOSS_BOTS_APP]) {
    problems.push(...verifyMacApp(`${app.product}.app`, join(outDir, "mac-arm64", `${app.product}.app`), teamId, root, outDir, true, false, requirementOf(app, true)));
    const unzipped = mkdtempSync(join(tmpdir(), "moss-release-zip-"));
    try {
      if (run(["ditto", "-x", "-k", join(outDir, `${app.artifact}-${version}-mac.zip`), unzipped], outDir).status !== 0) problems.push(`${app.product}'s update zip doesn't unpack`);
      else problems.push(...verifyMacApp(`the update zip's ${app.product}.app`, join(unzipped, `${app.product}.app`), teamId, root, outDir, true, false, requirementOf(app, true)));
    } finally {
      rmSync(unzipped, { recursive: true, force: true });
    }
  }
  return problems;
}

/** The signed Windows release's checks: the installer, the app, and the daemon and sidecar beside it. */
function verifyWin(outDir: string, version: string, publisher: string, mossUnpacked?: string): string[] {
  const unpacked = join(outDir, "win-unpacked");
  const files = [
    [`MOSS-Setup-${version}.exe`, join(outDir, `MOSS-Setup-${version}.exe`)],
    ...(mossUnpacked !== undefined ? [["MOSS.exe", join(mossUnpacked, "MOSS.exe")] as const] : []),
    [`MOSS-Code-Setup-${version}.exe`, join(outDir, `MOSS-Code-Setup-${version}.exe`)],
    ["MOSS Code.exe", join(unpacked, "MOSS Code.exe")],
    ["moss-core.exe", join(unpacked, "resources", "daemon", "moss-core.exe")],
    ["moss-link.exe", join(unpacked, "resources", "daemon", "moss-link.exe")],
    ["moss-plugin-bun.exe", join(unpacked, "resources", "daemon", "moss-plugin-bun.exe")],
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
    const { missing, problems } = signingInputs(a.os, process.env, a.testBuild === true || a.signOnly === true);
    for (const m of missing) console.error(`release/build: --sign needs ${m} in the environment`);
    for (const p of problems) console.error(`release/build: ${p}`);
    if (missing.length + problems.length > 0) return 2;
  }
  let dev: DevIdentity | undefined;
  if (a.signDev) {
    try {
      dev = a.dryRun ? { hash: "0".repeat(40), name: "<the Apple Development identity>" } : liveDevSigningIdentity();
    } catch (err) {
      console.error(`release/build: --sign-dev: ${(err as Error).message}`);
      return 2;
    }
  }
  const desktop = join(root, "apps", "desktop");
  const mossDir = join(root, ...MOSS_BOTS_APP.dir.split("/"));
  const version = (JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { version: string }).version;
  // One release (R4): both apps' package.json say VERSION's release, or nothing is built.
  {
    const release = readFileSync(join(root, "VERSION"), "utf8").trim();
    const versionOf = (dir: string) => { try { return (JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as { version?: string }).version; } catch { return undefined; } };
    const problems = oneVersionProblems(release, { [CODE_APP.dir]: versionOf(CODE_APP.dir), [MOSS_BOTS_APP.dir]: versionOf(MOSS_BOTS_APP.dir) });
    for (const p of problems) console.error(`release/build: ${p}`);
    if (problems.length > 0) return 2;
  }
  const target = DAEMON_TARGET[a.os];
  const exe = a.os === "win" ? ".exe" : "";
  const builder = ["bun", "x", ...releaseBuilderArgs(a, process.env, dev?.hash)];
  const mossBuilder = ["bun", "x", ...releaseBuilderArgs(a, process.env, dev?.hash, MOSS_BOTS_APP)];
  const kind = a.testBuild ? "a test-marked build (Developer ID signed, never notarized: for the acceptance script)" : a.signOnly ? "signed, not notarized: for this Mac" : a.signDev ? "dev-signed (not notarized: for this Mac)" : a.sign ? "signed" : "unsigned";
  // Every build but the test twin compiles the app's main process as a release (the release define; its gate below).
  const appBuild = a.testBuild ? ["bun", "scripts/build.ts", "--test-build"] : ["bun", "scripts/build.ts", "--release"];
  const testFlag = a.testBuild ? " --test-build" : "";
  if (a.dryRun) {
    // The identity's name is not a secret, but a dry run has no need to print it.
    const shown = builder.map((c) => (c.startsWith("-c.mac.identity=") ? `-c.mac.identity=<${a.signDev ? "the Apple Development identity's SHA-1" : "MOSS_MAC_IDENTITY"}>` : c.startsWith("-c.win.signtoolOptions.publisherName=") ? "-c.win.signtoolOptions.publisherName=<MOSS_WIN_PUBLISHER>" : c));
    console.log(`release/build: ${a.os} ${version} on ${a.channel}, ${kind}`);
    console.log(`release/build: one release ${version}: apps/desktop and apps/moss both at VERSION's, or nothing is built`);
    console.log(`release/build: the app: (in apps/desktop) ${appBuild.join(" ")}`);
    console.log(`release/build: MOSS: (in apps/moss) ${appBuild.join(" ")}`);
    console.log(`release/build: the bundled plugins: plugins/ at HEAD built for ${target} into apps/desktop/${STAGED_PLUGINS.split("\\").join("/")}, measured into out/${BUNDLED_MANIFEST_FILE}`);
    console.log(`release/build: the daemon: bun scripts/build-daemon.ts --target ${target} --plugins-manifest apps/desktop/out/${BUNDLED_MANIFEST_FILE}${testFlag}`);
    console.log(`release/build: the link sidecar: ${LINK_BUILD.join(" ")}`);
    if (a.sign && a.os === "mac") console.log(`release/build: sign each Mach-O file of the staged plugins (their native addons) before measuring: ${codesignArgs("out/plugins/<file>", "<MOSS_MAC_IDENTITY>", nativeIdentifier("<file>")).join(" ")}`);
    if (a.sign && a.os === "mac") for (const b of RESOURCE_BINARIES) console.log(`release/build: sign ${b.file}: ${codesignArgs(`out/daemon/${b.file}`, "<MOSS_MAC_IDENTITY>", b.identifier, b.entitlements, { restrict: b.restrict }).join(" ")}`);
    if (a.signDev) console.log(`release/build: sign each Mach-O file of the staged plugins (their native addons) before measuring: ${codesignDevArgs("out/plugins/<file>", dev!.hash, nativeIdentifier("<file>"), MOSS_TEAM_ID).join(" ").replace(dev!.hash, "<SHA-1>")}`);
    if (a.signDev) for (const b of RESOURCE_BINARIES) console.log(`release/build: sign ${b.file}: ${codesignDevArgs(`out/daemon/${b.file}`, dev!.hash, b.identifier, MOSS_TEAM_ID, b.entitlements, undefined, { restrict: b.restrict }).join(" ").replace(dev!.hash, "<SHA-1>")}`);
    console.log(`release/build: package: (in apps/desktop, MOSS_HOST_HELPER_STASH=apps/desktop/${HOST_HELPER_STASH}) ${shown.join(" ")}`);
    console.log(`release/build: package MOSS from the same stage (the daemon, the tree, MOSS Code's host helper): (in apps/moss, MOSS_HOST_HELPER_STASH=apps/desktop/${HOST_HELPER_STASH}) ${mossBuilder.map((c) => (c.startsWith("-c.mac.identity=") ? "-c.mac.identity=<identity>" : c.startsWith("-c.win.signtoolOptions.publisherName=") ? "-c.win.signtoolOptions.publisherName=<MOSS_WIN_PUBLISHER>" : c)).join(" ")}`);
    console.log(`release/build: MOSS's outputs moved beside MOSS Code's (its update files as ${mossFeedFile(a.channel, a.os)}…); then the two apps' daemon/, plugins/ and ${a.os === "mac" ? `${HOST_HELPER}'s code are` : "are"} checked byte for byte the same`);
    if (a.testBuild) {
      console.log(`release/build: the dmg: sign; never notarized or stapled; no update files (electron-builder's removed); in apps/desktop/${TEST_BUILD_OUT}`);
      return 0;
    }
    if (a.signOnly) {
      console.log(`release/build: the dmg: sign; never notarized or stapled; no update files (electron-builder's removed); in apps/desktop/${SIGN_ONLY_OUT}`);
      return 0;
    }
    if (a.sign && a.os === "mac") for (const app of [CODE_APP, MOSS_BOTS_APP]) console.log(`release/build: ${app.product}'s dmg: sign, ${notarizeArgs(`${app.artifact}-${version}.dmg`, "<APPLE_KEYCHAIN_PROFILE>").join(" ")}, xcrun stapler staple`);
    console.log(`release/build: the daemon's own update: ${daemonInApp("out/dist", a.os)} as its release file, with its update files`);
    console.log(`release/build: expects ${[...expectedArtifacts(version, a.os, a.channel), ...mossArtifacts(version, a.os, a.channel)].join(", ")}`);
    return 0;
  }
  try {
    const outRel = a.testBuild ? TEST_BUILD_OUT : a.signOnly ? SIGN_ONLY_OUT : "out/dist";
    const outDir = join(desktop, ...outRel.split("/"));
    // MOSS's own electron-builder output (its update files carry MOSS Code's names until they are moved and renamed).
    const mossOut = join(mossDir, ...outRel.split("/"));
    const staged = join(desktop, "out", "daemon");
    const stash = join(desktop, ...HOST_HELPER_STASH.split("/"));
    // A release is of one commit, from a fully clean checkout of it (the build reads the whole tree).
    const commit = checkoutCommit(root);
    rmSync(outDir, { recursive: true, force: true });
    rmSync(mossOut, { recursive: true, force: true });
    rmSync(stash, { recursive: true, force: true });
    must("the app", appBuild, desktop);
    must("MOSS", appBuild, mossDir);
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
          must(`sign the plugins' ${rel}`, codesignArgs(join(stagedPlugins, rel), process.env.MOSS_MAC_IDENTITY!, nativeIdentifier(rel)), root);
        }
      }
      // --sign-dev likewise, in its dev form (lib.ts's codesignDevArgs: the team requirement, no timestamp).
      if (a.signDev) {
        for (const rel of machOFiles(stagedPlugins)) {
          must(`sign the plugins' ${rel} (dev)`, codesignDevArgs(join(stagedPlugins, rel), dev!.hash, nativeIdentifier(rel), MOSS_TEAM_ID, undefined, process.env.MOSS_MAC_DEV_KEYCHAIN || undefined), root);
        }
      }
      manifest = writeStagedManifest(stagedPlugins, manifestFile);
      console.log(`release/build: the bundled plugins: ${builtPlugins.files.length} files built (${builtPlugins.natives.length} native addon files), ${Object.keys(manifest.files).length} measured`);
      if (runScriptLine(`bun scripts/build-daemon.ts --target ${target} --plugins-manifest ${JSON.stringify(manifestFile)}${testFlag}`, root) !== 0) throw new Error("the daemon's build failed");
      must("the link sidecar", LINK_BUILD, root, linkBuildEnv(process.env, root));
      rmSync(staged, { recursive: true, force: true });
      mkdirSync(staged, { recursive: true });
      copyFileSync(join(root, ...daemonOutput(target).split("/")), join(staged, `moss-core${exe}`));
      copyFileSync(join(root, ...`${LINK_OUTPUT}${exe}`.split("/")), join(staged, `moss-link${exe}`));
      const built = dirname(join(root, ...daemonOutput(target).split("/")));
      for (const f of bundledFiles(target)) if (existsSync(join(built, f))) copyFileSync(join(built, f), join(staged, f));
      for (const f of readdirSync(staged)) chmodSync(join(staged, f), 0o755);
      // The seal (scripts/seal-bun-doors.ts) is checked on the very bytes that get signed: a core built some other way
      // never ships unsealed (on Windows, never half-sealed).
      const stagedCore = new Uint8Array(readFileSync(join(staged, `moss-core${exe}`)));
      const seal = sealProblems(stagedCore);
      if (seal.length > 0) throw new Error(`the staged moss-core fails the seal's byte check: ${seal.join("; ")}`);
      // The marker gate (scripts/test-build.ts) on the very bytes that get signed.
      const marker = testBuildMarkerProblems("the staged moss-core", stagedCore, a.testBuild === true);
      if (marker.length > 0) throw new Error(marker.join("; "));
      if (a.sign && a.os === "mac") {
        for (const b of RESOURCE_BINARIES) {
          must(`sign ${b.file}`, codesignArgs(join(staged, b.file), process.env.MOSS_MAC_IDENTITY!, b.identifier, b.entitlements === undefined ? undefined : join(root, b.entitlements), { restrict: b.restrict }), root);
        }
      }
      if (a.signDev) {
        // By its SHA-1 only: an Apple Development certificate's name is a person's.
        console.log(`release/build: --sign-dev with the team's Apple Development identity (SHA-1 ${dev!.hash})`);
        for (const b of RESOURCE_BINARIES) {
          must(`sign ${b.file} (dev)`, codesignDevArgs(join(staged, b.file), dev!.hash, b.identifier, MOSS_TEAM_ID, b.entitlements === undefined ? undefined : join(root, b.entitlements), process.env.MOSS_MAC_DEV_KEYCHAIN || undefined, { restrict: b.restrict }), root);
        }
      }
      // The package gate (scripts/bundled-binaries.ts): plugin Bun beside the core, and on macOS the process holder,
      // each under its own identifier — a packaged build never falls back to process-group tracking.
      const staging = bundledBinaryProblems(staged, target, { kind: "dist" });
      if (staging.length > 0) throw new Error(`the package gate: ${staging.join("; ")}`);
      // MOSS Code first: its afterPack makes the host helper and stashes a copy (apps/desktop/scripts/host-helper.mjs), which
      // MOSS's afterPack carries into MOSS.app before MOSS is signed (apps/moss/scripts/host-helper.mjs).
      const withStash = { ...builderEnv(a, process.env), MOSS_HOST_HELPER_STASH: stash };
      must(`${a.os === "mac" ? "the dmg and the zip" : "the installer"} on ${a.channel}`, builder, desktop, withStash);
      // MOSS, from the very same stage (apps/moss/electron-builder.yml packs apps/desktop/out/daemon and out/plugins).
      must(`MOSS's ${a.os === "mac" ? "dmg and zip" : "installer"} on ${a.channel}`, mossBuilder, mossDir, withStash);
      // MOSS's outputs beside MOSS Code's, its update files under MOSS's names; on Windows its unpacked app stays in its folder.
      const moved = moveMossOutputs(mossOut, outDir, a.os);
      console.log(`release/build: MOSS's ${moved.join(", ")} into ${outDir}`);
      // On macOS everything of MOSS's is in the release's folder now; on Windows its unpacked app stays (the signed checks read it).
      if (a.os === "mac") rmSync(mossOut, { recursive: true, force: true });
      const mossResources = a.os === "mac" ? resourcesIn(outDir, a.os, MOSS_BOTS_APP) : join(mossOut, "win-unpacked", "resources");
      for (const [label, resources] of [["the built app", resourcesIn(outDir, a.os)], ["the built MOSS", mossResources]] as const) {
        const inApp = bundledBinaryProblems(join(resources, "daemon"), target, { kind: "dist" });
        if (inApp.length > 0) throw new Error(`the package gate, in ${label}: ${inApp.join("; ")}`);
        // The marker gate on the app's own code (its app.asar) and on the core as the app carries it.
        const asar = new Uint8Array(readFileSync(join(resources, "app.asar")));
        const appMarker = [
          ...asarMarkerProblems(`${label}'s app.asar`, asar, a.testBuild === true),
          ...releaseMarkerProblems(`${label}'s app.asar`, asar, a.testBuild !== true),
          ...testBuildMarkerProblems(`${label}'s moss-core`, new Uint8Array(readFileSync(join(resources, "daemon", `moss-core${exe}`))), a.testBuild === true),
        ];
        if (appMarker.length > 0) throw new Error(appMarker.join("; "));
      }
      // One release in both apps: the same engine, tree and host helper (scripts/release/two-apps.ts).
      const same = samePayloadProblems({
        codeResources: resourcesIn(outDir, a.os), mossResources,
        ...(a.os === "mac" ? { codeBundle: join(outDir, "mac-arm64", `${CODE_APP.product}.app`), mossBundle: join(outDir, "mac-arm64", `${MOSS_BOTS_APP.product}.app`), hostIdentifier: MOSS_PROGRAM_IDENTIFIERS.host.dist } : {}),
      });
      if (same.length > 0) throw new Error(`one release, two apps: ${same.join("; ")}`);
      console.log("release/build: MOSS Code and MOSS carry the same engine, tree and host helper");
    } finally {
      rmSync(staged, { recursive: true, force: true });
      rmSync(stagedPlugins, { recursive: true, force: true });
      rmSync(manifestFile, { force: true });
      rmSync(stash, { recursive: true, force: true });
    }
    {
      // The bundled plugins, where the core looks for them (resources/plugins beside resources/daemon), in both apps.
      for (const resources of [resourcesIn(outDir, a.os), a.os === "mac" ? resourcesIn(outDir, a.os, MOSS_BOTS_APP) : join(mossOut, "win-unpacked", "resources")]) {
        const plugins = bundledPluginsProblems(resources, manifest, existsSync, walkTree);
        for (const p of plugins) console.error(`release/build: ${p}`);
        if (plugins.length > 0) return 1;
      }
    }

    if (a.testBuild) {
      // Signed with the Developer ID, never notarized or stapled, and no update files: nothing here can feed an update.
      const names = testBuildArtifacts(version);
      const mossNames = mossTestBuildArtifacts(version);
      for (const n of [names.dmg, names.zip, mossNames.dmg, mossNames.zip]) if (!existsSync(join(outDir, n))) throw new Error(`${n} is missing from ${outDir}`);
      must("sign the dmg", codesignDmgArgs(join(outDir, names.dmg), process.env.MOSS_MAC_IDENTITY!), outDir);
      must("sign MOSS's dmg", codesignDmgArgs(join(outDir, mossNames.dmg), process.env.MOSS_MAC_IDENTITY!), outDir);
      for (const f of readdirSync(outDir).filter((n) => n.endsWith(".yml") || n.endsWith(".blockmap"))) rmSync(join(outDir, f), { force: true });
      const problems = verifyMacTest(outDir, version, identityTeam(process.env.MOSS_MAC_IDENTITY!), root);
      for (const p of problems) console.error(`release/build: ${p}`);
      if (problems.length > 0) return 1;
      writeBuildCommit(outDir, a.os, commit, "test");
      const scan = runNameScan(outDir, { required: true });
      console.log(scan.ran ? `release/build: identity scan: ${scan.scanned}/${scan.total} files, no hit` : `release/build: identity scan skipped (${scan.reason})`);
      const shipped = readdirSync(outDir).filter((n) => /\.(dmg|zip)$/.test(n)).sort();
      writeFileSync(join(outDir, `SHA256SUMS-${a.os}.txt`), shipped.map((n) => `${sha256(join(outDir, n))}  ${n}`).join("\n") + "\n");
      console.log(`release/build: ${shipped.join(", ")} in ${outDir} (${kind})`);
      return 0;
    }
    if (a.signOnly) {
      // Signed with the Developer ID, never notarized or stapled, and no update files: nothing here can feed an update,
      // and publish refuses it (no stapled dmg, no update files).
      const dmgName = `MOSS-Code-${version}.dmg`;
      const mossDmg = `MOSS-${version}.dmg`;
      for (const n of [dmgName, `MOSS-Code-${version}-mac.zip`, mossDmg, `MOSS-${version}-mac.zip`]) if (!existsSync(join(outDir, n))) throw new Error(`${n} is missing from ${outDir}`);
      must("sign the dmg", codesignDmgArgs(join(outDir, dmgName), process.env.MOSS_MAC_IDENTITY!), outDir);
      must("sign MOSS's dmg", codesignDmgArgs(join(outDir, mossDmg), process.env.MOSS_MAC_IDENTITY!), outDir);
      for (const f of readdirSync(outDir).filter((n) => n.endsWith(".yml") || n.endsWith(".blockmap"))) rmSync(join(outDir, f), { force: true });
      const teamId = identityTeam(process.env.MOSS_MAC_IDENTITY!);
      const problems = verifyMacTest(outDir, version, teamId, root, true);
      for (const d of [dmgName, mossDmg]) {
        const dmgSig = parseCodesignDisplay(run(["codesign", "-dvvv", join(outDir, d)], outDir).out);
        if (dmgSig.adhoc || dmgSig.teamId !== teamId) problems.push(`${d} is not signed by team ${teamId}`);
      }
      for (const p of problems) console.error(`release/build: ${p}`);
      if (problems.length > 0) return 1;
      writeBuildCommit(outDir, a.os, commit, "sign-only");
      const scan = runNameScan(outDir, { required: true });
      console.log(scan.ran ? `release/build: identity scan: ${scan.scanned}/${scan.total} files, no hit` : `release/build: identity scan skipped (${scan.reason})`);
      const shipped = [...signOnlyOutputs(version), ...mossInstallers(version, "mac")].filter((n) => /\.(dmg|zip)$/.test(n));
      writeFileSync(join(outDir, `SHA256SUMS-${a.os}.txt`), shipped.map((n) => `${sha256(join(outDir, n))}  ${n}`).join("\n") + "\n");
      console.log(`release/build: ${shipped.join(", ")} in ${outDir} (${kind})`);
      return 0;
    }
    if (a.sign && a.os === "mac") {
      for (const app of [CODE_APP, MOSS_BOTS_APP]) {
        const dmgName = `${app.artifact}-${version}.dmg`;
        const dmg = join(outDir, dmgName);
        must(`sign ${app.product}'s dmg`, codesignDmgArgs(dmg, process.env.MOSS_MAC_IDENTITY!), outDir);
        must(`notarize ${app.product}'s dmg`, notarizeArgs(dmg, process.env.APPLE_KEYCHAIN_PROFILE!), outDir);
        must(`staple ${app.product}'s dmg`, ["xcrun", "stapler", "staple", dmg], outDir);
        // The staple changed the dmg's bytes: its entry in each update file is measured again.
        for (const f of readdirSync(outDir).filter((n) => n.endsWith("-mac.yml"))) {
          const path = join(outDir, f);
          const info = parseUpdateInfo(readFileSync(path, "utf8"));
          if (info.files.some((e) => e.url === dmgName)) writeFileSync(path, formatUpdateInfo(refreshEntry(info, dmgName, readFileSync(dmg))));
        }
        rmSync(`${dmg}.blockmap`, { force: true });
      }
      const problems = verifyMac(outDir, version, identityTeam(process.env.MOSS_MAC_IDENTITY!), root);
      for (const p of problems) console.error(`release/build: ${p}`);
      if (problems.length > 0) return 1;
    }
    if (a.signDev) {
      const problems = verifyMacDev(outDir, version, MOSS_TEAM_ID, root);
      for (const p of problems) console.error(`release/build: ${p}`);
      if (problems.length > 0) return 1;
    }
    if (a.sign && a.os === "win") {
      const problems = verifyWin(outDir, version, process.env.MOSS_WIN_PUBLISHER!, join(mossOut, "win-unpacked"));
      for (const p of problems) console.error(`release/build: ${p}`);
      if (problems.length > 0) return 1;
    }
    writeCoreAssets(outDir, version, a.os, a.channel, daemonInApp(outDir, a.os));
    writePluginBunAssets(outDir, a.os, a.channel, join(dirname(daemonInApp(outDir, a.os)), bundledFiles(target)[0]!));
    // The bundled plugins for a server: the app's resources/plugins (held to the core's manifest above), packed.
    writePluginsAssets(outDir, version, a.os, a.channel, join(dirname(dirname(daemonInApp(outDir, a.os))), "plugins"));
    writeBuildCommit(outDir, a.os, commit);
    writeServedCopies(outDir, a.channel, [a.os]);
    mossServedCopies(outDir, a.channel, a.os, copyFileSync);

    const problems: string[] = [];
    for (const name of [...expectedArtifacts(version, a.os, a.channel), ...mossArtifacts(version, a.os, a.channel)]) if (!existsSync(join(outDir, name))) problems.push(`${name} is missing from ${outDir}`);
    for (const ch of a.channel === "latest" ? (["latest", "beta"] as const) : (["beta"] as const)) {
      const path = join(outDir, feedFile(ch, a.os));
      if (!existsSync(path)) continue;
      const read = (n: string) => (existsSync(join(outDir, n)) ? new Uint8Array(readFileSync(join(outDir, n))) : undefined);
      problems.push(...checkUpdateInfo(parseUpdateInfo(readFileSync(path, "utf8")), version, read).map((p) => `${feedFile(ch, a.os)}: ${p}`));
      // MOSS's own update file: its own artifacts, of the same release.
      const mossFeed = join(outDir, mossFeedFile(ch, a.os));
      if (existsSync(mossFeed)) {
        const info = parseUpdateInfo(readFileSync(mossFeed, "utf8"));
        problems.push(...checkUpdateInfo(info, version, read).map((p) => `${mossFeedFile(ch, a.os)}: ${p}`));
        if (info.files.some((e) => !e.url.startsWith("MOSS-") || e.url.startsWith("MOSS-Code-"))) problems.push(`${mossFeedFile(ch, a.os)} names a file that isn't MOSS's`);
      }
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
    const scan = runNameScan(outDir, { required: a.sign || a.signDev });
    console.log(scan.ran ? `release/build: identity scan: ${scan.scanned}/${scan.total} files, no hit` : `release/build: identity scan skipped (${scan.reason}); a signed release never skips it`);
    const shipped = readdirSync(outDir).filter((n) => /\.(dmg|zip|exe|yml|blockmap)$/.test(n) || n.startsWith("moss-core-") || n.startsWith("moss-plugin-bun-") || n.startsWith("moss-plugins-")).sort();
    writeFileSync(join(outDir, `SHA256SUMS-${a.os}.txt`), shipped.map((n) => `${sha256(join(outDir, n))}  ${n}`).join("\n") + "\n");
    console.log(`release/build: ${shipped.join(", ")} in ${outDir} (${kind})`);
    return 0;
  } catch (err) {
    console.error(`release/build: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
