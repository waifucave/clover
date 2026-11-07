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
// there for the channel and that each update file matches the files it names, on macOS that the dmg is signed
// and stapled, and that every OS was built from the same commit of main (each build's `BUILD-COMMIT-<os>.txt`),
// which the release is then tagged at (`gh release create --target`). The daemon's files for a server's self-update
// travel too: each OS's `clover-core-<version>-<target>` and `<channel>-core-<target>.yml`, the update file checked
// against the binary, and both signed. Without `--create-draft` it only prints what it would upload. With it, it signs each update file with
// the update feed's key from the login Keychain (an Ed25519 `.sig` beside it, packages/update-feed; the key is read
// into memory, checked against the one the app carries, and never written), and creates the release as a draft (a
// pre-release on beta) tagged v<version>; the owner reads it and publishes it on GitHub, which is the moment it
// reaches anyone.
//
// `--promote` turns a published beta into the latest release: it checks the beta update files' signatures (the app's
// and the daemon's), adds
// them under the latest names, signed again under those names with the Keychain's key (a signature covers the
// file's name), and makes it a full release. Without `--yes` it only prints. If it stops partway (an upload or the
// edit fails), the release is still a pre-release, beta users are unaffected and latest users see nothing new
// (electron-updater's latest channel ignores pre-releases); running it again replaces what it had uploaded
// (`--clobber`) and finishes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNATURE_SUFFIX, signFeed, verifyFeed } from "../../packages/update-feed/src/index";
import { keychain, signingKey } from "./feed-key";
import { buildCommitFile, checkCoreFeed, checkUpdateInfo, CORE_TARGET, expectedArtifacts, isCoreFeed, parseChannel, parseCodesignDisplay, parseUpdateInfo, type Channel, type ReleaseOs } from "./lib";
import { coreBinaryFile, parseCoreFeed } from "../../packages/update-feed/src/index";

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
  /** What is signed at --create-draft (`<name>.sig`): the update files, and the daemon's binaries. */
  feeds: string[];
  /** The commit every OS was built from, when they agree. */
  commit?: string;
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
      if (name.endsWith(".yml") || name === coreBinaryFile(version, CORE_TARGET[os])) feeds.push(name);
      if (isCoreFeed(name) && where.has(name)) {
        const readAny = (n: string) => (where.has(n) ? read(where.get(n)!, n) : undefined);
        problems.push(...checkCoreFeed(new TextDecoder().decode(read(where.get(name)!, name)), version, readAny).map((p) => `${name}: ${p}`));
      } else if (name.endsWith(".yml") && where.has(name)) {
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
  // Every OS from one commit: the release is tagged at it.
  const commits = new Map<ReleaseOs, string>();
  for (const os of RELEASE_OSES) {
    const name = buildCommitFile(os);
    const dir = where.get(name);
    if (dir === undefined) { problems.push(`${name} is missing: the ${os} build doesn't say which commit it is`); continue; }
    const commit = new TextDecoder().decode(read(dir, name)).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) problems.push(`${name} doesn't hold a commit (${JSON.stringify(commit.slice(0, 50))})`);
    else commits.set(os, commit);
  }
  const distinct = [...new Set(commits.values())];
  if (distinct.length > 1) problems.push(`the builds come from different commits: ${[...commits].map(([os, c]) => `${os} ${c.slice(0, 12)}`).join(", ")}`);
  return { version, channel, assets, feeds, ...(distinct.length === 1 && commits.size === RELEASE_OSES.length ? { commit: distinct[0]! } : {}), problems };
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
    const signature = signFeed(name, bytes, privateKey);
    const verdict = publicKey === undefined ? verifyFeed(name, bytes, signature) : verifyFeed(name, bytes, signature, publicKey);
    if (!verdict.ok) throw new Error(`${name}'s new signature doesn't verify against the app's key (${verdict.reason})`);
    return { name: `${name}${SIGNATURE_SUFFIX}`, signature };
  });
}

/** `gh release create` for the plan: tagged at the builds' commit, a draft, a pre-release on beta, never marked latest
 *  until the owner publishes. */
export function draftReleaseArgs(plan: ReleasePlan, repo: string): string[] {
  if (plan.commit === undefined) throw new Error("the plan has no commit to tag");
  return ["gh", "release", "create", `v${plan.version}`, "--repo", repo, "--target", plan.commit, "--draft", ...(plan.channel === "beta" ? ["--prerelease"] : []),
    "--title", `Clover ${plan.version}`, "--notes", `Clover ${plan.version}${plan.channel === "beta" ? " (beta)" : ""}.`,
    ...plan.assets.map((a) => join(a.dir, a.name))];
}

