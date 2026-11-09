// The Linux packages (plan §4 M1): the deb and the rpm, the main ones, which install the AppArmor profile Electron's
// sandbox needs on Ubuntu, and the AppImage, the fallback (spec §4). Each holds the desktop app, and the daemon,
// clover-core, with its link sidecar, clover-link (native/link, lane H), beside it in its resources/daemon/, where
// E-M1's app starts the daemon and the daemon its sidecar. The dmg and the Windows installer come with E-M1's app;
// signing and updates are M2.
//
//   bun scripts/build-packages.ts [--arch x64|arm64[,…]] [--formats deb,rpm,AppImage] [--channel latest|beta] [--check] [--dry-run]
//
// Linux only: electron-builder makes the deb and the rpm with fpm, and the rpm needs rpmbuild (`apt-get install rpm`).
// An architecture builds on its own machine (CI runs one job per architecture): clover-link is Rust with ring's C,
// and cargo builds it for the machine it is on. It:
//   1. stages the bundled plugins (the committed files under plugins/) and measures them, then builds the daemon for
//      linux-<arch> (scripts/build-daemon.ts) with that manifest compiled in, and clover-link (`cargo build --release
//      --locked`)
//   2. stages both in apps/desktop/out/daemon/, where electron-builder.yml's extraResources picks them up
//   3. builds the app (apps/desktop's `build`) once, and packages it: electron-builder --linux <formats> --<arch>
//   4. with --check, opens each package and checks it holds the daemon, the sidecar, the AppArmor profile and
//      packaging/linux's scripts, with sound file modes: the app, the daemon and the sidecar root's and 0755, nothing
//      world-writable, nothing set-user-ID (`checkPackage`)
// Output: apps/desktop/out/dist/. Nothing is signed, published or installed.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonOutput, runScriptLine, type DaemonTarget } from "./build-daemon";
import { bundledBinaryProblems, bundledFiles } from "./bundled-binaries";
import { runNameScan } from "./release/name-scan";
import { sealProblems } from "./seal-bun-doors";
import { channelArgs, checkoutCommit, parseChannel, writeBuildCommit, writeCoreAssets, writePluginBunAssets, writePluginsAssets, writeServedCopies, type Channel } from "./release/lib";
import { buildBundledPlugins, bundledPluginsProblems, STAGED_PLUGINS, walkTree, writeStagedManifest } from "./release/bundled-plugins";
import { BUNDLED_MANIFEST_FILE, type BundledManifest } from "../packages/core/src/bundled-plugins-dir";

export const LINUX_ARCHES = ["x64", "arm64"] as const;
export type LinuxArch = (typeof LINUX_ARCHES)[number];
export const LINUX_FORMATS = ["deb", "rpm", "AppImage"] as const;
export type LinuxFormat = (typeof LINUX_FORMATS)[number];

export interface BuildPackagesArgs {
  arches: LinuxArch[];
  formats: LinuxFormat[];
  channel: Channel;
  check: boolean;
  dryRun: boolean;
}

function listOf<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T[] {
  const list = (value ?? "").split(",").filter(Boolean);
  const unknown = list.filter((v) => !allowed.includes(v as T));
  if (list.length === 0 || unknown.length > 0) throw new Error(`${flag} takes some of ${allowed.join(", ")}${unknown.length > 0 ? ` (not ${unknown.join(", ")})` : ""}`);
  return [...new Set(list as T[])];
}

/** `hostArch` is this machine's (`process.arch`), passed in so the parse stays pure. Another machine's architecture
 *  is refused but for --dry-run: clover-link builds for the machine it is on. */
export function parseBuildPackagesArgs(argv: readonly string[], hostArch: string): BuildPackagesArgs {
  let arches: LinuxArch[] | undefined;
  let formats: LinuxFormat[] = [...LINUX_FORMATS];
  let channel: Channel = "latest";
  let check = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (name: string): string | undefined => (a === name ? argv[++i] : a.slice(name.length + 1));
    if (a === "--check") check = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--arch" || a.startsWith("--arch=")) arches = listOf("--arch", value("--arch"), LINUX_ARCHES);
    else if (a === "--formats" || a.startsWith("--formats=")) formats = listOf("--formats", value("--formats"), LINUX_FORMATS);
    else if (a === "--channel" || a.startsWith("--channel=")) channel = parseChannel(value("--channel"));
    else throw new Error(`unknown argument ${a} (usage: build-packages [--arch x64|arm64[,…]] [--formats deb,rpm,AppImage] [--channel latest|beta] [--check] [--dry-run])`);
  }
  if (arches === undefined) {
    if (!LINUX_ARCHES.includes(hostArch as LinuxArch)) throw new Error(`this machine is ${hostArch}: name an architecture with --arch`);
    arches = [hostArch as LinuxArch];
  }
  const foreign = arches.filter((a) => a !== hostArch);
  if (!dryRun && foreign.length > 0) throw new Error(`this machine is ${hostArch}: build ${foreign.join(", ")} on ${foreign.length === 1 ? "a machine" : "machines"} of ${foreign.length === 1 ? "that architecture" : "those architectures"} (clover-link, the link sidecar, builds for the machine it is on)`);
  return { arches, formats, channel, check, dryRun };
}

