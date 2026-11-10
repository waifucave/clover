// The release (scripts/release/): the channels and feed, the update files, the signing commands and their checks,
// the release build's and the owner's publish step's plans, and the release workflow's limits (no secrets, nothing
// published). Nothing here signs, builds or publishes.
import { PLUGIN_BUN } from "../bundled-binaries";
import { CLOVER_TEAM_ID } from "../../packages/core/src/auth/app-token-acl";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { darwinTest } from "../../packages/core/test/helpers/darwin-only";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builderEnv, builderIdentity, buildOsFor, devSigningIdentity, main as buildMain, NOTARIZE_ENV, signOnlyOutputs, TEST_BUILD_OUT, testBuildArtifacts, isMachO, machOFiles, nativeIdentifier, packedMachO, parseReleaseBuildArgs, releaseBuilderArgs, signingInputs, CLOVER_APP_REQUIREMENT, CLOVER_APP_DEV_SIGNED_REQUIREMENT } from "./build";
import { checkoutCommit, dirtyEntries, pluginBunArtifacts, pluginsArtifacts, writePluginsAssets, tarballFilesOf,
  channelsServed, checkCoreFeed, checkUpdateInfo, codesignArgs, coreArtifacts, CORE_TARGET, expectedArtifacts, FEED, feedFile, formatUpdateInfo, identityTeam, installers,
  notarizeArgs, parseCodesignDisplay, parseUpdateInfo, refreshEntry, RESOURCE_BINARIES, sha512Base64, signatureProblems, codesignDevArgs, teamRequirement,
  writeCoreAssets, writeServedCopies, authenticodeCommand, authenticodeProblems, buildCommitFile, parseEntitlementKeys, testBuildCommitProblem, writeBuildCommit,
} from "./lib";
import { TEST_BUILD_LABEL, TEST_BUILD_SENTINEL } from "../test-build";
import { pluginsFeedFile, pluginsTarballFile, parsePluginsFeed, unpackTarball, pluginBunBinaryFile, pluginBunFeedFile, coreBinaryFile, coreFeedFile, formatCoreFeed, generateFeedKey, parseCoreFeed, publicKeyOf, verifyFeed } from "../../packages/update-feed/src/index";
import { FEED_KEY_ITEM, generate, signingKey, withPublicKey, type KeyStore } from "./feed-key";
import { draftReleaseArgs, parsePublishArgs, planRelease, promotedName, promotedSignature, RELEASE_OSES, signFeeds, proveShippedMacCore, sealProofCommand, sealProofProblem, type ShippedOpeners } from "./publish";

/** A Keychain of the test's own: the real one is never touched. */
function memoryStore(): KeyStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: async (i) => items.get(`${i.service}/${i.name}`) ?? null,
    set: async (i) => { items.set(`${i.service}/${i.name}`, i.value); },
  };
}

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
// biome-ignore lint: a parsed YAML document
const builder = Bun.YAML.parse(read("apps/desktop/electron-builder.yml")) as Record<string, any>;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("the feed and the channels", () => {
  test("electron-builder writes for the GitHub feed, and a full release's files are copied for every channel it serves", () => {
    expect(builder.publish).toEqual(FEED);
    const dir = mkdtempSync(join(tmpdir(), "clover-release-served-"));
    writeFileSync(join(dir, "latest-mac.yml"), "version: 1.2.3\n");
    writeFileSync(join(dir, "latest-linux-arm64.yml"), "version: 1.2.3\n");
    expect(writeServedCopies(dir, "latest", ["mac", "win", "linux-arm64"])).toEqual(["beta-mac.yml", "beta-linux-arm64.yml"]);
    expect(readFileSync(join(dir, "beta-mac.yml"), "utf8")).toBe("version: 1.2.3\n");
    expect(writeServedCopies(dir, "beta", ["mac"])).toEqual([]);
    expect(channelsServed("latest")).toEqual(["latest", "beta"]);
    expect(channelsServed("beta")).toEqual(["beta"]);
    expect(RELEASE_OSES.map((os) => feedFile("beta", os))).toEqual(["beta-mac.yml", "beta.yml", "beta-linux.yml", "beta-linux-arm64.yml"]);
  });

  test("the installers carry the names the cask, winget and the update files use", () => {
    expect(builder.dmg.artifactName).toBe("Clover-${version}.${ext}");
    expect(builder.mac.artifactName).toBe("Clover-${version}-mac.${ext}");
    expect(builder.nsis.artifactName).toBe("Clover-Setup-${version}.${ext}");
    expect(read("packaging/clover.rb.tmpl")).toContain("/releases/download/v#{version}/Clover-#{version}.dmg");
    expect(installers("1.2.3", "mac")).toEqual(["Clover-1.2.3.dmg", "Clover-1.2.3-mac.zip"]);
    expect(installers("1.2.3", "linux-arm64")).toEqual(["clover_1.2.3_arm64.deb", "clover-1.2.3.arm64.rpm", "Clover-1.2.3-arm64.AppImage"]);
    expect(expectedArtifacts("1.2.3", "win", "latest")).toEqual(["Clover-Setup-1.2.3.exe", "latest.yml", "beta.yml", "clover-core-1.2.3-windows-x64.exe", "latest-core-windows-x64.yml", "beta-core-windows-x64.yml",
      `clover-plugin-bun-${PLUGIN_BUN.version}-windows-x64.exe`, "latest-plugin-bun-windows-x64.yml", "beta-plugin-bun-windows-x64.yml",
      "clover-plugins-1.2.3-windows-x64.tar.gz", "latest-plugins-windows-x64.yml", "beta-plugins-windows-x64.yml"]);
    expect(pluginsArtifacts("1.2.3", "linux-arm64", "beta")).toEqual(["clover-plugins-1.2.3-linux-arm64.tar.gz", "beta-plugins-linux-arm64.yml"]);
    expect(pluginBunArtifacts("linux-arm64", "beta")).toEqual([`clover-plugin-bun-${PLUGIN_BUN.version}-linux-arm64`, "beta-plugin-bun-linux-arm64.yml"]);
    expect(coreArtifacts("1.2.3", "linux-arm64", "beta")).toEqual(["clover-core-1.2.3-linux-arm64", "beta-core-linux-arm64.yml"]);
  });

  test("a release builds from a fully clean checkout: an edit, a staged change or an untracked file anywhere refuses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-release-checkout-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    git("init", "-q");
    mkdirSync(join(dir, "packages", "core"), { recursive: true });
    writeFileSync(join(dir, "packages", "core", "a.ts"), "export {};\n");
    writeFileSync(join(dir, ".gitignore"), "dist/\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c");
    const head = git("rev-parse", "HEAD");
    expect(checkoutCommit(dir)).toBe(head);
    // What the build writes is ignored: still clean.
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "clover-core"), "built");
    expect(checkoutCommit(dir)).toBe(head);
    writeFileSync(join(dir, "packages", "core", "a.ts"), "export const x = 1;\n");
    expect(() => checkoutCommit(dir)).toThrow("fully clean checkout");
    git("checkout", "--", ".");
    writeFileSync(join(dir, "services.ts"), "untracked");
    expect(() => checkoutCommit(dir)).toThrow("services.ts");
    git("add", "services.ts");
    expect(() => checkoutCommit(dir)).toThrow("fully clean checkout");
    expect(dirtyEntries("")).toEqual([]);
    expect(dirtyEntries(" M a.ts\n?? b.ts\n")).toEqual([" M a.ts", "?? b.ts"]);
  });

  test("the bundled plugins' release files: the app's resources/plugins packed, and an update file naming it", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-plugins-assets-"));
    const plugins = join(dir, "resources", "plugins");
    mkdirSync(join(plugins, "clover", "bin"), { recursive: true });
    writeFileSync(join(plugins, "clover", "clover.json"), "{}");
    writeFileSync(join(plugins, "clover", "bin", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const out = join(dir, "out");
    mkdirSync(out);
    expect(writePluginsAssets(out, "1.2.3", "linux-x64", "latest", plugins)).toEqual(["clover-plugins-1.2.3-linux-x64.tar.gz", "latest-plugins-linux-x64.yml", "beta-plugins-linux-x64.yml"]);
    const tarball = new Uint8Array(readFileSync(join(out, "clover-plugins-1.2.3-linux-x64.tar.gz")));
    const files = unpackTarball(tarball);
    expect(files.map((f) => [f.path, f.executable])).toEqual([["clover/bin/run.sh", process.platform !== "win32"], ["clover/clover.json", false]]);
    const feed = parsePluginsFeed(readFileSync(join(out, "beta-plugins-linux-x64.yml"), "utf8"));
    expect(feed).toEqual({ version: "1.2.3", file: "clover-plugins-1.2.3-linux-x64.tar.gz", sha512: sha512Base64(tarball), size: tarball.length });
    expect(tarballFilesOf(plugins).map((f) => f.path)).toEqual(["clover/bin/run.sh", "clover/clover.json"]);
  });

  test("the daemon's release files: its binary and an update file naming it, for each channel served", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-core-assets-"));
    const bin = join(dir, "built-clover-core");
    writeFileSync(bin, "a daemon");
    expect(writeCoreAssets(dir, "1.2.3", "mac", "latest", bin)).toEqual(["clover-core-1.2.3-darwin-arm64", "latest-core-darwin-arm64.yml", "beta-core-darwin-arm64.yml"]);
    const feed = parseCoreFeed(readFileSync(join(dir, "latest-core-darwin-arm64.yml"), "utf8"));
    expect(feed).toEqual({ version: "1.2.3", file: "clover-core-1.2.3-darwin-arm64", sha512: sha512Base64(utf8("a daemon")), size: 8 });
    expect(readFileSync(join(dir, "beta-core-darwin-arm64.yml"), "utf8")).toBe(readFileSync(join(dir, "latest-core-darwin-arm64.yml"), "utf8"));
    const at = (n: string) => (n === feed.file ? utf8("a daemon") : undefined);
    expect(checkCoreFeed(formatCoreFeed(feed), "1.2.3", at)).toEqual([]);
    expect(checkCoreFeed(formatCoreFeed(feed), "1.2.4", at)).toEqual(["it is for 1.2.3, not 1.2.4"]);
    expect(checkCoreFeed(formatCoreFeed(feed), "1.2.3", () => utf8("another"))).toEqual(["clover-core-1.2.3-darwin-arm64's sha512 doesn't match", "clover-core-1.2.3-darwin-arm64's size is 7, not 8"]);
    expect(checkCoreFeed(formatCoreFeed(feed), "1.2.3", () => undefined)).toEqual(["clover-core-1.2.3-darwin-arm64 is missing"]);
    expect(checkCoreFeed("version: 1.2.3\n", "1.2.3", at)).toHaveLength(1);
  });

  test("macOS: the hardened runtime, the app's entitlements, notarization off unless the release turns it on, and the resources' binaries left to the release", () => {
    expect(builder.mac.identity).toBeNull();
    expect(builder.mac.notarize).toBe(false);
    expect(builder.mac.hardenedRuntime).toBe(true);
    expect(builder.mac.signIgnore).toEqual(["Contents/Resources/daemon/", "Contents/Resources/plugins/"]);
    const ent = read("packaging/macos/entitlements.mac.plist");
    expect(ent).toContain("com.apple.security.cs.allow-jit");
    expect(ent).not.toContain("disable-library-validation");
    expect(RESOURCE_BINARIES.map((b) => b.file)).toEqual(builder.extraResources[0].filter.filter((f: string) => !f.endsWith(".exe")));
    // Each its own identifier; only the core's is the core's.
    expect(new Set(RESOURCE_BINARIES.map((b) => b.identifier)).size).toBe(RESOURCE_BINARIES.length);
    expect(RESOURCE_BINARIES.find((b) => b.file === "clover-plugin-bun")?.entitlements).toBe("scripts/clover-plugin-bun.entitlements");
    expect(RESOURCE_BINARIES.find((b) => b.file === "clover-process-holder")?.entitlements).toBeUndefined();
    expect(read("scripts/clover-core.entitlements")).toContain("com.apple.security.cs.allow-jit");
  });
});

