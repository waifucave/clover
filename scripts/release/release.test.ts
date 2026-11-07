// The release (scripts/release/): the channels and feed, the update files, the signing commands and their checks,
// the release build's and the owner's publish step's plans, and the release workflow's limits (no secrets, nothing
// published). Nothing here signs, builds or publishes.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builderEnv, buildOsFor, parseReleaseBuildArgs, releaseBuilderArgs, signingInputs } from "./build";
import {
  channelsServed, checkCoreFeed, checkUpdateInfo, codesignArgs, coreArtifacts, CORE_TARGET, expectedArtifacts, FEED, feedFile, formatUpdateInfo, identityTeam, installers,
  notarizeArgs, parseCodesignDisplay, parseUpdateInfo, refreshEntry, RESOURCE_BINARIES, sha512Base64, signatureProblems,
  writeCoreAssets, writeServedCopies, authenticodeCommand, authenticodeProblems, buildCommitFile, parseEntitlementKeys,
} from "./lib";
import { coreBinaryFile, coreFeedFile, formatCoreFeed, generateFeedKey, parseCoreFeed, publicKeyOf, verifyFeed } from "../../packages/update-feed/src/index";
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
    expect(expectedArtifacts("1.2.3", "win", "latest")).toEqual(["Clover-Setup-1.2.3.exe", "latest.yml", "beta.yml", "clover-core-1.2.3-windows-x64.exe", "latest-core-windows-x64.yml", "beta-core-windows-x64.yml"]);
    expect(coreArtifacts("1.2.3", "linux-arm64", "beta")).toEqual(["clover-core-1.2.3-linux-arm64", "beta-core-linux-arm64.yml"]);
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
    expect(builder.mac.signIgnore).toEqual(["Contents/Resources/daemon/"]);
    const ent = read("packaging/macos/entitlements.mac.plist");
    expect(ent).toContain("com.apple.security.cs.allow-jit");
    expect(ent).not.toContain("disable-library-validation");
    expect(RESOURCE_BINARIES.map((b) => b.file)).toEqual(builder.extraResources[0].filter.filter((f: string) => !f.endsWith(".exe")));
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
    expect(sig).toEqual({ identifier: "com.waifucave.clover.core", teamId: "AB12CD34EF", runtime: true, timestamped: true, adhoc: false });
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
    expect(parseReleaseBuildArgs([], "darwin", "arm64")).toEqual({ os: "mac", channel: "latest", sign: false, dryRun: false });
    expect(parseReleaseBuildArgs(["--channel=beta", "--sign"], "win32", "x64")).toEqual({ os: "win", channel: "beta", sign: true, dryRun: false });
    expect(parseReleaseBuildArgs(["--os", "win", "--dry-run"], "darwin", "arm64").os).toBe("win");
    expect(() => parseReleaseBuildArgs(["--os", "win"], "darwin", "arm64")).toThrow(/dry run/);
    expect(() => parseReleaseBuildArgs([], "linux", "x64")).toThrow(/build-packages/);
    expect(() => parseReleaseBuildArgs(["--channel", "nightly"], "darwin", "arm64")).toThrow(/latest or beta/);
  });

  test("unsigned unless --sign, whatever the environment holds; never publishing", () => {
    const env = { CLOVER_MAC_IDENTITY: "Developer ID Application: Example Ltd (AB12CD34EF)", APPLE_KEYCHAIN_PROFILE: "p", CSC_LINK: "x", WIN_CSC_LINK: "y", PATH: "/bin" };
    const unsigned = { os: "mac", channel: "latest", sign: false, dryRun: false } as const;
    expect(releaseBuilderArgs(unsigned, env)).toEqual(["electron-builder", "--mac", "dmg", "zip", "--arm64", "--publish", "never", "-c.publish.channel=latest"]);
    expect(builderEnv(unsigned, env)).toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
    const signed = { ...unsigned, sign: true };
    expect(releaseBuilderArgs(signed, env)).toEqual([...releaseBuilderArgs(unsigned, env), "-c.mac.identity=Developer ID Application: Example Ltd (AB12CD34EF)", "-c.mac.notarize=true"]);
    expect(builderEnv(signed, env)).toBe(env);
    const win = { os: "win", channel: "beta", sign: true, dryRun: false } as const;
    expect(releaseBuilderArgs(win, { CLOVER_WIN_PUBLISHER: "Example Ltd" })).toEqual(
      ["electron-builder", "--win", "nsis", "--x64", "--publish", "never", "-c.publish.channel=beta", "-c.win.forceCodeSigning=true", "-c.win.signtoolOptions.publisherName=Example Ltd"]);
    for (const a of [unsigned, signed, win]) expect(releaseBuilderArgs(a, env)).toContain("never");
  });

  test("--sign names what it misses, never a value", () => {
    expect(signingInputs("mac", {})).toEqual({ missing: ["CLOVER_MAC_IDENTITY", "APPLE_KEYCHAIN_PROFILE"], problems: [] });
    expect(signingInputs("mac", { CLOVER_MAC_IDENTITY: "Apple Development: x (AB12CD34EF)", APPLE_KEYCHAIN_PROFILE: "p" }).problems).toHaveLength(1);
    expect(signingInputs("win", { WIN_CSC_LINK: "secret-path" })).toEqual({ missing: ["WIN_CSC_KEY_PASSWORD", "CLOVER_WIN_PUBLISHER"], problems: [] });
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
    const twice = builds("beta");
    twice.get("out/win")!.set("Clover-1.2.3.dmg", utf8("x"));
    expect(plan(twice, "beta").problems.some((x) => x.includes("is in both"))).toBe(true);
  });

  test("each update file and daemon binary is signed with the Keychain's key, checked against the app's, and nothing else is signed", () => {
    const dirs = builds("latest");
    const p = plan(dirs, "latest");
    expect(p.feeds.sort()).toEqual(RELEASE_OSES.flatMap((os) => [...channelsServed("latest").flatMap((c) => [feedFile(c, os), coreFeedFile(c, CORE_TARGET[os])]), coreBinaryFile(version, CORE_TARGET[os])]).sort());
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
    // Nothing else failed to open: the asar, the tgz and the renamed gzip all did.
    expect(r.problems.filter((p) => p.startsWith("junk.bin ")).length).toBe(1);
    expect(r.problems.filter((p) => !p.startsWith("junk.bin ") && !p.includes("found the owner's identity"))).toEqual([]);
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