export function daemonTargetFor(arch: LinuxArch): DaemonTarget {
  return arch === "x64" ? "linux-x64" : "linux-arm64";
}

/** Debian's and RPM's names for an architecture, as electron-builder writes them into file names. */
export function packageArchNames(arch: LinuxArch): { deb: string; rpm: string; appImage: string } {
  return arch === "x64" ? { deb: "amd64", rpm: "x86_64", appImage: "x86_64" } : { deb: "arm64", rpm: "aarch64", appImage: "arm64" };
}

/** The electron-builder command for one architecture, run in apps/desktop: never publishing, with the update files
 *  written for `channel` (scripts/release/lib.ts). */
export function electronBuilderArgs(arch: LinuxArch, formats: readonly LinuxFormat[], channel: Channel = "latest"): string[] {
  return ["electron-builder", "--linux", ...formats, `--${arch}`, "--publish", "never", ...channelArgs(channel)];
}

/** The link sidecar's build (native/link), relative to the repo root: one for this machine. */
export const LINK_BUILD = ["cargo", "build", "--release", "--locked", "--manifest-path", "native/link/Cargo.toml"] as const;
export const LINK_OUTPUT = "native/link/target/release/clover-link";

/**
 * The privacy scrub for the sidecar's build: a Rust binary keeps the absolute paths of the sources it was built from
 * (for panic messages), which on the owner's Mac name their home folder. They are remapped to fixed names: the
 * home folder to /home, the cargo home to /cargo, the checkout to /clover. Any RUSTFLAGS already set come first.
 */
export function linkBuildEnv(env: Record<string, string | undefined>, root: string): Record<string, string | undefined> {
  const home = env.HOME ?? env.USERPROFILE;
  const cargoHome = env.CARGO_HOME ?? (home === undefined ? undefined : join(home, ".cargo"));
  // rustc takes the last remapping that matches, so the home folder comes first and the paths inside it after.
  const remaps = [
    ...(home === undefined ? [] : [`--remap-path-prefix=${home}=/home`]),
    ...(cargoHome === undefined ? [] : [`--remap-path-prefix=${cargoHome}=/cargo`]),
    `--remap-path-prefix=${root}=/clover`,
  ];
  // CARGO_ENCODED_RUSTFLAGS, one flag per 0x1f: a path with a space (the owner's checkout has one) stays one flag.
  // Flags already set (either form) come first; RUSTFLAGS is then dropped, as cargo would ignore it.
  const before = env.CARGO_ENCODED_RUSTFLAGS ? env.CARGO_ENCODED_RUSTFLAGS.split("\x1f") : (env.RUSTFLAGS ?? "").split(" ").filter(Boolean);
  const { RUSTFLAGS: _dropped, ...rest } = env;
  return { ...rest, CARGO_ENCODED_RUSTFLAGS: [...before, ...remaps].join("\x1f") };
}

/** What a package must hold: the daemon, its link sidecar beside it, the AppArmor profile in the app's resources, and
 *  each bundled top-level plugin's manifest in resources/plugins (the registry's `bundledDirs`). */
export const REQUIRED_FILES = [
  "/opt/Clover/resources/daemon/clover-core", "/opt/Clover/resources/daemon/clover-link", "/opt/Clover/resources/daemon/clover-plugin-bun",
  "/opt/Clover/resources/apparmor-profile", "/opt/Clover/clover",
  "/opt/Clover/resources/plugins/clover/clover.json", "/opt/Clover/resources/plugins/alpha/clover.json",
] as const;
/** What its after-install script must do: link `clover` to the daemon's command line (packaging/linux/after-install.sh). */
export const AFTER_INSTALL_MARK = "/opt/Clover/resources/daemon/clover-core";

/** The executables a package runs as root's files: the app, the daemon and the sidecar, `rwxr-xr-x root root`. */
export const EXECUTABLES = ["/opt/Clover/clover", "/opt/Clover/resources/daemon/clover-core", "/opt/Clover/resources/daemon/clover-link", "/opt/Clover/resources/daemon/clover-plugin-bun"] as const;