describe("update files", () => {
  const zip = utf8("zip bytes");
  const dmg = utf8("dmg bytes");
  const info = {
    version: "1.2.3",
    files: [{ url: "Clover-1.2.3-mac.zip", sha512: sha512Base64(zip), size: zip.length }, { url: "Clover-1.2.3.dmg", sha512: sha512Base64(dmg), size: dmg.length, blockMapSize: 9 }],
    path: "Clover-1.2.3-mac.zip",
    sha512: sha512Base64(zip),
    releaseDate: "2026-11-06T00:00:00.000Z",
  };
  const files = new Map([["Clover-1.2.3-mac.zip", zip], ["Clover-1.2.3.dmg", dmg]]);

  test("round-trip, and check against the files they name", () => {
    const back = parseUpdateInfo(formatUpdateInfo(info));
    expect(back).toEqual(info);
    expect(checkUpdateInfo(back, "1.2.3", (n) => files.get(n))).toEqual([]);
    expect(checkUpdateInfo(back, "1.2.4", (n) => files.get(n))).toEqual(["it is for 1.2.3, not 1.2.4"]);
    expect(checkUpdateInfo(back, "1.2.3", (n) => (n.endsWith(".dmg") ? utf8("other") : files.get(n)))).toEqual(["Clover-1.2.3.dmg's sha512 doesn't match", "Clover-1.2.3.dmg's size is 5, not 9"]);
    expect(checkUpdateInfo(back, "1.2.3", () => undefined)).toEqual(["Clover-1.2.3-mac.zip is missing", "Clover-1.2.3.dmg is missing"]);
    expect(() => parseUpdateInfo("version: 1\n")).toThrow(/needs a version and files/);
  });

  test("a stapled dmg's entry is measured again, and its stale block map goes", () => {
    const stapled = utf8("dmg bytes, stapled");
    const fresh = refreshEntry(info, "Clover-1.2.3.dmg", stapled);
    expect(fresh.files[1]).toEqual({ url: "Clover-1.2.3.dmg", sha512: sha512Base64(stapled), size: stapled.length });
    expect(fresh.files[0]).toEqual(info.files[0]);
    expect(fresh.sha512).toBe(info.sha512);
    expect(checkUpdateInfo(fresh, "1.2.3", (n) => (n.endsWith(".dmg") ? stapled : files.get(n)))).toEqual([]);
    expect(() => refreshEntry(info, "nope.dmg", stapled)).toThrow(/no nope.dmg/);
  });
});

describe("macOS signing", () => {
  test("a release signs with a Developer ID named in full, and its team is read from the name", () => {
    expect(identityTeam("Developer ID Application: Example Ltd (AB12CD34EF)")).toBe("AB12CD34EF");
    expect(() => identityTeam("Apple Development: someone (AB12CD34EF)")).toThrow(/Developer ID Application/);
    expect(() => identityTeam("AB12CD34EF")).toThrow();
  });

  test("the resources' binaries: hardened runtime, a timestamp, their own identifiers, the daemon's JIT entitlements and none for the sidecar", () => {
    const [core, link] = RESOURCE_BINARIES;
    expect(codesignArgs("x/clover-core", "ID", core.identifier, core.entitlements)).toEqual(
      ["codesign", "--force", "--sign", "ID", "--options", "runtime", "--timestamp", "--identifier", "com.waifucave.clover.core", "--entitlements", "scripts/clover-core.entitlements", "x/clover-core"]);
    expect(codesignArgs("x/clover-core", "ID", core.identifier, core.entitlements, { restrict: core.restrict })).toEqual(
      ["codesign", "--force", "--sign", "ID", "--options", "runtime,restrict", "--timestamp", "--identifier", "com.waifucave.clover.core", "--entitlements", "scripts/clover-core.entitlements", "x/clover-core"]);
    expect(codesignArgs("x/clover-link", "ID", link.identifier, link.entitlements)).not.toContain("--entitlements");
    expect(notarizeArgs("C.dmg", "clover-notary")).toEqual(["xcrun", "notarytool", "submit", "C.dmg", "--keychain-profile", "clover-notary", "--wait"]);
  });

  test("codesign's report is read, and a signature notarization would refuse is named", () => {
    const signed = [
      "Executable=/x/clover-core",
      "Identifier=com.waifucave.clover.core",
      "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded",
      "Authority=Developer ID Application: Example Ltd (AB12CD34EF)",
      "Timestamp=6 Nov 2026 at 12:00:00",
      "TeamIdentifier=AB12CD34EF",
    ].join("\n");
    const sig = parseCodesignDisplay(signed);
    expect(sig).toEqual({ identifier: "com.waifucave.clover.core", teamId: "AB12CD34EF", runtime: true, restrict: false, timestamped: true, adhoc: false });
    expect(signatureProblems("clover-core", sig, "AB12CD34EF", "com.waifucave.clover.core")).toEqual([]);
    expect(signatureProblems("clover-core", sig, "ZZZZZZZZZZ")).toEqual(["clover-core is signed by team AB12CD34EF, not ZZZZZZZZZZ"]);
    const adhoc = parseCodesignDisplay("Identifier=clover-link\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1\nSignature=adhoc\nTeamIdentifier=not set\n");
    expect(signatureProblems("clover-link", adhoc, "AB12CD34EF", "com.waifucave.clover.link")).toEqual([
      "clover-link is not signed with a Developer ID", "clover-link has no hardened runtime", "clover-link has no secure timestamp",
      "clover-link's identifier is clover-link, not com.waifucave.clover.link",
    ]);
  });
});

