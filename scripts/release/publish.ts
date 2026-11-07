// The owner's release step (plan §4 M-M2): it gathers every OS's release build into one GitHub release of this
// repository, the feed electron-updater, the Homebrew cask and winget read (scripts/release/lib.ts). Nothing else
// in the repo publishes, and CI never runs this.
//
//   bun scripts/release/publish.ts --from <dir>[,<dir>…] [--channel latest|beta]            the plan, checked
//   bun scripts/release/publish.ts --from <dir>[,<dir>…] [--channel latest|beta] --create-draft
//   bun scripts/release/publish.ts --promote <version> [--yes]                                beta → latest
//
// `--from` names the folders holding the builds: this Mac's signed `apps/desktop/out/dist` and the release
// workflow's downloaded Windows and Linux artifacts. It checks that every OS's installers and update files are
// there for the channel and that each update file matches the files it names, and on macOS that the dmg is signed
// and stapled. Without `--create-draft` it only prints what it would upload. With it, it signs each update file with
// the update feed's key from the login Keychain (an Ed25519 `.sig` beside it, packages/update-feed; the key is read
// into memory, checked against the one the app carries, and never written), and creates the release as a draft (a
// pre-release on beta) tagged v<version>; the owner reads it and publishes it on GitHub, which is the moment it
// reaches anyone. Before any of that, a release with a macOS build must prove the sealed core on this Mac: the one
// Clover.app beside the dmg, whose `clover-core` must be byte for byte the one inside the shipped zip and the shipped
// dmg (mounted read-only, never shown), passes `verify:sealed-core --signed --require-proof` (the seal's premise, SIP
// on, proven here, never assumed), or no draft is made.
//
// `--promote` turns a published beta into the latest release: it checks the beta update files' signatures, adds
// them and their signatures under the latest names (the bytes are the same, so the signatures are too) and makes it
// a full release. Without `--yes` it only prints.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNATURE_SUFFIX, signFeed, verifyFeed } from "../../packages/update-feed/src/index";
import { keychain, signingKey } from "./feed-key";
import { checkUpdateInfo, expectedArtifacts, parseChannel, parseCodesignDisplay, parseUpdateInfo, type Channel, type ReleaseOs } from "./lib";

export const RELEASE_OSES: readonly ReleaseOs[] = ["mac", "win", "linux-x64", "linux-arm64"];

export type PublishArgs =
  | { mode: "draft"; from: string[]; channel: Channel; create: boolean }
  | { mode: "promote"; version: string; yes: boolean };

export function parsePublishArgs(argv: readonly string[]): PublishArgs {
  let from: string[] | undefined;
  let channel: Channel = "latest";
  let create = false;
  let promote: string | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (name: string): string | undefined => (a === name ? argv[++i] : a.slice(name.length + 1));
    if (a === "--create-draft") create = true;
    else if (a === "--yes") yes = true;
    else if (a === "--from" || a.startsWith("--from=")) from = (value("--from") ?? "").split(",").filter(Boolean);
    else if (a === "--channel" || a.startsWith("--channel=")) channel = parseChannel(value("--channel"));
    else if (a === "--promote" || a.startsWith("--promote=")) promote = value("--promote");
    else throw new Error(`unknown argument ${a} (usage: release/publish --from <dir>[,…] [--channel latest|beta] [--create-draft] | --promote <version> [--yes])`);
  }
  if (promote !== undefined) {
    if (from !== undefined || create) throw new Error("--promote takes a published version alone");
    if (!/^\d+\.\d+\.\d+$/.test(promote)) throw new Error(`--promote takes a version, such as 0.125.0 (not ${promote})`);
    return { mode: "promote", version: promote, yes };
  }
  if (from === undefined || from.length === 0) throw new Error("--from names the folders holding the release builds");
  if (yes) throw new Error("--yes is for --promote; a draft is created with --create-draft");
  return { mode: "draft", from, channel, create };
}