export interface PackageEntry {
  mode: string;
  owner: string;
  group: string;
  path: string;
}

/**
 * One package's long file listing, parsed: `dpkg-deb -c` (`-rwxr-xr-x root/root 100 2026-11-05 12:00 ./opt/Clover/clover`)
 * or `rpm -qlvp` (`-rwxr-xr-x 1 root root 100 Nov  5 12:00 /opt/Clover/clover`). A link's ` -> target` is dropped.
 */
export function parseListing(format: "deb" | "rpm", listing: string): PackageEntry[] {
  const line = format === "deb"
    ? /^(\S{10})\s+([^/\s]+)\/(\S+)\s+\d+\s+\S+\s+\S+\s+\.?(\/.*?)(?: -> .*)?$/
    : /^(\S{10})\s+\d+\s+(\S+)\s+(\S+)\s+\d+\s+\S+\s+\d+\s+\S+\s+(\/.*?)(?: -> .*)?$/;
  const entries: PackageEntry[] = [];
  for (const raw of listing.split("\n")) {
    const m = line.exec(raw.trim());
    if (m) entries.push({ mode: m[1]!, owner: m[2]!, group: m[3]!, path: m[4]!.replace(/\/$/, "") || "/" });
  }
  return entries;
}

const isRoot = (name: string): boolean => name === "root" || name === "0";

/**
 * The problems with one package, from its long file listing (`dpkg-deb -c`, `rpm -qlvp`) and its scripts (`dpkg-deb -I …
 * postinst`, `rpm -qp --scripts`). An empty list is a good package: it holds the daemon, the sidecar and the AppArmor
 * profile, the app, the daemon and the sidecar are `rwxr-xr-x` and root's, nothing is world-writable (links aside), and nothing is set-user-ID
 * or set-group-ID (chrome-sandbox gets its set-user-ID bit from the after-install script, only where it needs one).
 */
export function checkPackage(format: "deb" | "rpm", listing: string, scripts: string): string[] {
  const entries = parseListing(format, listing);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const problems = REQUIRED_FILES.filter((f) => !byPath.has(f)).map((f) => `${format}: ${f} is missing`);
  for (const path of EXECUTABLES) {
    const e = byPath.get(path);
    if (e !== undefined && (e.mode !== "-rwxr-xr-x" || !isRoot(e.owner) || !isRoot(e.group))) problems.push(`${format}: ${path} is ${e.mode} ${e.owner}/${e.group}, not -rwxr-xr-x root/root`);
  }
  for (const e of entries) {
    if (!e.mode.startsWith("l") && e.mode[8] === "w") problems.push(`${format}: ${e.path} is world-writable (${e.mode})`);
    if (/[sS]/.test(e.mode[3]! + e.mode[6]!)) problems.push(`${format}: ${e.path} is set-user-ID or set-group-ID (${e.mode})`);
  }
  if (!scripts.includes(AFTER_INSTALL_MARK)) problems.push(`${format}: its after-install script is not packaging/linux/after-install.sh (no ${AFTER_INSTALL_MARK})`);
  if (!scripts.includes("apparmor_parser")) problems.push(`${format}: its scripts never load the AppArmor profile`);
  return problems;
}

function run(cmd: string[], cwd: string): { status: number; stdout: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env } });
  if (r.error !== undefined) return { status: 127, stdout: `${r.error.message}` };
  return { status: r.status ?? 1, stdout: `${r.stdout ?? ""}${r.status === 0 ? "" : r.stderr ?? ""}` };
}