describe("the release build (scripts/release/build.ts)", () => {
  test("it builds for its own OS: Apple silicon Macs and x64 Windows; another OS only in a dry run", () => {
    expect(buildOsFor("darwin", "arm64")).toBe("mac");
    expect(buildOsFor("win32", "x64")).toBe("win");
    expect(buildOsFor("darwin", "x64")).toBeUndefined();
    expect(buildOsFor("linux", "x64")).toBeUndefined();
    expect(parseReleaseBuildArgs([], "darwin", "arm64")).toEqual({ os: "mac", channel: "latest", sign: false, signDev: false, dryRun: false });
    expect(parseReleaseBuildArgs(["--channel=beta", "--sign"], "win32", "x64")).toEqual({ os: "win", channel: "beta", sign: true, signDev: false, dryRun: false });
    expect(parseReleaseBuildArgs(["--os", "win", "--dry-run"], "darwin", "arm64").os).toBe("win");
    expect(() => parseReleaseBuildArgs(["--os", "win"], "darwin", "arm64")).toThrow(/dry run/);
    expect(() => parseReleaseBuildArgs([], "linux", "x64")).toThrow(/build-packages/);
    expect(() => parseReleaseBuildArgs(["--channel", "nightly"], "darwin", "arm64")).toThrow(/latest or beta/);
  });

  test("unsigned unless --sign, whatever the environment holds; never publishing", () => {
    const env = { CLOVER_MAC_IDENTITY: "Developer ID Application: Example Ltd (AB12CD34EF)", APPLE_KEYCHAIN_PROFILE: "p", CSC_LINK: "x", WIN_CSC_LINK: "y", PATH: "/bin" };
    const unsigned = { os: "mac", channel: "latest", sign: false, signDev: false, dryRun: false } as const;
    expect(releaseBuilderArgs(unsigned, env)).toEqual(["electron-builder", "--mac", "dmg", "zip", "--arm64", "--publish", "never", "-c.publish.channel=latest"]);
    expect(builderEnv(unsigned, env)).toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
    const signed = { ...unsigned, sign: true };
    // electron-builder refuses the "Developer ID Application: " prefix (it picks the type itself): the name without it.
    expect(releaseBuilderArgs(signed, env)).toEqual([...releaseBuilderArgs(unsigned, env), "-c.mac.identity=Example Ltd (AB12CD34EF)", "-c.mac.notarize=true"]);
    expect(builderIdentity("Developer ID Application: Example Ltd (AB12CD34EF)")).toBe("Example Ltd (AB12CD34EF)");
    expect(() => builderIdentity("Example Ltd (AB12CD34EF)")).toThrow(/named in full/);
    expect(builderEnv(signed, env)).toBe(env);
    const win = { os: "win", channel: "beta", sign: true, signDev: false, dryRun: false } as const;
    expect(releaseBuilderArgs(win, { CLOVER_WIN_PUBLISHER: "Example Ltd" })).toEqual(
      ["electron-builder", "--win", "nsis", "--x64", "--publish", "never", "-c.publish.channel=beta", "-c.win.forceCodeSigning=true", "-c.win.signtoolOptions.publisherName=Example Ltd"]);
    for (const a of [unsigned, signed, win]) expect(releaseBuilderArgs(a, env)).toContain("never");
  });

  test("--sign names what it misses, never a value", () => {
    expect(signingInputs("mac", {})).toEqual({ missing: ["CLOVER_MAC_IDENTITY", "APPLE_KEYCHAIN_PROFILE"], problems: [] });
    expect(signingInputs("mac", { CLOVER_MAC_IDENTITY: "Apple Development: x (AB12CD34EF)", APPLE_KEYCHAIN_PROFILE: "p" }).problems).toHaveLength(1);
    expect(signingInputs("win", { WIN_CSC_LINK: "secret-path" })).toEqual({ missing: ["WIN_CSC_KEY_PASSWORD", "CLOVER_WIN_PUBLISHER"], problems: [] });
  });

  test("a macOS release signs with Clover's team only: the Keychain items and plugin Bun's requirement name it", () => {
    expect(signingInputs("mac", { CLOVER_MAC_IDENTITY: `Developer ID Application: Clover (${CLOVER_TEAM_ID})`, APPLE_KEYCHAIN_PROFILE: "p" }).problems).toEqual([]);
    expect(signingInputs("mac", { CLOVER_MAC_IDENTITY: "Developer ID Application: Someone (AB12CD34EF)", APPLE_KEYCHAIN_PROFILE: "p" }).problems).toEqual([`CLOVER_MAC_IDENTITY is team AB12CD34EF, not Clover's ${CLOVER_TEAM_ID}: the core's Keychain items and plugin Bun's check would refuse what it signs`]);
    expect(CLOVER_APP_REQUIREMENT).toBe(`identifier "com.waifucave.clover" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`);
    expect(CLOVER_APP_DEV_SIGNED_REQUIREMENT).toBe(`identifier "com.waifucave.clover" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`);
  });

  // A test-marked build (scripts/test-build.ts): Developer ID signed, never notarized, into its own folder.
  test("--sign --no-notarize: macOS only, with --sign alone; the Developer ID without notarization, none of notarization's inputs, out/dist", () => {
    expect(parseReleaseBuildArgs(["--sign", "--no-notarize"], "darwin", "arm64")).toEqual({ os: "mac", channel: "beta", sign: true, signDev: false, signOnly: true, dryRun: false });
    expect(() => parseReleaseBuildArgs(["--no-notarize"], "darwin", "arm64")).toThrow(/with --sign alone/);
    expect(() => parseReleaseBuildArgs(["--sign-dev", "--no-notarize"], "darwin", "arm64")).toThrow(/with --sign alone/);
    expect(() => parseReleaseBuildArgs(["--test-build", "--no-notarize"], "darwin", "arm64")).toThrow(/with --sign alone/);
    expect(() => parseReleaseBuildArgs(["--sign", "--no-notarize"], "win32", "x64")).toThrow(/macOS/);
    expect(() => parseReleaseBuildArgs(["--sign", "--no-notarize", "--os", "win", "--dry-run"], "darwin", "arm64")).toThrow(/macOS/);
    // --sign alone is unchanged: notarized.
    expect(parseReleaseBuildArgs(["--sign"], "darwin", "arm64").signOnly).toBeUndefined();
    const a = parseReleaseBuildArgs(["--sign", "--no-notarize"], "darwin", "arm64");
    const env = { CLOVER_MAC_IDENTITY: "Developer ID Application: Example (ABCDE12345)", APPLE_KEYCHAIN_PROFILE: "p", APPLE_ID: "x", APPLE_API_KEY: "k", OTHER: "kept" };
    const args = releaseBuilderArgs(a, env);
    expect(args).toContain("-c.mac.identity=Example (ABCDE12345)");
    expect(args).toContain("-c.mac.notarize=false");
    expect(args).not.toContain("-c.mac.notarize=true");
    // Its own names and folder: a real build's, never a test build's.
    expect(args.some((x) => x.startsWith("-c.directories.output="))).toBe(false);
    expect(args.some((x) => x.includes("TEST"))).toBe(false);
    const built = builderEnv(a, env);
    for (const k of NOTARIZE_ENV) expect(built[k]).toBeUndefined();
    expect(built.CLOVER_MAC_IDENTITY).toBe(env.CLOVER_MAC_IDENTITY);
    expect(built.OTHER).toBe("kept");
    // The Developer ID alone: no notarytool profile.
    expect(signingInputs("mac", {}, true).missing).toEqual(["CLOVER_MAC_IDENTITY"]);
    // What it leaves: the dmg, the zip, the checksums, the plain commit, and no update file of any kind.
    expect(signOnlyOutputs("1.2.3")).toEqual(["Clover-1.2.3.dmg", "Clover-1.2.3-mac.zip", "SHA256SUMS-mac.txt", "BUILD-COMMIT-mac.txt"]);
    expect(signOnlyOutputs("1.2.3").some((n) => n.endsWith(".yml") || n.endsWith(".blockmap") || n.startsWith("clover-"))).toBe(false);
  });

  test("--sign --no-notarize's dry run says it's signed, never notarized, with no update files", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...x: unknown[]) => void lines.push(x.join(" "));
    const saved = { id: process.env.CLOVER_MAC_IDENTITY, profile: process.env.APPLE_KEYCHAIN_PROFILE };
    process.env.CLOVER_MAC_IDENTITY = `Developer ID Application: Example (${CLOVER_TEAM_ID})`;
    delete process.env.APPLE_KEYCHAIN_PROFILE;
    try {
      expect(await buildMain(["--sign", "--no-notarize", "--dry-run", "--os", "mac"], join(import.meta.dir, "..", ".."))).toBe(0);
    } finally {
      console.log = log;
      if (saved.id === undefined) delete process.env.CLOVER_MAC_IDENTITY; else process.env.CLOVER_MAC_IDENTITY = saved.id;
      if (saved.profile !== undefined) process.env.APPLE_KEYCHAIN_PROFILE = saved.profile;
    }
    const text = lines.join("\n");
    expect(text).toContain("signed, not notarized: for this Mac");
    expect(text).toContain("the dmg: sign; never notarized or stapled; no update files");
    expect(text).toContain("-c.mac.notarize=false");
    expect(text).not.toContain("notarytool");
    expect(text).not.toContain("the daemon's own update");
  });

  test("--test-build: macOS only, the Developer ID without notarization, its own folder, none of notarization's inputs", () => {
    expect(parseReleaseBuildArgs(["--test-build"], "darwin", "arm64")).toEqual({ os: "mac", channel: "beta", sign: true, signDev: false, testBuild: true, dryRun: false });
    expect(() => parseReleaseBuildArgs(["--test-build", "--sign"], "darwin", "arm64")).toThrow(/not with --sign/);
    expect(() => parseReleaseBuildArgs(["--test-build", "--sign-dev"], "darwin", "arm64")).toThrow(/not with --sign/);
    expect(() => parseReleaseBuildArgs(["--test-build"], "win32", "x64")).toThrow(/macOS/);
    expect(() => parseReleaseBuildArgs(["--test-build", "--os", "win", "--dry-run"], "darwin", "arm64")).toThrow(/macOS/);
    // The Developer ID alone: no notarytool profile.
    expect(signingInputs("mac", {}, true).missing).toEqual(["CLOVER_MAC_IDENTITY"]);
    expect(signingInputs("mac", {}).missing).toEqual(["CLOVER_MAC_IDENTITY", "APPLE_KEYCHAIN_PROFILE"]);
    const a = parseReleaseBuildArgs(["--test-build"], "darwin", "arm64");
    const env = { CLOVER_MAC_IDENTITY: "Developer ID Application: Example (ABCDE12345)", APPLE_KEYCHAIN_PROFILE: "p", APPLE_ID: "x", APPLE_API_KEY: "k", OTHER: "kept" };
    const args = releaseBuilderArgs(a, env);
    expect(args).toContain("-c.mac.notarize=false");
    expect(args).not.toContain("-c.mac.notarize=true");
    expect(args).toContain("-c.mac.identity=Example (ABCDE12345)");
    expect(args).toContain(`-c.directories.output=${TEST_BUILD_OUT}`);
    // Its dmg and zip say TEST in their names; a real build's are unchanged.
    expect(args).toContain("-c.dmg.artifactName=Clover-${version}-TEST.${ext}");
    expect(args).toContain("-c.mac.artifactName=Clover-${version}-TEST-mac.${ext}");
    expect(testBuildArtifacts("1.2.3")).toEqual({ dmg: "Clover-1.2.3-TEST.dmg", zip: "Clover-1.2.3-TEST-mac.zip" });
    expect(TEST_BUILD_OUT).not.toBe("out/dist");
    const built = builderEnv(a, env);
    for (const k of NOTARIZE_ENV) expect(built[k]).toBeUndefined();
    expect(built.CLOVER_MAC_IDENTITY).toBe(env.CLOVER_MAC_IDENTITY);
    expect(built.OTHER).toBe("kept");
    // A real signed build is unchanged: notarized, into out/dist.
    const real = releaseBuilderArgs(parseReleaseBuildArgs(["--sign"], "darwin", "arm64"), env);
    expect(real).toContain("-c.mac.notarize=true");
    expect(real.some((x) => x.startsWith("-c.directories.output=") || x.includes("artifactName"))).toBe(false);
  });

  // The owner's alpha before the Developer ID (the controller's ruling: an alpha is a beta, no third channel).
  test("--sign-dev: macOS only, the beta channel, never with --sign", () => {
    expect(parseReleaseBuildArgs(["--sign-dev"], "darwin", "arm64")).toEqual({ os: "mac", channel: "beta", sign: false, signDev: true, dryRun: false });
    expect(parseReleaseBuildArgs(["--sign-dev", "--channel", "beta"], "darwin", "arm64").channel).toBe("beta");
    expect(() => parseReleaseBuildArgs(["--sign-dev", "--channel=latest"], "darwin", "arm64")).toThrow(/beta channel/);
    expect(() => parseReleaseBuildArgs(["--sign-dev", "--sign"], "darwin", "arm64")).toThrow(/one or the other/);
    expect(() => parseReleaseBuildArgs(["--sign-dev"], "win32", "x64")).toThrow(/macOS/);
    expect(() => parseReleaseBuildArgs(["--sign-dev", "--os", "win", "--dry-run"], "darwin", "arm64")).toThrow(/macOS/);
  });

  const HASH_A = "A".repeat(40), HASH_B = "B".repeat(40), HASH_C = "C".repeat(40);
  const identities = [
    `  1) ${HASH_A} "Developer ID Application: Clover (${CLOVER_TEAM_ID})"`,
    `  2) ${HASH_B} "Apple Development: Someone (PERSON1234)"`,
    `  3) ${HASH_C} "Apple Development: Other (OTHER12345)"`,
    "     3 valid identities found",
  ].join("\n");
  const subjects: Record<string, string> = {
    [`Developer ID Application: Clover (${CLOVER_TEAM_ID})`]: `subject=UID=${CLOVER_TEAM_ID}, CN=Developer ID Application: Clover (${CLOVER_TEAM_ID}), OU=${CLOVER_TEAM_ID}, O=Clover, C=US`,
    "Apple Development: Someone (PERSON1234)": `subject=UID=X, CN=Apple Development: Someone (PERSON1234), OU=${CLOVER_TEAM_ID}, O=Clover, C=US`,
    "Apple Development: Other (OTHER12345)": "subject=UID=Y, CN=Apple Development: Other (OTHER12345), OU=ZZZZZZZZZZ, O=Elsewhere, C=US",
  };
  const subjectOf = (name: string) => subjects[name];

  test("--sign-dev's identity: the Apple Development one of Clover's team, by its certificate's OU, named by SHA-1", () => {
    expect(devSigningIdentity({ identitiesOutput: identities, subjectOf })).toEqual({ hash: HASH_B, name: "Apple Development: Someone (PERSON1234)" });
    // Only a Developer ID of the team: that's --sign's (notarized), refused here.
    expect(() => devSigningIdentity({ identitiesOutput: identities.split("\n").filter((l) => !l.includes("Someone")).join("\n"), subjectOf })).toThrow(/--sign \(notarized\)/);
    // Another team's Apple Development certificate never counts.
    expect(() => devSigningIdentity({ identitiesOutput: identities.split("\n").filter((l) => l.includes("Other")).join("\n"), subjectOf })).toThrow(/no code-signing identity for team/);
    // The override is a SHA-1, nothing else.
    expect(devSigningIdentity({ identitiesOutput: "", subjectOf, override: "d".repeat(40) })).toEqual({ hash: "D".repeat(40), name: "(CLOVER_MAC_DEV_IDENTITY)" });
    expect(() => devSigningIdentity({ identitiesOutput: identities, subjectOf, override: "Apple Development: Someone" })).toThrow(/SHA-1/);
  });

  test("--sign-dev signs the resources with the team requirement and no timestamp, and electron-builder with the same identity, unnotarized", () => {
    const [core, link] = RESOURCE_BINARIES;
    expect(teamRequirement(core.identifier, CLOVER_TEAM_ID)).toBe(`identifier "com.waifucave.clover.core" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`);
    expect(codesignDevArgs("x/clover-core", HASH_B, core.identifier, CLOVER_TEAM_ID, core.entitlements)).toEqual([
      "codesign", "--force", "--sign", HASH_B, "--options", "runtime", "--timestamp=none", "--identifier", "com.waifucave.clover.core",
      `-r=designated => identifier "com.waifucave.clover.core" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`,
      "--entitlements", "scripts/clover-core.entitlements", "x/clover-core"]);
    expect(codesignDevArgs("x/clover-link", HASH_B, link.identifier, CLOVER_TEAM_ID)).not.toContain("--entitlements");
    // A keychain for this build only: codesign looks there, and the search list isn't touched.
    expect(codesignDevArgs("x/clover-link", HASH_B, link.identifier, CLOVER_TEAM_ID, undefined, "/s/dev.keychain-db").slice(-3)).toEqual(["--keychain", "/s/dev.keychain-db", "x/clover-link"]);
    expect(() => codesignDevArgs("x", "Apple Development: Someone", core.identifier, CLOVER_TEAM_ID)).toThrow(/SHA-1/);
    const env = { CLOVER_MAC_IDENTITY: "Developer ID Application: Example Ltd (AB12CD34EF)", APPLE_KEYCHAIN_PROFILE: "p", APPLE_ID: "a", CSC_LINK: "x", PATH: "/bin" };
    const dev = parseReleaseBuildArgs(["--sign-dev"], "darwin", "arm64");
    expect(releaseBuilderArgs(dev, env, HASH_B)).toEqual(["electron-builder", "--mac", "dmg", "zip", "--arm64", "--publish", "never", "-c.publish.channel=beta",
      `-c.mac.identity=${HASH_B}`, "-c.mac.notarize=false", "-c.mac.timestamp=none"]);
    expect(() => releaseBuilderArgs(dev, env)).toThrow(/SHA-1/);
    // Nothing a Developer ID build or notarization would use reaches it.
    expect(builderEnv(dev, env)).toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
    expect(builderEnv(dev, { ...env, CLOVER_MAC_DEV_KEYCHAIN: "/s/dev.keychain-db", CSC_KEYCHAIN: "/elsewhere" })).toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_KEYCHAIN: "/s/dev.keychain-db" });
    // An unsigned build drops any keychain it's handed.
    expect(builderEnv(parseReleaseBuildArgs([], "darwin", "arm64"), { PATH: "/bin", CSC_KEYCHAIN: "/k", CLOVER_MAC_DEV_KEYCHAIN: "/k" })).toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  });

  // codesign itself, with no identity and no keychain: an ad hoc signature takes the same arguments but the identity,
  // and records the designated requirement given, which the real team identity's signature carries the same way.
  darwinTest("codesign records --sign-dev's team requirement as the designated one, which compiles, and an unsigned-by-the-team copy fails it", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-sign-dev-"));
    try {
      const bin = join(dir, "clover-plugin-bun");
      writeFileSync(bin, readFileSync("/usr/bin/true"));
      const plugin = RESOURCE_BINARIES[2];
      const args = codesignDevArgs(bin, HASH_B, plugin.identifier, CLOVER_TEAM_ID);
      args[args.indexOf(HASH_B)] = "-";
      const signed = spawnSync(args[0]!, args.slice(1), { encoding: "utf8" });
      expect([signed.status, signed.stderr.replace(/^.*replacing existing signature\n/m, "")]).toEqual([0, ""]);
      const shown = spawnSync("codesign", ["-d", "-r-", bin], { encoding: "utf8" });
      const recorded = /^designated => (.+)$/m.exec(`${shown.stdout}${shown.stderr}`)?.[1]?.trim();
      expect(recorded).toBe(teamRequirement(plugin.identifier, CLOVER_TEAM_ID));
      // The text compiles as a requirement (csreq), and this ad hoc copy doesn't meet it: only the team's identity does.
      expect(spawnSync("csreq", ["-r", `=${recorded}`, "-b", join(dir, "req.bin")]).status).toBe(0);
      expect(spawnSync("codesign", ["--verify", "--strict", `-R=${recorded}`, bin]).status).not.toBe(0);
      expect(spawnSync("codesign", ["--verify", "--strict", `-R=identifier "${plugin.identifier}"`, bin]).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dev-signed binary is held to the signed build's checks but the timestamp", () => {
    const dev = parseCodesignDisplay([
      "Identifier=com.waifucave.clover.core",
      "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded",
      "Authority=Apple Development: Someone (PERSON1234)",
      "Timestamp=none",
      `TeamIdentifier=${CLOVER_TEAM_ID}`,
    ].join("\n").replace("Timestamp=none\n", ""));
    expect(dev.timestamped).toBe(false);
    expect(signatureProblems("clover-core", dev, CLOVER_TEAM_ID, "com.waifucave.clover.core", { dev: true })).toEqual([]);
    expect(signatureProblems("clover-core", dev, CLOVER_TEAM_ID, "com.waifucave.clover.core")).toEqual(["clover-core has no secure timestamp"]);
    const adhoc = parseCodesignDisplay("Identifier=x\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1\nSignature=adhoc\nTeamIdentifier=not set\n");
    expect(signatureProblems("x", adhoc, CLOVER_TEAM_ID, undefined, { dev: true })).toEqual([`x is not signed with team ${CLOVER_TEAM_ID}'s identity`, "x has no hardened runtime"]);
  });

  test("the daemon and the plugin Bun are signed with the restrict flag (their environment hidden); the others aren't asked it", () => {
    expect(RESOURCE_BINARIES.filter((b) => b.restrict).map((b) => b.file)).toEqual(["clover-core", "clover-plugin-bun"]);
    const bun = RESOURCE_BINARIES.find((b) => b.file === "clover-plugin-bun")!;
    expect(codesignDevArgs("x/clover-plugin-bun", "A".repeat(40), bun.identifier, CLOVER_TEAM_ID, bun.entitlements, undefined, { restrict: bun.restrict })).toContain("runtime,restrict");
    const report = (flags: string) => parseCodesignDisplay([
      "Identifier=com.waifucave.clover.core", `CodeDirectory v=20500 size=1 ${flags} hashes=1+7 location=embedded`,
      "Timestamp=6 Nov 2026 at 12:00:00", "TeamIdentifier=AB12CD34EF",
    ].join("\n"));
    const restricted = report("flags=0x10800(restrict,runtime)");
    expect([restricted.runtime, restricted.restrict]).toEqual([true, true]);
    expect(signatureProblems("clover-core", restricted, "AB12CD34EF", "com.waifucave.clover.core", { restrict: true })).toEqual([]);
    expect(signatureProblems("clover-core", report("flags=0x10000(runtime)"), "AB12CD34EF", "com.waifucave.clover.core", { restrict: true }))
      .toEqual(["clover-core isn't signed with the restrict flag (its environment would be readable by any process of the user)"]);
  });
});

