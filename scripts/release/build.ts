// A release build for macOS or Windows (plan §4 M-M2): the app with the daemon and its link sidecar inside, its
// installers and its update files for a channel, in apps/desktop/out/dist/. Linux's release build is
// scripts/build-packages.ts with the same --channel.
//
//   bun scripts/release/build.ts [--channel latest|beta] [--sign] [--dry-run]
//
// It runs on the OS it builds for (macOS on Apple silicon, Windows x64):
//   1. builds the app (apps/desktop's `build`), the daemon (scripts/build-daemon.ts) and clover-link (cargo)
//   2. stages the daemon and the sidecar in apps/desktop/out/daemon/, where electron-builder.yml's extraResources
//      picks them up
//   3. with --sign on macOS, signs the two staged binaries with the Developer ID (hardened runtime, timestamp, each
//      its own identifier and entitlements: lib.ts's RESOURCE_BINARIES)
//   4. runs electron-builder for the OS's targets (`--publish never`, always) with the channel; with --sign, the
//      identity and notarization on macOS, and forced signing and the update publisher on Windows
//   5. with --sign on macOS: signs, notarizes and staples the dmg, measures the update file's dmg entry again,
//      and checks the app and the app inside the update zip (every signature, the daemon's and the sidecar's
//      entitlements, the seal, Gatekeeper's verdict, the staple) and the dmg (its signature, its staple, Gatekeeper
//      on opening it); on Windows, the Authenticode signatures of the installer, Clover.exe, clover-core.exe and
//      clover-link.exe, by the publisher
//   6. records the commit it built (BUILD-COMMIT-<os>.txt; a signed build needs a clean checkout), on latest copies
//      the update files to the beta names (lib.ts's `writeServedCopies`), and checks the installers and update files are all there, each update file against the files it names, and
//      writes SHA256SUMS-<os>.txt beside them
//
// Signing is the owner's: without --sign the build is unsigned (CI's release workflow), whatever the environment
// holds, and electron-builder is told not to look for an identity. With --sign every input must be there, or it
// stops before building:
//   macOS     CLOVER_MAC_IDENTITY     the identity's full name, "Developer ID Application: <name> (<TEAMID>)", in the
//                                     login keychain
//             APPLE_KEYCHAIN_PROFILE  notarytool's stored profile (`xcrun notarytool store-credentials`)
//   Windows   WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD   the Authenticode certificate, as electron-builder takes it
//             CLOVER_WIN_PUBLISHER    its subject's common name, which electron-updater checks each update against
// None is printed, logged or written anywhere. Nothing is published.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { daemonOutput, runScriptLine, type DaemonTarget } from "../build-daemon";
import { LINK_BUILD, LINK_OUTPUT } from "../build-packages";
import { authenticodeDigest, parsePins, PIN_FILE, pinProblems, SRT_WIN_NOTICES, srtWinOutput } from "./srt-win";
import {
  authenticodeCommand, authenticodeProblems, channelArgs, checkoutCommit, checkUpdateInfo, codesignArgs, codesignDmgArgs, entitlementsIn,
  expectedArtifacts, feedFile, formatUpdateInfo, identityTeam, parseEntitlementKeys, writeBuildCommit,
  notarizeArgs, parseChannel, parseCodesignDisplay, parseUpdateInfo, refreshEntry, RESOURCE_BINARIES, signatureProblems,
  writeServedCopies, type Channel,
} from "./lib";

export type BuildOs = "mac" | "win";

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

/**
 * The installer's elevated script as it goes into the installer: comments and blank lines dropped (NSIS strings are
 * bounded), the daemon's Authenticode digest in place of the pin, UTF-8, gzipped (the installer's PowerShell opens
 * it with .NET's GZipStream), in base64. Throws if the pin isn't there once, the digest isn't one, or the result is
 * too long for the installer's command line.
 */