function checkBuilt(outDir: string, arch: LinuxArch, formats: readonly LinuxFormat[]): string[] {
  const names = packageArchNames(arch);
  const files = existsSync(outDir) ? readdirSync(outDir) : [];
  const problems: string[] = [];
  for (const format of formats) {
    // The AppImage's name carries the architecture as electron-builder spells it (x64) or as AppImage does (x86_64).
    // Likewise the rpm's: electron-builder spells arm64 as arm64 in the file name, where the package says aarch64.
    const suffixes = format === "deb" ? [`_${names.deb}.deb`] : format === "rpm" ? [`.${names.rpm}.rpm`, `.${arch}.rpm`] : [`-${arch}.AppImage`, `-${names.appImage}.AppImage`];
    const suffix = suffixes.join(" or ");
    const file = files.find((f) => suffixes.some((x) => f.endsWith(x)));
    if (file === undefined) { problems.push(`${format} (${arch}): no *${suffix} in ${outDir}`); continue; }
    const path = join(outDir, file);
    console.log(`build-packages: ${file} (${(statSync(path).size / 1_048_576).toFixed(1)} MB)`);
    if (format === "AppImage") continue; // it runs its own runtime to list itself; the app checks its daemon at first launch
    const listing = format === "deb" ? run(["dpkg-deb", "-c", path], outDir) : run(["rpm", "-qlvp", path], outDir);
    const scripts = format === "deb" ? run(["dpkg-deb", "-I", path, "postinst"], outDir) : run(["rpm", "-qp", "--scripts", path], outDir);
    if (listing.status !== 0 || scripts.status !== 0) { problems.push(`${format} (${arch}): could not open it: ${listing.stdout.slice(0, 300)}${scripts.stdout.slice(0, 300)}`); continue; }
    problems.push(...checkPackage(format, listing.stdout, scripts.stdout).map((p) => `${p} (${arch})`));
  }
  return problems;
}