describe("the bundled plugins' native code on a signed Mac build", () => {
  test("Mach-O files are found by their magic, any byte order, thin or universal; nothing else is", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-macho-"));
    try {
      mkdirSync(join(dir, "p", "node_modules", "x"), { recursive: true });
      writeFileSync(join(dir, "p", "node_modules", "x", "addon.node"), new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
      writeFileSync(join(dir, "p", "fat.dylib"), new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 1]));
      writeFileSync(join(dir, "p", "index.js"), "export {};\n");
      writeFileSync(join(dir, "p", "tiny"), new Uint8Array([0xcf, 0xfa]));
      expect(machOFiles(dir)).toEqual(["p/fat.dylib", "p/node_modules/x/addon.node"]);
      expect(isMachO(new Uint8Array([0xfe, 0xed, 0xfa, 0xcf]))).toBe(true);
      // Universal binaries with 64-bit offsets, in either byte order.
      expect(isMachO(new Uint8Array([0xca, 0xfe, 0xba, 0xbf]))).toBe(true);
      expect(isMachO(new Uint8Array([0xbf, 0xba, 0xfe, 0xca]))).toBe(true);
      expect(isMachO(new TextEncoder().encode("#!/b"))).toBe(false);
      // A real one: this machine's own executable, when it's a Mac.
      if (process.platform === "darwin") expect(isMachO(new Uint8Array(readFileSync("/usr/bin/true")).slice(0, 4))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the app's own native code: a Mach-O packed inside app.asar is named (by its bytes), and electron-builder.yml unpacks the add-ons", () => {
    const files = new Map<string, Uint8Array>([
      ["out/main/index.js", new TextEncoder().encode("export {};\n")],
      ["out/main/native/screen.node", new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0])],
      ["out/main/native/renamed.bin", new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 1])],
    ]);
    expect(packedMachO(files)).toEqual(["out/main/native/renamed.bin", "out/main/native/screen.node"]);
    expect(packedMachO(new Map([["out/main/index.js", new TextEncoder().encode("x")]]))).toEqual([]);
    const builder = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "..", "apps", "desktop", "electron-builder.yml"), "utf8")) as { asarUnpack?: string[] };
    expect(builder.asarUnpack).toContain("out/main/native/*.node");
  });

  test("each signs under its own identifier, from its path", () => {
    expect(nativeIdentifier("clover/plugins/companion-web/node_modules/@node-datachannel/darwin-arm64/node_datachannel.node"))
      .toBe("com.waifucave.clover.plugin.clover.plugins.companion.web.node.modules.node.datachannel.darwin.arm64.node.datachannel.node");
  });

});

