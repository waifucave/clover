// The release (scripts/release/): the channels and feed, the update files, the signing commands and their checks,
// the release build's and the owner's publish step's plans, and the release workflow's limits (no secrets, nothing
// published). Nothing here signs, builds or publishes.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builderEnv, buildOsFor, CLOVER_APP_REQUIREMENT, parseReleaseBuildArgs, releaseBuilderArgs, signingInputs } from "./build";
import { CLOVER_TEAM_ID } from "../../packages/core/src/auth/app-token-acl";
import {
  channelsServed, checkUpdateInfo, codesignArgs, expectedArtifacts, FEED, feedFile, formatUpdateInfo, identityTeam, installers,
  notarizeArgs, parseCodesignDisplay, parseUpdateInfo, refreshEntry, RESOURCE_BINARIES, sha512Base64, signatureProblems,
  writeServedCopies,
} from "./lib";
import { generateFeedKey, publicKeyOf, verifyFeed } from "../../packages/update-feed/src/index";
import { FEED_KEY_ITEM, generate, signingKey, withPublicKey, type KeyStore } from "./feed-key";
import { draftReleaseArgs, parsePublishArgs, planRelease, promotedName, RELEASE_OSES, proveShippedMacCore, sealProofCommand, sealProofProblem, signFeeds, type ShippedOpeners } from "./publish";

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

  test("--sign on macOS takes only Clover's team, whose app requirement the release checks", () => {
    expect(signingInputs("mac", { CLOVER_MAC_IDENTITY: `Developer ID Application: Example Ltd (${CLOVER_TEAM_ID})`, APPLE_KEYCHAIN_PROFILE: "p" })).toEqual({ missing: [], problems: [] });
    expect(signingInputs("mac", { CLOVER_MAC_IDENTITY: "Developer ID Application: Example Ltd (AB12CD34EF)", APPLE_KEYCHAIN_PROFILE: "p" }).problems)
      .toEqual([`CLOVER_MAC_IDENTITY is team AB12CD34EF's, not Clover's (${CLOVER_TEAM_ID})`]);
    expect(CLOVER_APP_REQUIREMENT).toBe(`identifier "com.waifucave.clover" and anchor apple generic and certificate leaf[subject.OU] = "${CLOVER_TEAM_ID}"`);
  });
});

describe("the owner's publish step (scripts/release/publish.ts)", () => {
  const version = "1.2.3";
  const yml = (files: string[], blobs: Map<string, Uint8Array>) => utf8(formatUpdateInfo({ version, files: files.map((url) => ({ url, sha512: sha512Base64(blobs.get(url)!), size: blobs.get(url)!.length })) }));
  function builds(channel: "latest" | "beta") {
    const dirs = new Map<string, Map<string, Uint8Array>>();
    for (const os of RELEASE_OSES) {
      const blobs = new Map<string, Uint8Array>(installers(version, os).map((n) => [n, utf8(`${n} bytes`)]));
      blobs.set(`${installers(version, os)[0]}.blockmap`, utf8("map"));
      const named = os === "mac" ? installers(version, os) : installers(version, os).filter((n) => !n.endsWith(".deb") && !n.endsWith(".rpm"));
      for (const c of channelsServed(channel)) blobs.set(feedFile(c, os), yml(named, blobs));
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
    for (const s of sigs) expect(verifyFeed(dirs.get("out/mac")!.get("latest-mac.yml")!, sigs.find((x) => x.name === "latest-mac.yml.sig")!.signature, key.publicKey)).toEqual({ ok: true });
    // A key the app doesn't carry signs nothing.
    expect(() => signFeeds(p, (d, n) => dirs.get(d)!.get(n)!, key.privateKey, generateFeedKey().publicKey)).toThrow(/doesn't verify against the app's key/);
  });

  test("the draft: tagged v<version>, a draft always, a pre-release on beta", () => {
    const p = plan(builds("beta"), "beta");
    const args = draftReleaseArgs(p, "waifucave/clover");
    expect(args.slice(0, 7)).toEqual(["gh", "release", "create", "v1.2.3", "--repo", "waifucave/clover", "--draft"]);
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