export interface ReleasePlan {
  version: string;
  channel: Channel;
  /** Each asset's name and the folder it comes from. */
  assets: Array<{ name: string; dir: string }>;
  /** The update files, each signed at --create-draft (`<name>.sig`). */
  feeds: string[];
  problems: string[];
}

/**
 * Gathers a release from the build folders (`list` and `read` look into them, for tests): every OS's installers and
 * update files for the channel, found once each, with each update file checked against the files it names. Block
 * maps travel with their files (electron-updater's partial downloads).
 */
export function planRelease(
  version: string,
  channel: Channel,
  dirs: readonly string[],
  list: (dir: string) => string[],
  read: (dir: string, name: string) => Uint8Array,
): ReleasePlan {
  const problems: string[] = [];
  const where = new Map<string, string>();
  for (const dir of dirs) {
    for (const name of list(dir)) {
      if (where.has(name) && where.get(name) !== dir) problems.push(`${name} is in both ${where.get(name)} and ${dir}`);
      else where.set(name, dir);
    }
  }
  const assets: Array<{ name: string; dir: string }> = [];
  const feeds: string[] = [];
  const add = (name: string) => {
    const dir = where.get(name);
    if (dir === undefined) problems.push(`${name} is missing`);
    else if (!assets.some((x) => x.name === name)) assets.push({ name, dir });
  };
  for (const os of RELEASE_OSES) {
    for (const name of expectedArtifacts(version, os, channel)) {
      add(name);
      if (name.endsWith(".yml")) feeds.push(name);
      if (name.endsWith(".yml") && where.has(name)) {
        const info = parseUpdateInfo(new TextDecoder().decode(read(where.get(name)!, name)));
        const readAny = (n: string) => (where.has(n) ? read(where.get(n)!, n) : undefined);
        problems.push(...checkUpdateInfo(info, version, readAny).map((p) => `${name}: ${p}`));
        for (const f of info.files) {
          add(f.url);
          if (where.has(`${f.url}.blockmap`)) add(`${f.url}.blockmap`);
        }
      }
    }
  }
  return { version, channel, assets, feeds, problems };
}

/**
 * The signatures for the plan's update files, each checked against the key the app carries (`publicKey`) before it
 * is kept: `privateKey` comes from the Keychain and is used only here.
 */
export function signFeeds(plan: ReleasePlan, read: (dir: string, name: string) => Uint8Array, privateKey: string, publicKey?: string | null): Array<{ name: string; signature: string }> {
  return plan.feeds.map((name) => {
    const asset = plan.assets.find((a) => a.name === name);
    if (asset === undefined) throw new Error(`${name} is not in the release`);
    const bytes = read(asset.dir, name);
    const signature = signFeed(bytes, privateKey);
    const verdict = publicKey === undefined ? verifyFeed(bytes, signature) : verifyFeed(bytes, signature, publicKey);
    if (!verdict.ok) throw new Error(`${name}'s new signature doesn't verify against the app's key (${verdict.reason})`);
    return { name: `${name}${SIGNATURE_SUFFIX}`, signature };
  });
}

/** `gh release create` for the plan: a draft, a pre-release on beta, never marked latest until the owner publishes. */
export function draftReleaseArgs(plan: ReleasePlan, repo: string): string[] {
  return ["gh", "release", "create", `v${plan.version}`, "--repo", repo, "--draft", ...(plan.channel === "beta" ? ["--prerelease"] : []),
    "--title", `Clover ${plan.version}`, "--notes", `Clover ${plan.version}${plan.channel === "beta" ? " (beta)" : ""}.`,
    ...plan.assets.map((a) => join(a.dir, a.name))];
}

/** A beta update file's latest name (`beta-mac.yml` → `latest-mac.yml`, `beta.yml` → `latest.yml`). */
export function promotedName(name: string): string {
  if (!/^beta(-mac|-linux|-linux-arm64)?\.yml$/.test(name)) throw new Error(`${name} is not a beta update file`);
  return name.replace(/^beta/, "latest");
}