describe("the owner's publish step (scripts/release/publish.ts)", () => {
  const version = "1.2.3";
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const yml = (files: string[], blobs: Map<string, Uint8Array>) => utf8(formatUpdateInfo({ version, files: files.map((url) => ({ url, sha512: sha512Base64(blobs.get(url)!), size: blobs.get(url)!.length })) }));
  function builds(channel: "latest" | "beta") {
    const dirs = new Map<string, Map<string, Uint8Array>>();
    for (const os of RELEASE_OSES) {
      const blobs = new Map<string, Uint8Array>(installers(version, os).map((n) => [n, utf8(`${n} bytes`)]));
      blobs.set(`${installers(version, os)[0]}.blockmap`, utf8("map"));
      const named = os === "mac" ? installers(version, os) : installers(version, os).filter((n) => !n.endsWith(".deb") && !n.endsWith(".rpm"));
      for (const c of channelsServed(channel)) blobs.set(feedFile(c, os), yml(named, blobs));
      const core = coreBinaryFile(version, CORE_TARGET[os]);
      blobs.set(core, utf8(`${core} bytes`));
      for (const c of channelsServed(channel)) blobs.set(coreFeedFile(c, CORE_TARGET[os]), utf8(formatCoreFeed({ version, file: core, sha512: sha512Base64(blobs.get(core)!), size: blobs.get(core)!.length })));
      const bun = pluginBunBinaryFile(PLUGIN_BUN.version, CORE_TARGET[os]);
      blobs.set(bun, utf8(`${bun} bytes`));
      for (const c of channelsServed(channel)) blobs.set(pluginBunFeedFile(c, CORE_TARGET[os]), utf8(formatCoreFeed({ version: PLUGIN_BUN.version, file: bun, sha512: sha512Base64(blobs.get(bun)!), size: blobs.get(bun)!.length })));
      const tarball = pluginsTarballFile(version, CORE_TARGET[os]);
      blobs.set(tarball, utf8(`${tarball} bytes`));
      for (const c of channelsServed(channel)) blobs.set(pluginsFeedFile(c, CORE_TARGET[os]), utf8(formatCoreFeed({ version, file: tarball, sha512: sha512Base64(blobs.get(tarball)!), size: blobs.get(tarball)!.length })));
      blobs.set(buildCommitFile(os), utf8(`${COMMIT}\n`));
      dirs.set(`out/${os}`, blobs);
    }
    return dirs;
  }
  const plan = (dirs: Map<string, Map<string, Uint8Array>>, channel: "latest" | "beta") =>
    planRelease(version, channel, [...dirs.keys()], (d) => [...dirs.get(d)!.keys()], (d, n) => dirs.get(d)!.get(n)!);

  test("a release holds every OS's installers and update files, checked, with their block maps", () => {
    const p = plan(builds("latest"), "latest");
    expect(p.problems).toEqual([]);
    const names = p.assets.map((a) => a.name);
    for (const os of RELEASE_OSES) for (const n of expectedArtifacts(version, os, "latest")) expect(names).toContain(n);
    expect(names).toContain("Clover-1.2.3.dmg.blockmap");
    expect(new Set(names).size).toBe(names.length);
  });

  test("every OS from one commit, which the release is tagged at", () => {
    const apart = builds("beta");
    apart.get("out/win")!.set(buildCommitFile("win"), utf8("fedcba9876543210fedcba9876543210fedcba98\n"));
    const p = plan(apart, "beta");
    expect(p.commit).toBeUndefined();
    expect(p.problems.some((x) => x.startsWith("the builds come from different commits"))).toBe(true);
    expect(() => draftReleaseArgs(p, "waifucave/clover")).toThrow(/no commit/);
    const unsaid = builds("beta");
    unsaid.get("out/linux-x64")!.delete(buildCommitFile("linux-x64"));
    expect(plan(unsaid, "beta").problems).toContain("BUILD-COMMIT-linux-x64.txt is missing: the linux-x64 build doesn't say which commit it is");
  });

  test("a sign-only build's output (no update files, an unstapled dmg) is never published: planRelease refuses it", () => {
    const signOnly = builds("beta");
    const mac = new Map<string, Uint8Array>(signOnlyOutputs(version).map((n) => [n, utf8(n === buildCommitFile("mac") ? `${COMMIT}\n` : `${n} bytes`)]));
    signOnly.set("out/mac", mac);
    const p = plan(signOnly, "beta");
    expect(p.problems.length).toBeGreaterThan(0);
    // The app's own update file, the core's, plugin Bun's and the plugins' are each missing.
    for (const f of [feedFile("beta", "mac"), coreFeedFile("beta", CORE_TARGET.mac), pluginBunFeedFile("beta", CORE_TARGET.mac), pluginsFeedFile("beta", CORE_TARGET.mac)]) {
      expect(p.problems.some((x) => x.includes(f))).toBe(true);
    }
  });

  // A test-marked build (scripts/test-build.ts) is never published: its BUILD-COMMIT says so, and a core carrying the
  // label or the test-only code never passes a feed's check.
  test("a test-marked build's BUILD-COMMIT, or a test-marked core in a feed, stops it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-int-test-commit-"));
    try {
      writeBuildCommit(dir, "mac", COMMIT, true);
      const text = readFileSync(join(dir, buildCommitFile("mac")), "utf8");
      expect(text.startsWith(`${COMMIT}\n`)).toBe(true);
      expect(text).toContain(TEST_BUILD_LABEL);
      expect(testBuildCommitProblem(buildCommitFile("mac"), text)).toContain("never published");
      writeBuildCommit(dir, "mac", COMMIT);
      expect(readFileSync(join(dir, buildCommitFile("mac")), "utf8")).toBe(`${COMMIT}\n`);
      const tested = builds("beta");
      tested.get("out/mac")!.set(buildCommitFile("mac"), utf8(text));
      const p = plan(tested, "beta");
      expect(p.problems).toContain("BUILD-COMMIT-mac.txt names a test-marked build (scripts/test-build.ts): a test build is never published");
      expect(p.commit).toBeUndefined();
      // However it's spelled: the label, the sentinel, or the words.
      for (const t of [`${COMMIT}\n${TEST_BUILD_LABEL}\n`, `${COMMIT} ${TEST_BUILD_SENTINEL}`, `${COMMIT}\nTest Build\n`]) expect(testBuildCommitProblem("x", t)).toBeDefined();
      expect(testBuildCommitProblem("x", `${COMMIT}\n`)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const marker of [TEST_BUILD_LABEL, TEST_BUILD_SENTINEL]) {
      const marked = builds("beta");
      const core = coreBinaryFile(version, CORE_TARGET.mac);
      const bytes = utf8(`a core ${marker} inside`);
      marked.get("out/mac")!.set(core, bytes);
      marked.get("out/mac")!.set(coreFeedFile("beta", CORE_TARGET.mac), utf8(formatCoreFeed({ version, file: core, sha512: sha512Base64(bytes), size: bytes.length })));
      expect(plan(marked, "beta").problems).toContain(`beta-core-darwin-arm64.yml: ${core} is a test-marked core: a test build never goes into an update feed`);
    }
  });

  test("a missing OS, a mismatched update file or a file in two folders stops it", () => {
    const dirs = builds("beta");
    dirs.delete("out/linux-arm64");
    expect(plan(dirs, "beta").problems).toContain("clover_1.2.3_arm64.deb is missing");
    const bad = builds("beta");
    bad.get("out/win")!.set("Clover-Setup-1.2.3.exe", utf8("tampered"));
    expect(plan(bad, "beta").problems).toContain("beta.yml: Clover-Setup-1.2.3.exe's sha512 doesn't match");
    const badCore = builds("beta");
    badCore.get("out/linux-x64")!.set("clover-core-1.2.3-linux-x64", utf8("tampered"));
    expect(plan(badCore, "beta").problems).toContain("beta-core-linux-x64.yml: clover-core-1.2.3-linux-x64's sha512 doesn't match");
    const badPlugins = builds("beta");
    badPlugins.get("out/mac")!.set("clover-plugins-1.2.3-darwin-arm64.tar.gz", utf8("tampered"));
    expect(plan(badPlugins, "beta").problems).toContain("beta-plugins-darwin-arm64.yml: clover-plugins-1.2.3-darwin-arm64.tar.gz's sha512 doesn't match");
    const twice = builds("beta");
    twice.get("out/win")!.set("Clover-1.2.3.dmg", utf8("x"));
    expect(plan(twice, "beta").problems.some((x) => x.includes("is in both"))).toBe(true);
  });

  test("each update file and daemon binary is signed with the Keychain's key, checked against the app's, and nothing else is signed", () => {
    const dirs = builds("latest");
    const p = plan(dirs, "latest");
    expect(p.feeds.sort()).toEqual(RELEASE_OSES.flatMap((os) => [...channelsServed("latest").flatMap((c) => [feedFile(c, os), coreFeedFile(c, CORE_TARGET[os]), pluginBunFeedFile(c, CORE_TARGET[os]), pluginsFeedFile(c, CORE_TARGET[os])]), coreBinaryFile(version, CORE_TARGET[os]), pluginBunBinaryFile(PLUGIN_BUN.version, CORE_TARGET[os]), pluginsTarballFile(version, CORE_TARGET[os])]).sort());
    const key = generateFeedKey();
    const sigs = signFeeds(p, (d, n) => dirs.get(d)!.get(n)!, key.privateKey, key.publicKey);
    expect(sigs.map((s) => s.name).sort()).toEqual(p.feeds.map((f) => `${f}.sig`).sort());
    for (const s of sigs) {
      const name = s.name.slice(0, -".sig".length);
      const dir = [...dirs.values()].find((d) => d.has(name))!;
      expect(verifyFeed(name, dir.get(name)!, s.signature, key.publicKey)).toEqual({ ok: true });
    }
    // Promoting signs a beta file again under its latest name; the beta signature doesn't hold there.
    const beta = dirs.get("out/mac")!.get("beta-mac.yml")!;
    const promoted = promotedSignature("beta-mac.yml", beta, key.privateKey, key.publicKey);
    expect(promoted.name).toBe("latest-mac.yml");
    expect(verifyFeed("latest-mac.yml", beta, promoted.signature, key.publicKey)).toEqual({ ok: true });
    expect(verifyFeed("latest-mac.yml", beta, sigs.find((x) => x.name === "beta-mac.yml.sig")!.signature, key.publicKey)).toEqual({ ok: false, reason: "bad signature" });
    // A key the app doesn't carry signs nothing.
    expect(() => signFeeds(p, (d, n) => dirs.get(d)!.get(n)!, key.privateKey, generateFeedKey().publicKey)).toThrow(/doesn't verify against the app's key/);
  });

  test("the draft: tagged v<version>, a draft always, a pre-release on beta", () => {
    const p = plan(builds("beta"), "beta");
    const args = draftReleaseArgs(p, "waifucave/clover");
    expect(p.commit).toBe(COMMIT);
    expect(args.slice(0, 9)).toEqual(["gh", "release", "create", "v1.2.3", "--repo", "waifucave/clover", "--target", COMMIT, "--draft"]);
    expect(args).toContain("--prerelease");
    expect(draftReleaseArgs(plan(builds("latest"), "latest"), "waifucave/clover")).not.toContain("--prerelease");
    expect(args).not.toContain("--latest");
  });

  test("arguments: it plans unless told to create the draft; promoting takes a version and --yes", () => {
    expect(parsePublishArgs(["--from", "a,b"])).toEqual({ mode: "draft", from: ["a", "b"], channel: "latest", create: false });
    expect(parsePublishArgs(["--from=a", "--channel", "beta", "--create-draft"])).toEqual({ mode: "draft", from: ["a"], channel: "beta", create: true });
    expect(parsePublishArgs(["--promote", "1.2.3"])).toEqual({ mode: "promote", version: "1.2.3", yes: false });
    expect(() => parsePublishArgs([])).toThrow(/--from/);
    expect(() => parsePublishArgs(["--from", "a", "--yes"])).toThrow(/--create-draft/);
    expect(() => parsePublishArgs(["--promote", "latest"])).toThrow(/a version/);
    expect(promotedName("beta-linux-arm64.yml")).toBe("latest-linux-arm64.yml");
    expect(promotedName("beta.yml")).toBe("latest.yml");
    expect(promotedName("beta-core-windows-x64.yml")).toBe("latest-core-windows-x64.yml");
    expect(() => promotedName("latest.yml")).toThrow();
    expect(() => promotedName("clover-core-1.2.3-linux-x64")).toThrow();
  });
});

