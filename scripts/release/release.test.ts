// The release (scripts/release/): the channels and feed, the update files, the signing commands and their checks,
// the release build's and the owner's publish step's plans, and the release workflow's limits (no secrets, nothing
// published). Nothing here signs, builds or publishes.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builderEnv, buildOsFor, parseReleaseBuildArgs, releaseBuilderArgs, signingInputs } from "./build";
import {
  channelsServed, checkUpdateInfo, codesignArgs, expectedArtifacts, FEED, feedFile, formatUpdateInfo, identityTeam, installers,
  notarizeArgs, parseCodesignDisplay, parseUpdateInfo, refreshEntry, RESOURCE_BINARIES, sha512Base64, signatureProblems,
  writeServedCopies, authenticodeCommand, authenticodeProblems, buildCommitFile, parseEntitlementKeys,
} from "./lib";
import { generateFeedKey, publicKeyOf, verifyFeed } from "../../packages/update-feed/src/index";
import { FEED_KEY_ITEM, generate, signingKey, withPublicKey, type KeyStore } from "./feed-key";
import { draftReleaseArgs, parsePublishArgs, planRelease, promotedName, promotedSignature, RELEASE_OSES, signFeeds } from "./publish";

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
    expect(expectedArtifacts("1.2.3", "win", "latest")).toEqual(["Clover-Setup-1.2.3.exe", "latest.yml", "beta.yml"]);
  });

  test("macOS: the hardened runtime, the app's entitlements, notarization off unless the release turns it on, and the resources' binaries left to the release", () => {
    expect(builder.mac.identity).toBeNull();
    expect(builder.mac.notarize).toBe(false);
    expect(builder.mac.hardenedRuntime).toBe(true);
    expect(builder.mac.signIgnore).toEqual(["Contents/Resources/daemon/"]);
    const ent = read("packaging/macos/entitlements.mac.plist");
    expect(ent).toContain("com.apple.security.cs.allow-jit");
    expect(ent).not.toContain("disable-library-validation");
    expect(RESOURCE_BINARIES.map((b) => b.file)).toEqual(builder.extraResources[0].filter.filter((f: string) => !f.endsWith(".exe") && !f.endsWith(".txt")));
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
    const twice = builds("beta");
    twice.get("out/win")!.set("Clover-1.2.3.dmg", utf8("x"));
    expect(plan(twice, "beta").problems.some((x) => x.includes("is in both"))).toBe(true);
  });

  test("each update file is signed with the Keychain's key, checked against the app's, and nothing else is signed", () => {
    const dirs = builds("latest");
    const p = plan(dirs, "latest");
    expect(p.feeds.sort()).toEqual(RELEASE_OSES.flatMap((os) => channelsServed("latest").map((c) => feedFile(c, os))).sort());
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
    expect(() => promotedName("latest.yml")).toThrow();
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

describe("srt-win.exe, Bash's fence launcher on Windows (scripts/release/srt-win.ts)", () => {
  test("from sandbox-runtime's pinned commit, statically linked, reproducibly, for both Windows architectures", async () => {
    const { SRT_WIN_SOURCE, buildEnv, cargoArgs, parseSrtWinArgs } = await import("./srt-win");
    expect(SRT_WIN_SOURCE).toMatchObject({ tag: "v0.0.81", commit: "c40cf14a65d025e3cd27f071f13a73c12b3b1f92", dir: "vendor/srt-win-src" });
    const env = buildEnv({ PATH: "x", RUSTFLAGS: "-C ignored" }, "C:\\Users\\Some One\\src", "C:\\cargo");
    // One flag per 0x1f: a path with a space stays whole, and RUSTFLAGS is dropped (cargo would ignore it anyway).
    const flags = env.CARGO_ENCODED_RUSTFLAGS!.split("\x1f");
    expect(flags).toContain("-Ctarget-feature=+crt-static");
    expect(flags).toContain("-Clink-arg=/Brepro");
    // One rustc argument each: no flag carries a space of its own outside a path.
    expect(flags.filter((f) => !f.startsWith("--remap-path-prefix=")).every((f) => !f.includes(" "))).toBe(true);
    expect(flags).toContain("--remap-path-prefix=C:\\Users\\Some One\\src=/srt");
    expect(env.RUSTFLAGS).toBeUndefined();
    expect(cargoArgs("arm64", "S")).toEqual(["cargo", "build", "--release", "--locked", "--manifest-path", join("S", "vendor/srt-win-src", "Cargo.toml"), "--target", "aarch64-pc-windows-msvc"]);
    expect(cargoArgs("x64", "S").join(" ")).not.toContain("--features");
    expect(parseSrtWinArgs(["--arch", "x64,arm64", "--print"])).toEqual({ arches: ["x64", "arm64"], print: true, dryRun: false });
    expect(() => parseSrtWinArgs(["--arch", "ia32"])).toThrow(/x64 and\/or arm64/);
  });

  test("checked against core's pin: a mismatch or no pin fails, --print only measures", async () => {
    const { parsePins, pinProblems } = await import("./srt-win");
    const x = "a".repeat(64);
    const pins = parsePins(`export const SRT_WIN_PINS = Object.freeze({\n  x64: "${x}",\n  arm64: "${"b".repeat(64)}",\n});`);
    expect(pins).toEqual({ x64: x, arm64: "b".repeat(64) });
    expect(parsePins(undefined)).toEqual({});
    expect(pinProblems("x64", x, pins, false)).toEqual([]);
    expect(pinProblems("x64", "c".repeat(64), pins, false)[0]).toContain("but core pins");
    expect(pinProblems("arm64", x, {}, false)[0]).toContain("pins no srt-win.exe for arm64");
    expect(pinProblems("arm64", x, {}, true)).toEqual([]);
  });

  test("the notices' license list is a reviewed decision, and electron-builder never signs the pinned launcher", () => {
    expect(read("packaging/windows/about.toml")).toMatch(/^accepted = \[/m);
    expect(builder.win.signExts).toEqual(["!srt-win.exe"]);
    expect(builder.extraResources[0].filter).toEqual(expect.arrayContaining(["srt-win.exe", "srt-win.THIRD_PARTY_NOTICES.txt"]));
  });
});

describe("the launcher's pin: its Authenticode digest", () => {
  // A minimal PE32+ image: the MZ header, the PE signature, a COFF header with one section, an optional header with
  // 16 data directories, the section table, then the .text section's raw data (0x200..0x400). `signed` appends a
  // certificate table (8-byte aligned, zero-padded) and points the directory at it; `entry` overrides where it points.
  const TEXT = 0x200;
  function pe(signed: Uint8Array | null, opts: { checksum?: number; entry?: [number, number]; tail?: Uint8Array; raw?: number } = {}): Uint8Array {
    const peAt = 0x80, optional = peAt + 24, optionalSize = 112 + 16 * 8, sectionTable = optional + optionalSize;
    const raw = opts.raw ?? 0x200;
    const image = new Uint8Array(TEXT + raw).fill(0x90, TEXT);
    const v = new DataView(image.buffer);
    v.setUint16(0, 0x5a4d, true);
    v.setUint32(0x3c, peAt, true);
    v.setUint32(peAt, 0x00004550, true);
    v.setUint16(peAt + 6, 1, true);
    v.setUint16(peAt + 20, optionalSize, true);
    v.setUint16(optional, 0x20b, true);
    v.setUint32(optional + 60, TEXT, true);
    v.setUint32(optional + 64, opts.checksum ?? 0, true);
    v.setUint32(optional + 108, 16, true);
    v.setUint32(sectionTable + 16, raw, true);
    v.setUint32(sectionTable + 20, TEXT, true);
    const tail = opts.tail ?? new Uint8Array(0);
    const unsigned = new Uint8Array(image.length + tail.length);
    unsigned.set(image);
    unsigned.set(tail, image.length);
    if (signed === null) return unsigned;
    const padded = Math.ceil(unsigned.length / 8) * 8;
    const out = new Uint8Array(padded + signed.length);
    out.set(unsigned);
    out.set(signed, padded);
    const o = new DataView(out.buffer);
    const [at, size] = opts.entry ?? [padded, signed.length];
    o.setUint32(optional + 112 + 32, at, true);
    o.setUint32(optional + 112 + 36, size, true);
    return out;
  }

  test("is the same unsigned, signed, and signed again with another timestamp; it changes with the image", async () => {
    const { authenticodeDigest } = await import("./srt-win");
    const unsigned = authenticodeDigest(pe(null));
    expect(authenticodeDigest(pe(new Uint8Array(40).fill(1), { checksum: 0x1234 }))).toBe(unsigned);
    expect(authenticodeDigest(pe(new Uint8Array(56).fill(2), { checksum: 0x9999 }))).toBe(unsigned);
    const changed = pe(null);
    changed[TEXT + 5] = 0xcc;
    expect(authenticodeDigest(changed)).not.toBe(unsigned);
    expect(() => authenticodeDigest(new Uint8Array(100))).toThrow(/no MZ header/);
  });

  test("an unaligned image hashes the same as its signed form, padded the way signtool pads it", async () => {
    const { authenticodeDigest } = await import("./srt-win");
    // The last section ends unaligned: signing pads it with zeros up to the boundary, and the digest is unchanged.
    const unsigned = pe(null, { raw: 0x1fd });
    expect(unsigned.length % 8).not.toBe(0);
    expect(authenticodeDigest(pe(new Uint8Array(16).fill(3), { raw: 0x1fd }))).toBe(authenticodeDigest(unsigned));
    // Data after the last section (an overlay) can't be told from padding, so a signed file with any is refused.
    expect(() => authenticodeDigest(pe(new Uint8Array(16).fill(3), { tail: new Uint8Array([1, 2, 3]) }))).toThrow(/data between the image and the certificate table/);
  });

  test("refuses a certificate entry that could hide code: over .text, inside the headers, short of the end, unaligned", async () => {
    const { authenticodeDigest } = await import("./srt-win");
    const sig = new Uint8Array(32).fill(4);
    expect(() => authenticodeDigest(pe(sig, { entry: [TEXT, 0x100] }))).toThrow(/starts inside the headers|overlaps a section's data|doesn't end at the end/);
    const overText = pe(sig, { entry: [TEXT + 0x10, 0x400 - 0x10 + 32] });
    expect(() => authenticodeDigest(overText)).toThrow(/overlaps a section's data/);
    expect(() => authenticodeDigest(pe(sig, { entry: [0x40, 16] }))).toThrow(/inside the headers/);
    expect(() => authenticodeDigest(pe(sig, { entry: [0x400, 16] }))).toThrow(/doesn't end at the end of the file/);
    expect(() => authenticodeDigest(pe(sig, { entry: [0x404, 28] }))).toThrow(/isn't 8-byte aligned/);
  });
});

describe("the Windows installer's elevated step", () => {
  test("its script goes in compact, with the daemon's digest pinned, and the same PE rules as the release's", async () => {
    const { sandboxScript, SANDBOX_SCRIPT_MAX } = await import("./build");
    const src = read("packaging/windows/sandbox-elevated.ps1");
    const b64 = sandboxScript(src, "d".repeat(64));
    expect(b64.length).toBeLessThanOrEqual(SANDBOX_SCRIPT_MAX);
    const code = Buffer.from(Bun.gunzipSync(new Uint8Array(Buffer.from(b64, "base64")))).toString("utf8");
    expect(code).toContain(`$Pin = '${"d".repeat(64)}'`);
    expect(code).not.toMatch(/^\s*#/m);
    // Copied into the protected folder, checked there, and run only from there.
    // Program Files as Windows has it, each user's copy under their SID, the folders checked before the copy.
    expect(code).toContain("Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Clover Sandbox'");
    expect(code).not.toContain("$env:ProgramFiles");
    expect(code).toContain("$dir = Join-Path $base $User");
    expect(code).toContain("$User -notmatch '^S-1-[0-9]+(-[0-9]+)+\\z'");
    expect(code).toContain("param([string]$Action, [string]$SourceB64, [string]$UserB64)");
    const { SANDBOX_EXIT } = await import("../../packaging/installer-hooks");
    for (const n of [SANDBOX_EXIT.exeMissing, SANDBOX_EXIT.copyNotPinned, SANDBOX_EXIT.notProtected, SANDBOX_EXIT.badArgument]) {
      expect(code).toContain(`exit ${n}`);
    }
    // The copy: never over an old file (deleted first, then created new, so it is born with the folder's list), the
    // folders protected before it is written, the copy itself checked, then its digest, then run.
    const at = (t: string): number => { const i = code.indexOf(t); expect(i, t).toBeGreaterThanOrEqual(0); return i; };
    expect(code).not.toContain("Copy-Item");
    expect(at("  Set-Protected $base")).toBeLessThan(at("  Set-Protected $dir"));
    expect(at("  Set-Protected $dir")).toBeLessThan(at("Remove-Item -LiteralPath $exe -Force }"));
    expect(at("Remove-Item -LiteralPath $exe -Force }")).toBeLessThan(at("[IO.FileMode]::CreateNew"));
    expect(code).toContain("([IO.FileShare]::None), 65536, ([IO.FileOptions]::None), (New-Protected $false)");
    expect(code).toContain("$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))");
    expect(code).toContain("if (-not (Test-Owner $Path)) { exit 6 }");
    expect(at("[IO.FileMode]::CreateNew")).toBeLessThan(at("if (-not (Test-Protected $exe)) { Remove-Item"));
    expect(at("if (-not (Test-Protected $exe)) { Remove-Item")).toBeLessThan(at("(Get-CloverDigest $exe) -ne $Pin"));
    expect(code).toContain("-or -not (Test-Protected $exe)) { exit 6 }");
    // The writer check is an allow list (only the owners may write), inheritable entries included, generic rights too.
    expect(code).toContain("($Owners -notcontains $ace.IdentityReference.Value)");
    expect(code).not.toContain("InheritOnly");
    expect(code).toContain("-bor 0x40000000 -bor 0x10000000");
    expect(code).toContain("$acl.SetAccessRuleProtection($true, $false)");
    expect(code).toContain("[IO.FileAttributes]::ReparsePoint");
    // Set-Protected refuses a reparse point before reading its owner or writing its list.
    const setProtected = code.slice(at("function Set-Protected"));
    expect(setProtected.indexOf("ReparsePoint")).toBeLessThan(setProtected.indexOf("Test-Owner $Path"));
    expect(setProtected.indexOf("Test-Owner $Path")).toBeLessThan(setProtected.indexOf("SetAccessControl"));
    // remove deletes the copy, then the empty folder by name: never a recursive delete.
    expect(code).not.toContain("-Recurse");
    expect(code).toContain("Remove-Item -LiteralPath $exe -Force; [IO.Directory]::Delete($dir, $false)");
    expect(code).toContain("Start-Process -FilePath $exe -ArgumentList 'sandbox', $Action");
    expect(code).not.toContain("-FilePath $Source");
    // The certificate table's rules, as authenticodeDigest has them.
    expect(code).toContain("$co -lt $headers -or $co -lt $end -or $co + $cs -ne $b.Length -or $co % 8 -ne 0");
    expect(() => sandboxScript(src, "nope")).toThrow(/not a SHA-256/);
    expect(() => sandboxScript(src.replace("__CLOVER_CORE_DIGEST__", "x"), "d".repeat(64))).toThrow(/placeholder once/);
  });

  test("the installer elevates only the encoded script, passes the path quoted, clears it, and stops the old daemon on an upgrade", () => {
    const text = read("packaging/windows/installer.nsh");
    expect(text).toContain('!include "${PROJECT_DIR}\\out\\sandbox.nsh"');
    expect(text).toContain("-Verb RunAs");
    expect(text).toContain("'-EncodedCommand'");
    // A method call in a command's argument list splits in two (PowerShell passed `[Convert]::ToBase64String` and
    // the bytes as two arguments): the encoded command is computed first and passed as a variable.
    expect(text).toContain("$$e = [Convert]::ToBase64String($$u.GetBytes($$c));");
    expect(text).toContain("'-EncodedCommand',$$e -Verb RunAs");
    expect(text).not.toMatch(/',\[Convert\]::/);
    // The path and the SID go in base64 (UTF-16): nothing of a folder name is quoted, so no quote of any kind
    // (PowerShell's curly ones included) can end a string.
    expect(text).toContain("$$src = [Convert]::ToBase64String($$u.GetBytes($$env:CLOVERINSTALL_SANDBOX_SOURCE))");
    expect(text).toContain("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
    expect(text).not.toContain(".Replace(");
    // Windows' own 64-bit PowerShell, by full path, both times.
    expect(text.match(/nsExec::ExecToLog `"\$WINDIR\\Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe"/g)).toHaveLength(2);
    expect(text).not.toMatch(/ExecToLog `powershell/);
    expect(text).toContain("Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'");
    expect(text).toContain(`Kernel32::SetEnvironmentVariable(t "CLOVERINSTALL_SANDBOX_SOURCE", p 0)i`);
    expect(text).not.toContain("CLOVER_CORE_EXE");
    // No elevated run of anything in the install folder.
    expect(text).not.toMatch(/Start-Process -FilePath \$\$env:CLOVERINSTALL/);
    const check = text.slice(text.indexOf("!macro customCheckAppRunning"), text.indexOf("!macroend", text.indexOf("!macro customCheckAppRunning")));
    expect(check).toContain(`nsExec::ExecToLog '"$INSTDIR\\resources\\daemon\\clover-core.exe" daemon stop'`);
    expect(check.indexOf("daemon stop")).toBeLessThan(check.indexOf("_CHECK_APP_RUNNING"));
    expect(check).toContain("${if} $0 == 1");
    // An old daemon without `daemon stop`: Windows stops what is still running from this install, or the install stops.
    expect(check).toContain("Get-Process -Name clover-core");
    expect(check.indexOf("daemon stop")).toBeLessThan(check.indexOf("Stop-Process -Force"));
    // The ruling: the user's own clover command line or terminal sessions may go with it, and the install says so.
    expect(check).toContain("any clover command line or terminal session you had open was closed too");
    // The script travels gzipped, opened by .NET's GZipStream in the installer's PowerShell.
    expect(text).toContain("New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String('${CLOVER_SANDBOX_PS}')))");
  });
});