const REPO = "waifucave/clover";

const CORE_IN_APP = ["Clover.app", "Contents", "Resources", "daemon", "clover-core"] as const;

/** How the shipped copies are opened: the update zip with `ditto -x -k`, the dmg read-only with `hdiutil attach
 *  -nobrowse -noautoopen` (mounted, never shown in the Finder or opened) at a temp mount point, detached after. */
export interface ShippedOpeners {
  extractZip(zip: string, dest: string): boolean;
  /** Mounts the dmg at `mountpoint`; answers how to detach it, or undefined when it couldn't mount. */
  mountDmg(dmg: string, mountpoint: string): (() => void) | undefined;
}

export const REAL_SHIPPED_OPENERS: ShippedOpeners = {
  extractZip: (zip, dest) => (spawnSync("ditto", ["-x", "-k", zip, dest]).status ?? 1) === 0,
  mountDmg: (dmg, mountpoint) => {
    const r = spawnSync("hdiutil", ["attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mountpoint, dmg], { encoding: "utf8" });
    if (r.status !== 0) return undefined;
    return () => { if ((spawnSync("hdiutil", ["detach", mountpoint]).status ?? 1) !== 0) spawnSync("hdiutil", ["detach", "-force", mountpoint]); };
  },
};

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The macOS core the release ships, or why it can't be named. Only the dmg's own folder counts (a stale `mac*`
 * folder elsewhere among `--from` never does), and it must hold exactly one `Clover.app`. That app's core must be
 * byte for byte the one inside the shipped update zip and the one inside the shipped dmg, so the binary proven is the
 * binary that ships.
 */
export function shippedMacCore(dmgDir: string, version: string, openers: ShippedOpeners = REAL_SHIPPED_OPENERS, list: (dir: string) => string[] = (d) => { try { return readdirSync(d); } catch { return []; } }): { core: string } | { problem: string } {
  const apps = list(dmgDir).filter((n) => n === "mac" || n.startsWith("mac-")).filter((sub) => existsSync(join(dmgDir, sub, "Clover.app")));
  if (apps.length !== 1) return { problem: `${dmgDir} must hold exactly one mac*/Clover.app beside the dmg, not ${apps.length}` };
  const core = join(dmgDir, apps[0]!, ...CORE_IN_APP);
  if (!existsSync(core)) return { problem: `${join(dmgDir, apps[0]!, "Clover.app")} has no Contents/Resources/daemon/clover-core` };
  const want = sha256Of(core);
  const work = mkdtempSync(join(tmpdir(), "clover-shipped-core-"));
  try {
    const zip = join(dmgDir, `Clover-${version}-mac.zip`);
    if (!existsSync(zip)) return { problem: `no ${zip}: the update zip's core can't be compared` };
    const zipped = join(work, "zip");
    mkdirSync(zipped);
    if (!openers.extractZip(zip, zipped) || !existsSync(join(zipped, ...CORE_IN_APP))) return { problem: `${zip} holds no Clover.app/Contents/Resources/daemon/clover-core` };
    if (sha256Of(join(zipped, ...CORE_IN_APP)) !== want) return { problem: `the clover-core in ${zip} is not the one in ${join(dmgDir, apps[0]!)}` };
    const dmg = join(dmgDir, `Clover-${version}.dmg`);
    const mount = join(work, "dmg");
    mkdirSync(mount);
    const detach = openers.mountDmg(dmg, mount);
    if (detach === undefined) return { problem: `${dmg} could not be mounted read-only` };
    try {
      if (!existsSync(join(mount, ...CORE_IN_APP))) return { problem: `${dmg} holds no Clover.app/Contents/Resources/daemon/clover-core` };
      if (sha256Of(join(mount, ...CORE_IN_APP)) !== want) return { problem: `the clover-core in ${dmg} is not the one in ${join(dmgDir, apps[0]!)}` };
    } finally {
      detach();
    }
    return { core };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The proof command: the sealed-core gate on the signed core, failing on anything it can't prove. */
export function sealProofCommand(core: string, root: string): string[] {
  return [process.execPath, join(root, "scripts", "verify-sealed-core.ts"), "--binary", core, "--signed", "--require-proof"];
}

/** Why no draft may be made without the sealed core's proof, or undefined when the core that ships is proven. */
export function sealProofProblem(dmg: { dir: string; name: string } | undefined, version: string, prove: (core: string) => boolean, openers: ShippedOpeners = REAL_SHIPPED_OPENERS): string | undefined {
  if (dmg === undefined) return undefined;
  const shipped = shippedMacCore(dmg.dir, version, openers);
  if ("problem" in shipped) return `${shipped.problem}: the sealed core that ships can't be proven`;
  return prove(shipped.core) ? undefined : `verify:sealed-core --require-proof failed on ${shipped.core}: no draft without the seal's proof (it needs a Mac with SIP on)`;
}

function gh(args: readonly string[]): { status: number; out: string } {
  const r = spawnSync("gh", args.slice(1) as string[], { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function macSignedAndStapled(dmg: string): string[] {
  if (process.platform !== "darwin") return ["the owner's release step runs on the Mac that signed the dmg"];
  const sig = parseCodesignDisplay(spawnSync("codesign", ["-dvvv", dmg], { encoding: "utf8" }).stderr ?? "");
  const problems: string[] = [];
  if (sig.adhoc || sig.teamId === undefined) problems.push(`${dmg} is not signed with a Developer ID`);
  if ((spawnSync("xcrun", ["stapler", "validate", dmg]).status ?? 1) !== 0) problems.push(`${dmg} has no notarization staple`);
  return problems;
}

export async function main(argv: readonly string[], root: string, deps: { proveSeal?: (core: string) => boolean; openers?: ShippedOpeners } = {}): Promise<number> {
  let a: PublishArgs;
  try {
    a = parsePublishArgs(argv);
  } catch (err) {
    console.error(`release/publish: ${(err as Error).message}`);
    return 2;
  }
  if (a.mode === "promote") {
    const tag = `v${a.version}`;
    const view = gh(["gh", "release", "view", tag, "--repo", REPO, "--json", "isPrerelease,isDraft,assets"]);
    if (view.status !== 0) { console.error(`release/publish: no release ${tag}: ${view.out.trim()}`); return 1; }
    const info = JSON.parse(view.out) as { isPrerelease: boolean; isDraft: boolean; assets: Array<{ name: string }> };
    if (info.isDraft || !info.isPrerelease) { console.error(`release/publish: ${tag} is ${info.isDraft ? "a draft" : "already a full release"}: only a published beta is promoted`); return 1; }
    const betas = info.assets.map((x) => x.name).filter((n) => /^beta(-mac|-linux|-linux-arm64)?\.yml$/.test(n));
    if (betas.length !== 4) { console.error(`release/publish: ${tag} has ${betas.length} beta update files, not 4 (${betas.join(", ")})`); return 1; }
    const unsigned = betas.filter((n) => !info.assets.some((x) => x.name === `${n}${SIGNATURE_SUFFIX}`));
    if (unsigned.length > 0) { console.error(`release/publish: ${tag} has no signature for ${unsigned.join(", ")}`); return 1; }
    console.log(`release/publish: promote ${tag}: upload ${betas.map(promotedName).join(", ")} and their signatures, then make it a full release and the latest`);
    if (!a.yes) { console.log("release/publish: nothing done (add --yes)"); return 0; }
    const dir = mkdtempSync(join(tmpdir(), "clover-promote-"));
    try {
      if (gh(["gh", "release", "download", tag, "--repo", REPO, "--dir", dir, ...betas.flatMap((n) => ["--pattern", n, "--pattern", `${n}${SIGNATURE_SUFFIX}`])]).status !== 0) throw new Error("couldn't download the beta update files");
      const files = betas.flatMap((n) => {
        const bytes = new Uint8Array(readFileSync(join(dir, n)));
        const signature = readFileSync(join(dir, `${n}${SIGNATURE_SUFFIX}`), "utf8");
        const verdict = verifyFeed(bytes, signature);
        if (!verdict.ok) throw new Error(`${n}'s signature doesn't verify (${verdict.reason})`);
        if (parseUpdateInfo(new TextDecoder().decode(bytes)).version !== a.version) throw new Error(`${n} is not for ${a.version}`);
        writeFileSync(join(dir, promotedName(n)), bytes);
        writeFileSync(join(dir, `${promotedName(n)}${SIGNATURE_SUFFIX}`), signature);
        return [join(dir, promotedName(n)), join(dir, `${promotedName(n)}${SIGNATURE_SUFFIX}`)];
      });
      const up = gh(["gh", "release", "upload", tag, "--repo", REPO, ...files]);
      if (up.status !== 0) throw new Error(`the upload failed: ${up.out.trim()}`);
      const edit = gh(["gh", "release", "edit", tag, "--repo", REPO, "--prerelease=false", "--latest"]);
      if (edit.status !== 0) throw new Error(`the release edit failed: ${edit.out.trim()}`);
      console.log(`release/publish: ${tag} is the latest release`);
      return 0;
    } catch (err) {
      console.error(`release/publish: ${(err as Error).message}`);
      return 1;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const version = (JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")) as { version: string }).version;
  for (const d of a.from) if (!existsSync(d)) { console.error(`release/publish: ${d} doesn't exist`); return 2; }
  const plan = planRelease(version, a.channel, a.from, (d) => readdirSync(d), (d, n) => new Uint8Array(readFileSync(join(d, n))));
  const dmg = plan.assets.find((x) => x.name === `Clover-${version}.dmg`);
  if (dmg !== undefined) plan.problems.push(...macSignedAndStapled(join(dmg.dir, dmg.name)));
  for (const p of plan.problems) console.error(`release/publish: ${p}`);
  if (plan.problems.length > 0) return 1;
  console.log(`release/publish: v${version} on ${a.channel}, ${plan.assets.length} files, and a signature for each of ${plan.feeds.join(", ")}:`);
  for (const x of plan.assets) console.log(`  ${x.name}  (${x.dir})`);
  if (!a.create) { console.log("release/publish: nothing signed or uploaded (add --create-draft)"); return 0; }
  {
    const prove = deps.proveSeal ?? ((core: string) => {
      const [cmd, ...args] = sealProofCommand(core, root);
      console.log(`release/publish: proving the sealed core: ${[cmd, ...args].join(" ")}`);
      return (spawnSync(cmd!, args, { cwd: root, stdio: "inherit" }).status ?? 1) === 0;
    });
    const problem = sealProofProblem(dmg, version, prove, deps.openers);
    if (problem !== undefined) { console.error(`release/publish: ${problem}`); return 1; }
  }
  if (gh(["gh", "release", "view", `v${version}`, "--repo", REPO]).status === 0) { console.error(`release/publish: v${version} already exists`); return 1; }
  const sigDir = mkdtempSync(join(tmpdir(), "clover-feed-sigs-"));
  try {
    const privateKey = await signingKey(keychain);
    for (const s of signFeeds(plan, (d, n) => new Uint8Array(readFileSync(join(d, n))), privateKey)) {
      writeFileSync(join(sigDir, s.name), s.signature);
      plan.assets.push({ name: s.name, dir: sigDir });
    }
    const created = gh(draftReleaseArgs(plan, REPO));
    if (created.status !== 0) { console.error(`release/publish: gh release create failed: ${created.out.trim()}`); return 1; }
    console.log(`release/publish: the draft is up: ${created.out.trim()}. Publishing it on GitHub releases it.`);
    return 0;
  } catch (err) {
    console.error(`release/publish: ${(err as Error).message}`);
    return 1;
  } finally {
    rmSync(sigDir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