describe("the release workflow (.github/workflows/release.yml)", () => {
  const text = read(".github/workflows/release.yml");
  // biome-ignore lint: a parsed workflow
  const wf = Bun.YAML.parse(text) as Record<string, any>;

  test("runs by hand only, reads the repo and nothing else", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(wf.permissions).toEqual({ contents: "read", packages: "read" });
    for (const job of Object.values(wf.jobs) as Array<{ permissions?: unknown }>) expect(job.permissions).toBeUndefined();
  });

  test("holds no secret but the workflow's own token, and never signs or publishes", () => {
    expect([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(expect.arrayContaining(["GITHUB_TOKEN"]));
    expect([...new Set([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))]).toEqual(["GITHUB_TOKEN"]);
    expect(text).not.toMatch(/--sign\b|gh release|--publish (always|onTag|onTagOrDraft)|release\/publish\.ts --|CSC_LINK|APPLE_/);
    const steps = (Object.values(wf.jobs) as Array<{ steps: Array<{ run?: string }> }>).flatMap((j) => j.steps.map((s) => s.run ?? ""));
    expect(steps.some((r) => r.includes("bun scripts/release/build.ts"))).toBe(true);
    expect(steps.some((r) => r.includes("bun scripts/build-packages.ts --arch"))).toBe(true);
  });

  test("refuses any ref but main in every job, before anything else, and keeps each build's commit", () => {
    for (const job of Object.values(wf.jobs) as Array<{ steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>) {
      expect(job.steps[0]!.name).toBe("Only from main");
      expect(job.steps[0]!.env?.REF).toBe("${{ github.ref }}");
      expect(job.steps[0]!.run).toContain('test "$REF" = refs/heads/main');
    }
    expect(text.match(/apps\/desktop\/out\/dist\/BUILD-COMMIT-\*\.txt/g)).toHaveLength(2);
    expect(text.match(/= "\$GITHUB_SHA"/g)).toHaveLength(2);
  });

  test("builds every OS the release holds", () => {
    const desktop = wf.jobs.desktop.strategy.matrix.include.map((m: { os: string }) => m.os);
    const linux = wf.jobs.linux.strategy.matrix.include.map((m: { arch: string }) => `linux-${m.arch}`);
    expect([...desktop, ...linux].sort()).toEqual([...RELEASE_OSES].sort());
  });
});

describe("the update feed's key (scripts/release/feed-key.ts)", () => {
  const keyTs = 'export const UPDATE_FEED_PUBLIC_KEY: string | null = null;\n';

  test("--generate keeps the private half in the Keychain and writes only the public half into key.ts", async () => {
    const store = memoryStore();
    const file = join(mkdtempSync(join(tmpdir(), "clover-feed-key-")), "key.ts");
    writeFileSync(file, `// the key\n${keyTs}`);
    const pub = await generate(store, file, null);
    const priv = store.items.get(`${FEED_KEY_ITEM.service}/${FEED_KEY_ITEM.name}`)!;
    expect(publicKeyOf(priv)).toBe(pub);
    const written = readFileSync(file, "utf8");
    expect(written).toBe(`// the key\nexport const UPDATE_FEED_PUBLIC_KEY: string | null = ${JSON.stringify(pub)};\n`);
    expect(written).not.toContain(priv);
    // Never twice: a second key would be a rotation.
    await expect(generate(store, file, pub)).rejects.toThrow(/key rotation/);
    await expect(generate(store, file, null)).rejects.toThrow(/already holds/);
  });

  test("the release signs only with the Keychain's key, and only when it is the one the app carries", async () => {
    const store = memoryStore();
    await expect(signingKey(store, null)).rejects.toThrow(/no update feed key yet/);
    const key = generateFeedKey();
    await expect(signingKey(store, key.publicKey)).rejects.toThrow(/has no/);
    await store.set({ ...FEED_KEY_ITEM, value: key.privateKey });
    expect(await signingKey(store, key.publicKey)).toBe(key.privateKey);
    await expect(signingKey(store, generateFeedKey().publicKey)).rejects.toThrow(/not the one the app carries/);
    expect(() => withPublicKey("no key line here", "x")).toThrow(/UPDATE_FEED_PUBLIC_KEY/);
  });

  test("the release scripts never write the private key anywhere: it goes only to the Keychain and to signFeed", () => {
    for (const f of ["scripts/release/feed-key.ts", "scripts/release/publish.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/writeFileSync\([^)]*privateKey/);
      expect(src, f).not.toMatch(/console\.\w+\([^)]*privateKey/);
    }
  });
});

describe("the signed builds' checks", () => {
  test("entitlements are read from codesign's plist, and match the daemon's file exactly", () => {
    const xml = '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/>\n<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>';
    expect(parseEntitlementKeys(xml)).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]);
    expect(parseEntitlementKeys(read("scripts/clover-core.entitlements"))).toEqual(parseEntitlementKeys(xml));
    expect(parseEntitlementKeys("Executable=/x/clover-link\n")).toEqual([]);
  });

  test("Authenticode: Valid, by the publisher, or named", () => {
    expect(authenticodeProblems("Clover.exe", "Valid|CN=Example Ltd, O=Example Ltd, C=GB\n", "Example Ltd")).toEqual([]);
    expect(authenticodeProblems("Clover.exe", 'Valid|CN="Example, Ltd", O=x', "Example, Ltd")).toEqual([]);
    expect(authenticodeProblems("clover-core.exe", "NotSigned|", "Example Ltd")).toEqual(["clover-core.exe's Authenticode signature is NotSigned, not Valid"]);
    expect(authenticodeProblems("clover-link.exe", "Valid|CN=Someone Else", "Example Ltd")).toEqual(["clover-link.exe is signed by Someone Else, not Example Ltd"]);
    expect(authenticodeProblems("x.exe", "", "Example Ltd")).toEqual(["x.exe's Authenticode signature is missing, not Valid"]);
    expect(authenticodeCommand("C:\\a'b\\Clover.exe").at(-1)).toContain("-LiteralPath 'C:\\a''b\\Clover.exe'");
  });
});

const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

describe("the name scan (scripts/release/name-scan.ts)", () => {
  test("fails closed without the owner's local guard", async () => {
    const { nameScan } = await import("./name-scan");
    const home = mkdtempSync(join(tmpdir(), "clover-name-scan-home-"));
    const r = nameScan([], [], home);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("can't cut a release");
  });

  test("opens every kind of asset, and what nests inside, without running anything", async () => {
    const { openerFor, TOOLS } = await import("./name-scan");
    const names = ["Clover-1.dmg", "Clover-1-mac.zip", "Clover-Setup-1.exe", "clover_1_amd64.deb", "clover-1.x86_64.rpm", "Clover-1-x86_64.AppImage",
      "data.tar.xz", "control.tar.zst", "x.tar", "app-64.7z", "a.gz", "Clover-1.dmg.blockmap", "b.br", "latest.yml", "clover-core.exe", "app.asar"];
    expect(names.map(openerFor)).toEqual(["dmg", "zip", "nsis", "deb", "rpm", "appimage", "xz", "zst", "tar", "7z", "gz", "gz", "br", "raw", "raw", "asar"]);
    const more = ["hidden.tgz", "x.tbz", "x.bz2", "x.lz4", "x.lzma", "x.cab", "x.msi", "x.jar", "x.crx", "x.squashfs", "x.rar", "x.lz", "libx.a"];
    expect(more.map(openerFor)).toEqual(["gz", "bz2", "bz2", "lz4", "lzma", "cab", "msi", "zip", "crx", "squashfs", "rar", "lzip", "ar"]);
    expect(TOOLS.dmg).toBe("hdiutil");
    expect(TOOLS.appimage).toBe("unsquashfs");
    expect(read("scripts/release/name-scan.ts")).toContain('"hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint"');
  });

  test("knows a file by its bytes, whatever it is called", async () => {
    const { magicOf, decompressedName, TOOLS } = await import("./name-scan");
    const b = (...x: Array<number | string>): Uint8Array => {
      const out: number[] = [];
      for (const v of x) typeof v === "string" ? out.push(...[...v].map((c) => c.charCodeAt(0))) : out.push(v);
      return new Uint8Array(out);
    };
    const tar = new Uint8Array(512);
    tar.set(b("ustar"), 257);
    const asar = new Uint8Array(40);
    asar.set([4, 0, 0, 0], 0);
    asar.set(b('{"files":{}}'), 16);
    const lzma = b(0x5d, 0, 0, 0x80, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0);
    const koly = new Uint8Array(512);
    koly.set(b("koly"), 0);
    const elfAi = b(0x7f, "ELF", 2, 1, 1, 0, "AI", 2);
    const cases: Array<[Uint8Array, string | undefined]> = [
      [b("PK", 3, 4), "zip"], [b("PK", 5, 6), "zip"], [b("Cr24"), "crx"], [b(0x1f, 0x8b, 8), "gz"], [b(0xfd, "7zXZ", 0), "xz"],
      [b(0x28, 0xb5, 0x2f, 0xfd), "zst"], [b("7z", 0xbc, 0xaf, 0x27, 0x1c), "7z"], [b("BZh9"), "bz2"], [b("!<arch>\n"), "ar"],
      [b("hsqs"), "squashfs"], [elfAi, "appimage"], [b(0xed, 0xab, 0xee, 0xdb), "rpm"], [b("MSCF", 0, 0, 0, 0), "cab"],
      [b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), "msi"], [b("Rar!", 0x1a, 7), "rar"], [b(4, 0x22, 0x4d, 0x18), "lz4"],
      [b("LZIP"), "lzip"], [tar, "tar"], [asar, "asar"], [lzma, "lzma"],
      // Not formats: an ELF that is no AppImage, plain text, "BZh" without a block size, an implausible LZMA header.
      [b(0x7f, "ELF", 2, 1, 1, 0, 0, 0, 0), undefined], [b("hello"), undefined], [b("BZhx"), undefined], [b(0x5d, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9), undefined],
    ];
    for (const [bytes, want] of cases) expect(magicOf(bytes)).toBe(want as never);
    expect(magicOf(b("x"), koly)).toBe("dmg");
    expect(decompressedName("hidden.tgz")).toBe("hidden.tar");
    expect(decompressedName("a.tar.bz2")).toBe("a.tar");
    expect(decompressedName("blob.bin")).toBe("blob.bin.out");
    // Every format it knows has a way to open it (in-process, or a tool it checks for, failing when it's missing).
    expect(TOOLS.lz4).toBe("lz4");
    expect(TOOLS.cab).toBe("7z");
  });

  test("knows a PE file (and asks 7z what it holds) and a zip appended to anything", async () => {
    const { appendedZip, formatOf, magicOf, peArchiveType, TOOLS } = await import("./name-scan");
    const pe = new Uint8Array(256);
    pe.set([0x4d, 0x5a]);
    new DataView(pe.buffer).setUint32(0x3c, 0x80, true);
    pe.set([0x50, 0x45, 0, 0], 0x80);
    expect(magicOf(pe)).toBe("pe");
    const notPe = pe.slice();
    notPe[0x80] = 0;
    expect(magicOf(notPe)).toBeUndefined();
    // e_lfanew past the first 512 bytes: formatOf reads where it points.
    const far = new Uint8Array(0x500);
    far.set([0x4d, 0x5a]);
    new DataView(far.buffer).setUint32(0x3c, 0x400, true);
    far.set([0x50, 0x45, 0, 0], 0x400);
    const farDir = mkdtempSync(join(tmpdir(), "clover-name-pe-"));
    writeFileSync(join(farDir, "far.dll"), far);
    expect(formatOf(join(farDir, "far.dll"))).toBe("pe");
    far[0x400] = 0;
    writeFileSync(join(farDir, "far.dll"), far);
    expect(formatOf(join(farDir, "far.dll"))).toBe("raw");
    expect(TOOLS.pe).toBe("7z");
    expect(peArchiveType("Path = a.exe\nType = PE\nCPU = x64\n")).toBe("PE");
    expect(peArchiveType("Path = setup.exe\nType = Nsis\nMethod = LZMA\n")).toBe("Nsis");
    expect(peArchiveType("Path = x.exe\nType = PE\n\nPath = x.exe\nType = zip\nOffset = 4096\n")).toBe("zip");
    expect(peArchiveType("garbage")).toBeUndefined();
    // An end-of-central-directory record whose comment ends the file; one that doesn't is not.
    const eocd = (comment: number): Uint8Array => { const r = new Uint8Array(22 + comment); r.set([0x50, 0x4b, 5, 6]); new DataView(r.buffer).setUint16(20, comment, true); return r; };
    const cat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
    expect(appendedZip(cat(new Uint8Array(100).fill(7), eocd(0)))).toBe(true);
    expect(appendedZip(cat(new Uint8Array(100).fill(7), eocd(5)))).toBe(true);
    expect(appendedZip(cat(eocd(0), new Uint8Array(3)))).toBe(false);
    expect(appendedZip(new Uint8Array(30))).toBe(false);
    // A real zip behind other bytes, named .bin: known by its end, opened with 7z.
    const dir = mkdtempSync(join(tmpdir(), "clover-name-appended-"));
    writeFileSync(join(dir, "in.txt"), "inside");
    const zip = join(dir, "z.zip");
    expect(Bun.spawnSync(["bsdtar", "-a", "-cf", zip, "-C", dir, "in.txt"]).exitCode).toBe(0);
    const file = join(dir, "blob.bin");
    writeFileSync(file, cat(new Uint8Array(4096).fill(0x41), new Uint8Array(readFileSync(zip))));
    expect(formatOf(file)).toBe("appendedzip");
    expect(TOOLS.appendedzip).toBe("7z");
  });

  test("a known format must run to the file's last byte: tar, ar, 7z, zip and cab are measured by their own structure", async () => {
    const { arEnd, sevenZipEnd, tarEnd, trailingProblem } = await import("./name-scan");
    const dir = mkdtempSync(join(tmpdir(), "clover-name-trailing-"));
    writeFileSync(join(dir, "in.txt"), "inside");
    const tar = join(dir, "a.tar");
    expect(Bun.spawnSync(["bsdtar", "-cf", tar, "-C", dir, "in.txt"]).exitCode).toBe(0);
    const tarBytes = new Uint8Array(readFileSync(tar));
    const reader = (b: Uint8Array) => (p: number, n: number): Uint8Array => b.subarray(p, p + n);
    // One header and one data block, then the end-of-archive blocks (bsdtar pads with zeros to its record size).
    expect(tarEnd(reader(tarBytes), tarBytes.length)).toBe(1024);
    expect(trailingProblem(tar, "tar")).toBeUndefined();
    const tarJunk = join(dir, "junk.tar");
    writeFileSync(tarJunk, cat(tarBytes, Bun.gzipSync(new TextEncoder().encode("hidden"))));
    expect(trailingProblem(tarJunk, "tar")).toMatch(/^has \d+ bytes after its tar archive's end$/);
    const bad = tarBytes.slice();
    bad[0] = bad[0]! ^ 1;
    expect(tarEnd(reader(bad), bad.length)).toBeUndefined();
    // ar: each member padded to an even length; nothing after the last.
    const ar = cat(new TextEncoder().encode("!<arch>\n"), new TextEncoder().encode("debian-binary/  0           0     0     100644  3         `\n"), new TextEncoder().encode("2.0\n"));
    expect(arEnd(reader(ar), ar.length)).toBe(ar.length);
    writeFileSync(join(dir, "a.deb"), cat(ar, new Uint8Array([1])));
    expect(trailingProblem(join(dir, "a.deb"), "deb")).toBe("has 1 bytes after its ar archive's end");
    // 7z: its start header (CRC checked) says where it ends.
    const seven = new Uint8Array(40);
    seven.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
    new DataView(seven.buffer).setBigUint64(12, 4n, true);
    new DataView(seven.buffer).setBigUint64(20, 4n, true);
    new DataView(seven.buffer).setUint32(8, Bun.hash.crc32(seven.subarray(12, 32)), true);
    expect(sevenZipEnd(seven)).toBe(40);
    writeFileSync(join(dir, "a.7z"), cat(seven, new Uint8Array(5)));
    expect(trailingProblem(join(dir, "a.7z"), "7z")).toBe("has 5 bytes after its 7z archive's end");
    seven[8] = seven[8]! ^ 1;
    expect(sevenZipEnd(seven)).toBeUndefined();
    // zip: its end record must be the file's last bytes.
    const zip = join(dir, "a.zip");
    expect(Bun.spawnSync(["bsdtar", "-a", "-cf", zip, "-C", dir, "in.txt"]).exitCode).toBe(0);
    expect(trailingProblem(zip, "zip")).toBeUndefined();
    writeFileSync(join(dir, "b.zip"), cat(new Uint8Array(readFileSync(zip)), new Uint8Array([0])));
    expect(trailingProblem(join(dir, "b.zip"), "zip")).toBe("has bytes after its zip's end record");
    // cab: the header's size.
    const cab = new Uint8Array(64);
    cab.set(new TextEncoder().encode("MSCF"));
    new DataView(cab.buffer).setUint32(8, 60, true);
    writeFileSync(join(dir, "a.cab"), cab);
    expect(trailingProblem(join(dir, "a.cab"), "cab")).toBe("has 4 bytes after its cab's end");
  });

  test("bytes a decoder skips fail the scan: zstd and lz4 skippable frames, a gzip's extra field or comment", async () => {
    const { gzipEnd, lz4End, trailingProblem, zstdEnd } = await import("./name-scan");
    const enc = (t: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(t) as Uint8Array<ArrayBuffer>;
    const dir = mkdtempSync(join(tmpdir(), "clover-name-skipped-"));
    const z = Bun.zstdCompressSync(enc("zstd words"));
    const hidden = Bun.gzipSync(enc("hidden PLANTED words"));
    const skip = (payload: Uint8Array): Uint8Array => { const h = new Uint8Array(8); new DataView(h.buffer).setUint32(0, 0x184d2a5a, true); new DataView(h.buffer).setUint32(4, payload.length, true); return cat(h, payload); };
    // A zstd with a gzip in a skippable frame: Bun's decoder reads it as the plain stream, the scan refuses it.
    const withSkip = cat(z, skip(hidden), z);
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(withSkip))).toBe("zstd wordszstd words");
    expect(zstdEnd(withSkip)).toEqual({ end: withSkip.length, skippable: 1 });
    writeFileSync(join(dir, "a.zst"), withSkip);
    expect(trailingProblem(join(dir, "a.zst"), "zst")).toBe("holds 1 zstd skippable frame(s), bytes its decoder skips");
    writeFileSync(join(dir, "b.zst"), cat(z, z));
    expect(trailingProblem(join(dir, "b.zst"), "zst")).toBeUndefined();
    writeFileSync(join(dir, "c.zst"), cat(z, enc("junk")));
    expect(trailingProblem(join(dir, "c.zst"), "zst")).toBe("has 4 bytes after its zstd stream's end");
    // lz4: a frame (no content size, no checksums: one raw block), then a skippable frame.
    const lz4 = cat(new Uint8Array([0x04, 0x22, 0x4d, 0x18, 0x40, 0x40, 0x00]), new Uint8Array([3, 0, 0, 0x80]), enc("abc"), new Uint8Array(4));
    expect(lz4End(lz4)).toEqual({ end: lz4.length, skippable: 0 });
    writeFileSync(join(dir, "a.lz4"), cat(lz4, skip(hidden)));
    expect(trailingProblem(join(dir, "a.lz4"), "lz4")).toBe("holds 1 lz4 skippable frame(s), bytes its decoder skips");
    // gzip: an extra field (FEXTRA) carrying a gzip; a comment likewise.
    const g = Bun.gzipSync(enc("member"));
    const extra = cat(g.subarray(0, 3), new Uint8Array([g[3]! | 4]), g.subarray(4, 10), new Uint8Array([hidden.length & 0xff, hidden.length >> 8]), hidden, g.subarray(10));
    expect(gzipEnd(extra)).toEqual({ end: extra.length, skipped: true });
    writeFileSync(join(dir, "a.gz"), extra);
    expect(trailingProblem(join(dir, "a.gz"), "gz")).toBe("has a gzip member with an extra field or a comment, bytes gunzip skips");
    writeFileSync(join(dir, "b.gz"), cat(g, g));
    expect(trailingProblem(join(dir, "b.gz"), "gz")).toBeUndefined();
    writeFileSync(join(dir, "c.gz"), cat(g, new Uint8Array(2)));
    expect(trailingProblem(join(dir, "c.gz"), "gz")).toBe("has 2 bytes after its gzip stream's end");
  });

  test("a gzip member is measured by inflating it, its trailer checked", async () => {
    const { gzipMemberEnd } = await import("./name-scan");
    const g = Bun.gzipSync(new TextEncoder().encode("member one"));
    const b = cat(new Uint8Array(7).fill(9), g, new Uint8Array(3));
    expect(gzipMemberEnd(b, 7)).toBe(7 + g.length);
    const broken = b.slice();
    broken[7 + g.length - 2] = broken[7 + g.length - 2]! ^ 1;
    expect(gzipMemberEnd(broken, 7)).toBeUndefined();
    expect(gzipMemberEnd(b, 0)).toBeUndefined();
  });

  test("finds streams appended to a file read raw (and the bytes before them, again), never one in its middle", async () => {
    const { appendedStreams } = await import("./name-scan");
    const enc = (t: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(t) as Uint8Array<ArrayBuffer>;
    const raw = new Uint8Array(5000).map((_, i) => (i * 7919) & 0xff);
    const tools = { xz: Bun.which("xz") ?? undefined, bzip2: Bun.which("bzip2") ?? undefined };
    // A gzip of two members at the end: found at the first member.
    const g1 = Bun.gzipSync(enc("one")), g2 = Bun.gzipSync(enc("two"));
    expect(appendedStreams(cat(raw, g1, g2), tools)).toEqual({ found: [{ offset: 5000, kind: "gz" }], problems: [] });
    // A gzip in the middle is not appended.
    expect(appendedStreams(cat(raw, g1, raw), tools)).toEqual({ found: [], problems: [] });
    // zstd after a gzip after raw bytes: both, latest first.
    const z = Bun.zstdCompressSync(enc("zstd words"));
    expect(appendedStreams(cat(raw, g1, z), tools).found).toEqual([{ offset: 5000 + g1.length, kind: "zst" }, { offset: 5000, kind: "gz" }]);
    // A zip after raw bytes: placed by its central directory.
    const dir = mkdtempSync(join(tmpdir(), "clover-name-appended-streams-"));
    writeFileSync(join(dir, "in.txt"), "inside");
    expect(Bun.spawnSync(["bsdtar", "-a", "-cf", join(dir, "z.zip"), "-C", dir, "in.txt"]).exitCode).toBe(0);
    expect(appendedStreams(cat(raw, new Uint8Array(readFileSync(join(dir, "z.zip")))), tools).found).toEqual([{ offset: 5000, kind: "zip" }]);
    // xz and bzip2, checked by their tools; without the tool, a stream that looks appended fails the scan.
    if (tools.xz !== undefined) {
      const x = new Uint8Array(Bun.spawnSync([tools.xz, "-c"], { stdin: enc("xz words") }).stdout);
      expect(appendedStreams(cat(raw, x), tools).found).toEqual([{ offset: 5000, kind: "xz" }]);
      expect(appendedStreams(cat(raw, x), {}).problems).toEqual(["ends with an xz stream, which the scan needs xz to check"]);
      expect(appendedStreams(cat(raw, x, raw), tools).found).toEqual([]);
    }
    if (tools.bzip2 !== undefined) {
      const bz = new Uint8Array(Bun.spawnSync([tools.bzip2, "-c"], { stdin: enc("bzip2 words") }).stdout);
      expect(appendedStreams(cat(raw, bz), tools).found).toEqual([{ offset: 5000, kind: "bz2" }]);
      expect(appendedStreams(cat(raw, bz, enc("junk")), tools).found).toEqual([]);
    }
    expect(appendedStreams(raw, tools)).toEqual({ found: [], problems: [] });
  });

  test("an AppImage's squashfs starts where its ELF runtime ends", async () => {
    const { elfEnd } = await import("./name-scan");
    const elf = new Uint8Array(128);
    const v = new DataView(elf.buffer);
    v.setUint32(0, 0x7f454c46);
    elf[4] = 2;
    v.setBigUint64(0x28, 1000n, true);
    v.setUint16(0x3a, 64, true);
    v.setUint16(0x3c, 3, true);
    expect(elfEnd(elf)).toBe(1192);
    expect(() => elfEnd(new Uint8Array(64))).toThrow(/not an ELF/);
  });

  test("reads every file, lists every path and link target, refuses an absolute link, and accepts only the shipped notices", async () => {
    const { walkTree } = await import("./name-scan");
    const root = mkdtempSync(join(tmpdir(), "clover-name-walk-"));
    mkdirSync(join(root, "resources", "daemon"), { recursive: true });
    writeFileSync(join(root, "resources", "daemon", "srt-win.exe"), "x");
    writeFileSync(join(root, "resources", "daemon", "srt-win.THIRD_PARTY_NOTICES.txt"), "license");
    writeFileSync(join(root, "srt-win.THIRD_PARTY_NOTICES.txt"), "elsewhere");
    writeFileSync(join(root, ".DS_Store"), "ds");
    writeFileSync(join(root, "data.tar.xz"), "xz");
    symlinkSync("resources/daemon/srt-win.exe", join(root, "rel-link"));
    symlinkSync("/Users/someone/thing", join(root, "abs-link"));
    const w = walkTree(root);
    expect(w.read.map((p) => p.slice(root.length + 1)).sort()).toEqual([".DS_Store", "data.tar.xz", "resources/daemon/srt-win.exe", "srt-win.THIRD_PARTY_NOTICES.txt"]);
    expect(w.accepted.map((p) => p.slice(root.length + 1))).toEqual(["resources/daemon/srt-win.THIRD_PARTY_NOTICES.txt"]);
    expect(w.names).toContain("resources/daemon/srt-win.THIRD_PARTY_NOTICES.txt");
    expect(w.names).toContain("resources/daemon/srt-win.exe");
    expect(w.names).toContain("/Users/someone/thing");
    expect(w.problems).toEqual(["abs-link links to an absolute path (/Users/someone/thing)"]);
    expect(w.nested.map((p) => p.slice(root.length + 1))).toEqual(["data.tar.xz"]);
  });
});

describe("the privacy scrub", () => {
  test("the sidecar's build remaps the cargo home, the checkout and the home folder, after any flags already set", async () => {
    const { linkBuildEnv } = await import("../build-packages");
    const env = linkBuildEnv({ HOME: "/Users/someone", RUSTFLAGS: "-C opt-level=3" }, "/Users/someone/Xcode projects/clover");
    // rustc takes the last match: the home folder first, the paths inside it after; a space stays inside its flag.
    expect(env.CARGO_ENCODED_RUSTFLAGS!.split("\x1f")).toEqual(["-C", "opt-level=3", "--remap-path-prefix=/Users/someone=/home", "--remap-path-prefix=/Users/someone/.cargo=/cargo", "--remap-path-prefix=/Users/someone/Xcode projects/clover=/clover"]);
    expect(env.RUSTFLAGS).toBeUndefined();
    expect(linkBuildEnv({ HOME: "/h", CARGO_HOME: "/c", CARGO_ENCODED_RUSTFLAGS: "-Cx\x1f-Cy" }, "/r").CARGO_ENCODED_RUSTFLAGS!.split("\x1f")).toEqual(["-Cx", "-Cy", "--remap-path-prefix=/h=/home", "--remap-path-prefix=/c=/cargo", "--remap-path-prefix=/r=/clover"]);
  });
});

describe("the name scan, end to end with a stand-in guard", () => {
  test("hands the guard the asset, what is inside it (a nested gzip too) and the names list, and reports a hit", async () => {
    if (process.platform === "win32") return;
    const { nameScan } = await import("./name-scan");
    const { createPackage } = await import("@electron/asar");
    const home = mkdtempSync(join(tmpdir(), "clover-name-scan-e2e-"));
    const log = join(home, "read.log");
    mkdirSync(join(home, "norma-private", "git-hooks"), { recursive: true });
    // The stand-in reads what it's given and "finds" a hit in any file holding PLANTED.
    writeFileSync(join(home, "norma-private", "git-hooks", "name-guard.sh"), `#!/bin/sh\nshift\nfor f in "$@"; do echo "$f" >> '${log}'; if grep -q PLANTED "$f"; then exit 1; fi; done\n`, { mode: 0o755 });
    const tree = join(home, "tree");
    mkdirSync(join(tree, "resources"), { recursive: true });
    const packed = join(home, "packed");
    mkdirSync(join(packed, "lib"), { recursive: true });
    writeFileSync(join(packed, "lib", "inside-asar.txt"), "packed words");
    writeFileSync(join(packed, "lib", "deeper.gz"), Bun.gzipSync(new TextEncoder().encode("asar PLANTED words")));
    await createPackage(packed, join(tree, "resources", "app.asar"));
    const enc = (t: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(t) as Uint8Array<ArrayBuffer>;
    writeFileSync(join(tree, "notes.txt.gz"), Bun.gzipSync(enc("hidden PLANTED words")));
    // A gzip by another name, and one by no archive name at all: both are opened by their bytes.
    const tarDir = join(home, "tgz");
    mkdirSync(tarDir);
    writeFileSync(join(tarDir, "in-the-tgz.txt"), "tgz PLANTED words");
    const tarFile = join(home, "inner.tar");
    expect(Bun.spawnSync(["bsdtar", "-cf", tarFile, "-C", tarDir, "."]).exitCode).toBe(0);
    writeFileSync(join(tree, "hidden.tgz"), Bun.gzipSync(new Uint8Array(readFileSync(tarFile))));
    writeFileSync(join(tree, "blob.bin"), Bun.gzipSync(enc("renamed PLANTED words")));
    // A gzip appended to bytes in no format is cut out and opened; a tar with a gzip after its end fails the scan.
    writeFileSync(join(tree, "carrier.dat"), cat(new Uint8Array(3000).fill(0x41), Bun.gzipSync(enc("appended PLANTED words"))));
    writeFileSync(join(tree, "padded.tar"), cat(new Uint8Array(readFileSync(tarFile)), Bun.gzipSync(enc("after the end"))));
    // A format it knows that doesn't open (an LZ4 frame header and nothing after) fails the scan, never read raw only.
    writeFileSync(join(tree, "junk.bin"), new Uint8Array([4, 0x22, 0x4d, 0x18, 1, 2, 3]));
    const zip = join(home, "Clover-1.2.3-mac.zip");
    expect(Bun.spawnSync(["bsdtar", "-a", "-cf", zip, "-C", tree, "."]).exitCode).toBe(0);
    const r = nameScan([zip], [], home);
    const seen = readFileSync(log, "utf8");
    expect(seen).toContain("Clover-1.2.3-mac.zip");
    expect(seen).toContain("app.asar");
    expect(seen).toContain("inside-asar.txt");
    expect(seen).toMatch(/notes\.txt(\n|$)/);
    expect(seen).toContain("in-the-tgz.txt");
    expect(seen).toContain("blob.bin.out");
    expect(seen).toContain("names.txt");
    expect(r.read).toBeGreaterThanOrEqual(8);
    const hit = (where: string): boolean => r.problems.some((p) => p.includes(`found the owner's identity in Clover-1.2.3-mac.zip/${where}`));
    expect(hit("notes.txt.gz")).toBe(true);
    expect(hit("hidden.tgz/hidden.tar")).toBe(true);
    expect(hit("blob.bin")).toBe(true);
    expect(hit("resources/app.asar/asar/lib/deeper.gz")).toBe(true);
    expect(r.problems.some((p) => p.startsWith("junk.bin ") && /lz4/.test(p) || p === "junk.bin doesn't open for the scan")).toBe(true);
    expect(r.problems.some((p) => p.includes("found the owner's identity in Clover-1.2.3-mac.zip/carrier.dat (its appended gz)"))).toBe(true);
    expect(r.problems.some((p) => /^padded\.tar has \d+ bytes after its tar archive's end$/.test(p))).toBe(true);
    // Nothing else failed to open: the asar, the tgz and the renamed gzip all did.
    expect(r.problems.filter((p) => p.startsWith("junk.bin ")).length).toBe(1);
    expect(r.problems.filter((p) => !p.startsWith("junk.bin ") && !p.startsWith("padded.tar ") && !p.includes("found the owner's identity"))).toEqual([]);
  });
});

describe("no draft without the sealed core's proof, on the bytes that ship (#243 checks 4 and 5)", () => {
  const V = "1.2.3";
  const CORE = ["Clover.app", "Contents", "Resources", "daemon", "clover-core"];
  /** A `Clover.app` whose daemon/clover-core holds `core`, under `dir`. */
  const app = (dir: string, core: string) => {
    mkdirSync(join(dir, ...CORE.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...CORE), core);
  };
  /** A build folder: the unpacked app, the dmg and the zip (stand-ins: their contents are what the openers yield). */
  function build(o: { app?: string; zip?: string; dmg?: string; apps?: number } = {}) {
    const dist = mkdtempSync(join(tmpdir(), "clover-publish-proof-"));
    for (let i = 0; i < (o.apps ?? 1); i++) app(join(dist, i === 0 ? "mac-arm64" : `mac-x${i}`), o.app ?? "core-A");
    writeFileSync(join(dist, `Clover-${V}.dmg`), "dmg");
    writeFileSync(join(dist, `Clover-${V}-mac.zip`), "zip");
    const mounted: string[] = [];
    const openers: ShippedOpeners = {
      extractZip: (_zip, dest) => { app(dest, o.zip ?? o.app ?? "core-A"); return true; },
      mountDmg: (_dmg, mountpoint) => { app(mountpoint, o.dmg ?? o.app ?? "core-A"); mounted.push(mountpoint); return () => { mounted.splice(mounted.indexOf(mountpoint), 1); }; },
    };
    return { dist, openers, mounted, unpacked: join(dist, "mac-arm64", ...CORE), dmg: { dir: dist, name: `Clover-${V}.dmg` } };
  }

  test("the proof runs with --signed --require-proof on the zip's own copy in a private folder, never the build folder's file", () => {
    const b = build();
    expect(sealProofCommand("/x/clover-core", "/repo").slice(1)).toEqual(["/repo/scripts/verify-sealed-core.ts", "--binary", "/x/clover-core", "--signed", "--require-proof"]);
    const asked: string[] = [];
    expect(sealProofProblem(b.dmg, V, (c) => { asked.push(c); expect(readFileSync(c, "utf8")).toBe("core-A"); return true; }, b.openers)).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.startsWith(b.dist)).toBe(false);
    expect(asked[0]!.endsWith(join("zip", ...CORE))).toBe(true);
    expect(existsSync(asked[0]!)).toBe(false); // the private folder is gone afterwards
    expect(b.mounted).toEqual([]); // the dmg was detached
    // Not proven (SIP off, an UNPROVABLE door, anything failing): refused.
    expect(sealProofProblem(b.dmg, V, () => false, b.openers)).toContain("no draft without the seal's proof");
    // A release with no macOS build has nothing to prove here.
    expect(sealProofProblem(undefined, V, () => false, b.openers)).toBeUndefined();
  });

  test("the build folder's core swapped after the hashing changes nothing: the proof is on the private copy", () => {
    const b = build();
    const proven: string[] = [];
    const result = sealProofProblem(b.dmg, V, (c) => {
      writeFileSync(b.unpacked, "a swapped core"); // the swap the build folder allows
      proven.push(readFileSync(c, "utf8"));
      return true;
    }, b.openers);
    expect(result).toBeUndefined();
    expect(proven).toEqual(["core-A"]);
    // The private copy itself changing during its proof is refused.
    const c = build();
    expect(sealProofProblem(c.dmg, V, (core) => { writeFileSync(core, "changed"); return true; }, c.openers)).toContain("changed during its proof");
  });

  test("a stale mac* folder in another --from folder is never what gets proven; none or two apps are refused", () => {
    const stale = mkdtempSync(join(tmpdir(), "clover-publish-stale-"));
    app(join(stale, "mac-arm64"), "an old core");
    const b = build();
    const proven: string[] = [];
    expect(sealProofProblem(b.dmg, V, (c) => { proven.push(readFileSync(c, "utf8")); return true; }, b.openers)).toBeUndefined();
    expect(proven).toEqual(["core-A"]);
    expect(sealProofProblem({ dir: join(stale, "nothing"), name: `Clover-${V}.dmg` }, V, () => true, b.openers)).toContain("can't be proven");
    const two = build({ apps: 2 });
    expect(proveShippedMacCore(two.dist, V, () => true, two.openers)).toContain("exactly one mac*/Clover.app");
  });

  test("a zip or a dmg whose clover-core differs is refused before any proof; a dmg that won't mount too", () => {
    const never = () => { throw new Error("proved a core that doesn't match"); };
    const zip = build({ zip: "another core" });
    expect(proveShippedMacCore(zip.dist, V, never, zip.openers)).toContain(`the clover-core in ${join(zip.dist, `Clover-${V}-mac.zip`)} is not the one`);
    const dmg = build({ dmg: "another core" });
    expect(proveShippedMacCore(dmg.dist, V, never, dmg.openers)).toContain(`the clover-core in ${join(dmg.dist, `Clover-${V}.dmg`)} is not the one`);
    expect(dmg.mounted).toEqual([]); // detached even when refused
    const b = build();
    expect(proveShippedMacCore(b.dist, V, never, { ...b.openers, mountDmg: () => undefined })).toContain("could not be mounted");
  });
});
