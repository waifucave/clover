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
//      identity and notarization on macOS, and forced signing and the update publisher on Windows; then checks the
//      bundled plugins are in the app's resources/plugins (lib.ts's `bundledPluginsProblems`)
//   5. with --sign on macOS: signs, notarizes and staples the dmg, measures the update file's dmg entry again,
//      and checks every signature (the app, the daemon, the sidecar, the dmg), Gatekeeper's verdict and the staples
//   6. on latest, copies the update files to the beta names (lib.ts's `writeServedCopies`), and checks the installers and update files are all there, each update file against the files it names, and
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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonOutput, runScriptLine, type DaemonTarget } from "../build-daemon";
import { LINK_BUILD, LINK_OUTPUT } from "../build-packages";
import {
  bundledPluginsProblems,
  channelArgs, checkUpdateInfo, codesignArgs, codesignDmgArgs, expectedArtifacts, feedFile, formatUpdateInfo, identityTeam,
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

/** Every file under `dir`, relative to it (`[]` when there is no `dir`). */
function walkFiles(dir: string, rel = ""): string[] {
  let names: string[];
  try { names = readdirSync(join(dir, rel)); } catch { return []; }
  return names.flatMap((n) => {
    const r = rel === "" ? n : `${rel}/${n}`;
    return statSync(join(dir, r)).isDirectory() ? walkFiles(dir, r) : [r];
  });
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The signed app's checks: each signature, Gatekeeper's verdict and the notarization staples. */
function verifyMac(outDir: string, version: string, teamId: string): string[] {
  const app = join(outDir, "mac-arm64", "Clover.app");
  const dmg = join(outDir, `Clover-${version}.dmg`);
  const problems: string[] = [];
  const display = (path: string) => parseCodesignDisplay(run(["codesign", "-dvvv", path], outDir).out);
  problems.push(...signatureProblems("Clover.app", display(app), teamId));
  for (const b of RESOURCE_BINARIES) problems.push(...signatureProblems(b.file, display(join(app, "Contents", "Resources", "daemon", b.file)), teamId, b.identifier));
  const deep = run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app], outDir);
  if (deep.status !== 0) problems.push(`codesign --verify --deep --strict refuses Clover.app: ${deep.out.trim().slice(0, 400)}`);
  const gate = run(["spctl", "--assess", "--type", "execute", "--verbose=2", app], outDir);
  if (gate.status !== 0 || !/source=Notarized Developer ID/.test(gate.out)) problems.push(`Gatekeeper doesn't accept Clover.app as notarized: ${gate.out.trim().slice(0, 400)}`);
  for (const path of [app, dmg]) if (run(["xcrun", "stapler", "validate", path], outDir).status !== 0) problems.push(`${path.split("/").pop()} has no notarization staple`);
  const dmgSig = display(dmg);
  if (dmgSig.adhoc || dmgSig.teamId !== teamId) problems.push(`the dmg is not signed by team ${teamId}`);
  return problems;
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
    if (a.sign && a.os === "mac") for (const b of RESOURCE_BINARIES) console.log(`release/build: sign ${b.file}: ${codesignArgs(`out/daemon/${b.file}`, "<CLOVER_MAC_IDENTITY>", b.identifier, b.entitlements).join(" ")}`);
    console.log(`release/build: package: (in apps/desktop) ${shown.join(" ")}`);
    if (a.sign && a.os === "mac") console.log(`release/build: the dmg: sign, ${notarizeArgs(`Clover-${version}.dmg`, "<APPLE_KEYCHAIN_PROFILE>").join(" ")}, xcrun stapler staple`);
    console.log(`release/build: expects ${expectedArtifacts(version, a.os, a.channel).join(", ")}`);
    return 0;
  }
  try {
    const outDir = join(desktop, "out", "dist");
    const staged = join(desktop, "out", "daemon");
    rmSync(outDir, { recursive: true, force: true });
    must("the app", ["bun", "run", "build"], desktop);
    if (runScriptLine(`bun scripts/build-daemon.ts --target ${target}`, root) !== 0) throw new Error("the daemon's build failed");
    must("the link sidecar", LINK_BUILD, root);
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { recursive: true });
    copyFileSync(join(root, ...daemonOutput(target).split("/")), join(staged, `clover-core${exe}`));
    copyFileSync(join(root, ...`${LINK_OUTPUT}${exe}`.split("/")), join(staged, `clover-link${exe}`));
    for (const f of readdirSync(staged)) chmodSync(join(staged, f), 0o755);
    if (a.sign && a.os === "mac") {
      for (const b of RESOURCE_BINARIES) {
        must(`sign ${b.file}`, codesignArgs(join(staged, b.file), process.env.CLOVER_MAC_IDENTITY!, b.identifier, b.entitlements === undefined ? undefined : join(root, b.entitlements)), root);
      }
    }
    must(`${a.os === "mac" ? "the dmg and the zip" : "the installer"} on ${a.channel}`, builder, desktop, builderEnv(a, process.env));
    rmSync(staged, { recursive: true, force: true });
    {
      // The bundled plugins, where the core looks for them (resources/plugins beside resources/daemon).
      const resources = a.os === "mac" ? join(outDir, "mac-arm64", "Clover.app", "Contents", "Resources") : join(outDir, "win-unpacked", "resources");
      const plugins = bundledPluginsProblems(resources, existsSync, (dir) => walkFiles(dir));
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
      const problems = verifyMac(outDir, version, identityTeam(process.env.CLOVER_MAC_IDENTITY!));
      for (const p of problems) console.error(`release/build: ${p}`);
      if (problems.length > 0) return 1;
    }
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