/** A checked beta update file's latest name and its signature under that name, checked against the app's key. */
export function promotedSignature(betaName: string, bytes: Uint8Array, privateKey: string, publicKey?: string | null): { name: string; signature: string } {
  const name = promotedName(betaName);
  const signature = signFeed(name, bytes, privateKey);
  const verdict = publicKey === undefined ? verifyFeed(name, bytes, signature) : verifyFeed(name, bytes, signature, publicKey);
  if (!verdict.ok) throw new Error(`${name}'s new signature doesn't verify against the app's key (${verdict.reason})`);
  return { name, signature };
}

/** A beta update file's latest name (`beta-mac.yml` → `latest-mac.yml`, `beta.yml` → `latest.yml`). */
export function promotedName(name: string): string {
  if (!BETA_FEED.test(name)) throw new Error(`${name} is not a beta update file`);
  return name.replace(/^beta/, "latest");
}

const REPO = "waifucave/clover";

/** A beta update file: the app's for each OS, and the daemon's for each target. */
const BETA_FEED = /^beta(-mac|-linux|-linux-arm64|-core-(darwin-arm64|linux-x64|linux-arm64|windows-x64))?\.yml$/;
/** A release's beta update files: the app's four and the daemon's four. */
const BETA_FEEDS = 8;

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

export async function main(argv: readonly string[], root: string): Promise<number> {
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
    const betas = info.assets.map((x) => x.name).filter((n) => BETA_FEED.test(n));
    if (betas.length !== BETA_FEEDS) { console.error(`release/publish: ${tag} has ${betas.length} beta update files, not ${BETA_FEEDS} (${betas.join(", ")})`); return 1; }
    const unsigned = betas.filter((n) => !info.assets.some((x) => x.name === `${n}${SIGNATURE_SUFFIX}`));
    if (unsigned.length > 0) { console.error(`release/publish: ${tag} has no signature for ${unsigned.join(", ")}`); return 1; }
    console.log(`release/publish: promote ${tag}: upload ${betas.map(promotedName).join(", ")} and their signatures, then make it a full release and the latest`);
    if (!a.yes) { console.log("release/publish: nothing done (add --yes)"); return 0; }
    const dir = mkdtempSync(join(tmpdir(), "clover-promote-"));
    try {
      const privateKey = await signingKey(keychain);
      if (gh(["gh", "release", "download", tag, "--repo", REPO, "--dir", dir, ...betas.flatMap((n) => ["--pattern", n, "--pattern", `${n}${SIGNATURE_SUFFIX}`])]).status !== 0) throw new Error("couldn't download the beta update files");
      const files = betas.flatMap((n) => {
        const bytes = new Uint8Array(readFileSync(join(dir, n)));
        const signature = readFileSync(join(dir, `${n}${SIGNATURE_SUFFIX}`), "utf8");
        const verdict = verifyFeed(n, bytes, signature);
        if (!verdict.ok) throw new Error(`${n}'s signature doesn't verify (${verdict.reason})`);
        const forVersion = isCoreFeed(n) ? parseCoreFeed(new TextDecoder().decode(bytes)).version : parseUpdateInfo(new TextDecoder().decode(bytes)).version;
        if (forVersion !== a.version) throw new Error(`${n} is not for ${a.version}`);
        const latest = promotedSignature(n, bytes, privateKey);
        writeFileSync(join(dir, latest.name), bytes);
        writeFileSync(join(dir, `${latest.name}${SIGNATURE_SUFFIX}`), latest.signature);
        return [join(dir, latest.name), join(dir, `${latest.name}${SIGNATURE_SUFFIX}`)];
      });
      const up = gh(["gh", "release", "upload", tag, "--repo", REPO, "--clobber", ...files]);
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
  if (plan.commit !== undefined) {
    // The builds' commit must be main's: a release never comes from a branch.
    spawnSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: root });
    if ((spawnSync("git", ["merge-base", "--is-ancestor", plan.commit, "origin/main"], { cwd: root }).status ?? 1) !== 0) plan.problems.push(`the builds' commit ${plan.commit} is not on main`);
  }
  const dmg = plan.assets.find((x) => x.name === `Clover-${version}.dmg`);
  if (dmg !== undefined) plan.problems.push(...macSignedAndStapled(join(dmg.dir, dmg.name)));
  for (const p of plan.problems) console.error(`release/publish: ${p}`);
  if (plan.problems.length > 0) return 1;
  console.log(`release/publish: v${version} on ${a.channel}, at ${plan.commit}, ${plan.assets.length} files, and a signature for each of ${plan.feeds.join(", ")}:`);
  for (const x of plan.assets) console.log(`  ${x.name}  (${x.dir})`);
  if (!a.create) { console.log("release/publish: nothing signed or uploaded (add --create-draft)"); return 0; }
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