export function sandboxScript(source: string, coreDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(coreDigest)) throw new Error("the daemon's digest is not a SHA-256");
  if (source.split("__CLOVER_CORE_DIGEST__").length !== 2) throw new Error("sandbox-elevated.ps1 must hold the pin's placeholder once");
  const code = source.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#")).join("\n");
  const b64 = Buffer.from(gzipSync(Buffer.from(code.replace("__CLOVER_CORE_DIGEST__", coreDigest), "utf8"), { level: 9 })).toString("base64");
  if (b64.length > SANDBOX_SCRIPT_MAX) throw new Error(`the elevated script is ${b64.length} characters in base64, over ${SANDBOX_SCRIPT_MAX}`);
  return b64;
}
/** NSIS's strings hold 8192 characters; the command around the script takes the rest. */
export const SANDBOX_SCRIPT_MAX = 6000;

/** What --sign needs from the environment, or the names missing (never their values). */
export function signingInputs(os: BuildOs, env: Record<string, string | undefined>): { missing: string[]; problems: string[] } {
  const need = os === "mac" ? ["CLOVER_MAC_IDENTITY", "APPLE_KEYCHAIN_PROFILE"] : ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "CLOVER_WIN_PUBLISHER"];
  const missing = need.filter((k) => !env[k]);
  const problems: string[] = [];
  if (os === "mac" && env.CLOVER_MAC_IDENTITY) {
    try {
      identityTeam(env.CLOVER_MAC_IDENTITY);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return { missing, problems };
}

export const DAEMON_TARGET: Readonly<Record<BuildOs, DaemonTarget>> = { mac: "darwin-arm64", win: "windows-x64" };

/** electron-builder's command for the OS's release, run in apps/desktop. Secrets reach it through its environment only. */
export function releaseBuilderArgs(a: ReleaseBuildArgs, env: Record<string, string | undefined>): string[] {
  const base = a.os === "mac" ? ["electron-builder", "--mac", "dmg", "zip", "--arm64"] : ["electron-builder", "--win", "nsis", "--x64"];
  const out = [...base, "--publish", "never", ...channelArgs(a.channel)];
  if (!a.sign) return out;
  if (a.os === "mac") return [...out, `-c.mac.identity=${env.CLOVER_MAC_IDENTITY}`, "-c.mac.notarize=true"];
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
  const deep = run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app], cwd);
  if (deep.status !== 0) problems.push(`codesign --verify --deep --strict refuses ${label}: ${deep.out.trim().slice(0, 400)}`);
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
  ] as const;
  return files.flatMap(([name, path]) => authenticodeProblems(name, run(authenticodeCommand(path), outDir).out, publisher));
}