export async function main(argv: readonly string[], root: string): Promise<number> {
  let args: BuildPackagesArgs;
  try {
    args = parseBuildPackagesArgs(argv, process.arch);
  } catch (err) {
    console.error(`build-packages: ${(err as Error).message}`);
    return 2;
  }
  if (process.platform !== "linux" && !args.dryRun) {
    console.error("build-packages: the Linux packages build on Linux (fpm and rpmbuild); use --dry-run elsewhere");
    return 2;
  }
  const desktop = join(root, "apps", "desktop");
  const staged = join(desktop, "out", "daemon");
  const outDir = join(desktop, "out", "dist");
  const stagedPlugins = join(desktop, STAGED_PLUGINS);
  const manifestFile = join(desktop, "out", BUNDLED_MANIFEST_FILE);
  // `stage`: this architecture's daemon and sidecar go where electron-builder.yml's extraResources reads them, just
  // before packaging.
  // `plugins`: this architecture's bundled plugins, built and measured into the manifest its daemon carries.
  const steps: Array<{ say: string; cmd: string[]; cwd: string; stage?: LinuxArch; plugins?: LinuxArch }> = [
    { say: "the app", cmd: ["bun", "run", "build"], cwd: desktop },
    { say: "the link sidecar, clover-link", cmd: [...LINK_BUILD], cwd: root },
  ];
  for (const arch of args.arches) {
    steps.push({ say: `the bundled plugins for linux-${arch}, built (lane B's buildPluginForShipping) and measured`, cmd: [], cwd: root, plugins: arch });
    steps.push({ say: `the daemon for linux-${arch}`, cmd: ["bun", "scripts/build-daemon.ts", "--target", daemonTargetFor(arch), "--plugins-manifest", manifestFile], cwd: root });
    steps.push({ say: `${args.formats.join(", ")} for ${arch}`, cmd: ["bunx", ...electronBuilderArgs(arch, args.formats, args.channel)], cwd: desktop, stage: arch });
  }
  if (args.dryRun) {
    console.log(`build-packages: the bundled plugins: plugins/ at HEAD built per architecture into apps/desktop/${STAGED_PLUGINS.split("\\").join("/")}, measured into out/${BUNDLED_MANIFEST_FILE}`);
    for (const s of steps.filter((x) => x.plugins === undefined)) console.log(`build-packages: ${s.say}: (in ${s.cwd === root ? "." : "apps/desktop"}) ${s.cmd.join(" ")}`);
    return 0;
  }
  // A release is of one commit, from a fully clean checkout of it (the build reads the whole tree).
  let commit: string;
  try {
    commit = checkoutCommit(root);
  } catch (err) {
    console.error(`build-packages: ${(err as Error).message}`);
    return 1;
  }
  rmSync(outDir, { recursive: true, force: true });
  // The sidecar's build carries no path of this machine's (linkBuildEnv).
  process.env.CARGO_ENCODED_RUSTFLAGS = linkBuildEnv(process.env, root).CARGO_ENCODED_RUSTFLAGS;
  delete process.env.RUSTFLAGS;
  const version = (JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { version: string }).version;
  // The bundled plugins: built per architecture from the committed files only, where electron-builder.yml packs them,
  // and measured into the manifest that architecture's daemon carries; the stages removed however the build ends (a
  // stale stage would go into a later plain `bun run dist`).
  let manifest: BundledManifest | undefined;
  try {
    for (const s of steps) {
      console.log(`build-packages: ${s.say}…`);
      if (s.plugins !== undefined) {
        const built = await buildBundledPlugins(root, stagedPlugins, daemonTargetFor(s.plugins));
        manifest = writeStagedManifest(stagedPlugins, manifestFile);
        console.log(`build-packages: the bundled plugins for linux-${s.plugins}: ${built.files.length} files built (${built.natives.length} native addon files), ${Object.keys(manifest.files).length} measured`);
        continue;
      }
      if (s.stage !== undefined) {
        rmSync(staged, { recursive: true, force: true });
        mkdirSync(staged, { recursive: true });
        copyFileSync(join(root, ...daemonOutput(daemonTargetFor(s.stage)).split("/")), join(staged, "clover-core"));
        copyFileSync(join(root, ...LINK_OUTPUT.split("/")), join(staged, "clover-link"));
        chmodSync(join(staged, "clover-link"), 0o755);
        // Plain Bun for plugins, beside the core (scripts/bundled-binaries.ts); the package gate before packaging.
        const target = daemonTargetFor(s.stage);
        const built = dirname(join(root, ...daemonOutput(target).split("/")));
        for (const f of bundledFiles(target)) if (existsSync(join(built, f))) { copyFileSync(join(built, f), join(staged, f)); chmodSync(join(staged, f), 0o755); }
        const gate = [...bundledBinaryProblems(staged, target), ...sealProblems(new Uint8Array(readFileSync(join(staged, "clover-core")))).map((p) => `the seal: ${p}`)];
        if (gate.length > 0) { console.error(`build-packages: the package gate: ${gate.join("; ")}`); return 1; }
      }
      const status = runScriptLine(s.cmd.map((c) => (/[\s"']/.test(c) ? JSON.stringify(c) : c)).join(" "), s.cwd);
      if (status !== 0) { console.error(`build-packages: ${s.say} failed (exit ${status})`); return 1; }
      if (s.stage !== undefined) {
        // What electron-builder packed (its unpacked app) is exactly the tree the daemon's manifest names.
        const resources = join(outDir, s.stage === "x64" ? "linux-unpacked" : `linux-${s.stage}-unpacked`, "resources");
        const problems = bundledPluginsProblems(resources, manifest!, existsSync, walkTree);
        for (const p of problems) console.error(`build-packages: ${p} (${s.stage})`);
        if (problems.length > 0) return 1;
        // The same tree for a server on this architecture: the tarball and its update files.
        writePluginsAssets(outDir, version, s.stage === "x64" ? "linux-x64" : "linux-arm64", args.channel, join(resources, "plugins"));
      }
    }
  } catch (err) {
    console.error(`build-packages: ${(err as Error).message}`);
    return 1;
  } finally {
    rmSync(staged, { recursive: true, force: true });
    rmSync(stagedPlugins, { recursive: true, force: true });
    rmSync(manifestFile, { force: true });
  }
  // The daemon for a server's own update: each architecture's binary as its release file, with its update files.
  for (const a of args.arches) writeCoreAssets(outDir, version, a === "x64" ? "linux-x64" : "linux-arm64", args.channel, join(root, ...daemonOutput(daemonTargetFor(a)).split("/")));
  // Plain Bun for plugins, for a server install on this architecture (scripts/bundled-binaries.ts).
  for (const a of args.arches) writePluginBunAssets(outDir, a === "x64" ? "linux-x64" : "linux-arm64", args.channel, join(dirname(join(root, ...daemonOutput(daemonTargetFor(a)).split("/"))), "clover-plugin-bun"));
  // A full release serves beta users too: its update files under the beta names.
  writeServedCopies(outDir, args.channel, args.arches.map((a) => (a === "x64" ? "linux-x64" : "linux-arm64")));
  // The commit these packages are of, for the owner's release step (scripts/release/publish.ts).
  for (const a of args.arches) writeBuildCommit(outDir, a === "x64" ? "linux-x64" : "linux-arm64", commit);
  // The identity scan over everything built (scripts/release/name-scan.ts): skipped, and said, without the guard.
  try {
    const scan = runNameScan(outDir, { required: false });
    console.log(scan.ran ? `build-packages: identity scan: ${scan.scanned}/${scan.total} files, no hit` : `build-packages: identity scan skipped (${scan.reason})`);
  } catch (err) {
    console.error(`build-packages: ${(err as Error).message}`);
    return 1;
  }
  if (args.check) {
    const problems = args.arches.flatMap((arch) => checkBuilt(outDir, arch, args.formats));
    for (const p of problems) console.error(`build-packages: ${p}`);
    if (problems.length > 0) return 1;
    console.log("build-packages: every package holds the daemon, the link sidecar, the AppArmor profile and packaging/linux's scripts");
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..")));