export function main(argv: readonly string[], root: string): number {
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
    console.log(`release/build: the daemon: bun scripts/build-daemon.ts --target ${target}`);
    console.log(`release/build: the link sidecar: ${LINK_BUILD.join(" ")}`);
    if (a.os === "win") console.log(`release/build: the fence launcher: ${srtWinOutput("x64")} (scripts/release/srt-win.ts), checked against core's pin`);
    if (a.sign && a.os === "mac") for (const b of RESOURCE_BINARIES) console.log(`release/build: sign ${b.file}: ${codesignArgs(`out/daemon/${b.file}`, "<CLOVER_MAC_IDENTITY>", b.identifier, b.entitlements).join(" ")}`);
    console.log(`release/build: package: (in apps/desktop) ${shown.join(" ")}`);
    if (a.sign && a.os === "mac") console.log(`release/build: the dmg: sign, ${notarizeArgs(`Clover-${version}.dmg`, "<APPLE_KEYCHAIN_PROFILE>").join(" ")}, xcrun stapler staple`);
    console.log(`release/build: expects ${expectedArtifacts(version, a.os, a.channel).join(", ")}`);
    return 0;
  }
  try {
    const outDir = join(desktop, "out", "dist");
    const staged = join(desktop, "out", "daemon");
    // A release is of one commit; a signed one of a clean checkout of it.
    const commit = checkoutCommit(root, a.sign);
    rmSync(outDir, { recursive: true, force: true });
    must("the app", ["bun", "run", "build"], desktop);
    if (runScriptLine(`bun scripts/build-daemon.ts --target ${target}`, root) !== 0) throw new Error("the daemon's build failed");
    must("the link sidecar", LINK_BUILD, root);
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { recursive: true });
    copyFileSync(join(root, ...daemonOutput(target).split("/")), join(staged, `clover-core${exe}`));
    copyFileSync(join(root, ...`${LINK_OUTPUT}${exe}`.split("/")), join(staged, `clover-link${exe}`));
    if (a.os === "win") {
      // Bash's fence launcher, built by scripts/release/srt-win.ts and checked against core's pin again here.
      const srt = join(root, ...srtWinOutput("x64").split("/"));
      if (!existsSync(srt)) throw new Error(`there is no ${srtWinOutput("x64")}: run bun scripts/release/srt-win.ts first`);
      const sha = authenticodeDigest(new Uint8Array(readFileSync(srt)));
      const pin = parsePins(existsSync(join(root, PIN_FILE)) ? readFileSync(join(root, PIN_FILE), "utf8") : undefined);
      const problems = pinProblems("x64", sha, pin, false);
      if (problems.length > 0) throw new Error(problems.join("; "));
      copyFileSync(srt, join(staged, "srt-win.exe"));
      copyFileSync(join(root, ...SRT_WIN_NOTICES.split("/")), join(staged, "srt-win.THIRD_PARTY_NOTICES.txt"));
      // The installer's elevated step, with the daemon's digest pinned in it (packaging/windows/sandbox-elevated.ps1).
      const ps = sandboxScript(readFileSync(join(root, "packaging", "windows", "sandbox-elevated.ps1"), "utf8"), authenticodeDigest(new Uint8Array(readFileSync(join(staged, "clover-core.exe")))));
      writeFileSync(join(desktop, "out", "sandbox.nsh"), `!define CLOVER_SANDBOX_PS "${ps}"\n`);
    }
    for (const f of readdirSync(staged)) chmodSync(join(staged, f), 0o755);
    if (a.sign && a.os === "mac") {
      for (const b of RESOURCE_BINARIES) {
        must(`sign ${b.file}`, codesignArgs(join(staged, b.file), process.env.CLOVER_MAC_IDENTITY!, b.identifier, b.entitlements === undefined ? undefined : join(root, b.entitlements)), root);
      }
    }
    must(`${a.os === "mac" ? "the dmg and the zip" : "the installer"} on ${a.channel}`, builder, desktop, builderEnv(a, process.env));
    rmSync(staged, { recursive: true, force: true });

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
    writeBuildCommit(outDir, a.os, commit);
    writeServedCopies(outDir, a.channel, [a.os]);

    const problems: string[] = [];
    for (const name of expectedArtifacts(version, a.os, a.channel)) if (!existsSync(join(outDir, name))) problems.push(`${name} is missing from ${outDir}`);
    for (const ch of a.channel === "latest" ? (["latest", "beta"] as const) : (["beta"] as const)) {
      const path = join(outDir, feedFile(ch, a.os));
      if (!existsSync(path)) continue;
      const read = (n: string) => (existsSync(join(outDir, n)) ? new Uint8Array(readFileSync(join(outDir, n))) : undefined);
      problems.push(...checkUpdateInfo(parseUpdateInfo(readFileSync(path, "utf8")), version, read).map((p) => `${feedFile(ch, a.os)}: ${p}`));
    }
    for (const p of problems) console.error(`release/build: ${p}`);
    if (problems.length > 0) return 1;
    const shipped = readdirSync(outDir).filter((n) => /\.(dmg|zip|exe|yml|blockmap)$/.test(n)).sort();
    writeFileSync(join(outDir, `SHA256SUMS-${a.os}.txt`), shipped.map((n) => `${sha256(join(outDir, n))}  ${n}`).join("\n") + "\n");
    console.log(`release/build: ${shipped.join(", ")} in ${outDir}${a.sign ? "" : " (unsigned)"}`);
    return 0;
  } catch (err) {
    console.error(`release/build: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
