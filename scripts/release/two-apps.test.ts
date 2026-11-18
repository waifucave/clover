// One release, two apps (scripts/release/two-apps.ts; lane PK): the two apps' versions, MOSS's own names in the release, the
// move of MOSS's outputs beside MOSS Code's, the byte-for-byte check of what both carry, the host helper MOSS Code's build
// stashes and MOSS's carries, and MOSS's electron-builder config. Temp folders only; nothing is built or signed.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackage } from "@electron/asar";
import { FEED_NAME } from "../../packages/update-feed/src/index";
import { releaseBuilderArgs } from "./build";
import { RELEASE_OSES } from "./publish";
import {
  asarHeaderHash, CODE_APP, helperIntegrityProblems, MOSS_APP, mossArtifacts, mossFeedFile, mossInstallers, mossServedCopies, mossTestBuildArtifacts,
  moveMossOutputs, oneVersionProblems, plistAsarHash, RELEASE_APPS, samePayloadProblems,
} from "./two-apps";
// @ts-expect-error: plain .mjs hooks (electron-builder loads them with Node), with no types of their own
import { makeHostHelper, stashHostHelper } from "../../apps/desktop/scripts/host-helper.mjs";
// @ts-expect-error: as above
import mossAfterPack, { carryHostHelper, hostHelperName } from "../../apps/moss/scripts/host-helper.mjs";

const ROOT = join(import.meta.dir, "..", "..");
const root = mkdtempSync(join(tmpdir(), "pk-two-apps-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
// biome-ignore lint: parsed YAML documents
const yml = (rel: string) => Bun.YAML.parse(read(rel)) as Record<string, any>;

describe("one version", () => {
  test("both apps must say VERSION's release, or the build stops before it starts", () => {
    expect(oneVersionProblems("1.2.3", { "apps/desktop": "1.2.3", "apps/moss": "1.2.3" })).toEqual([]);
    const p = oneVersionProblems("1.2.3", { "apps/desktop": "1.2.3", "apps/moss": "1.2.2" });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("apps/moss/package.json says 1.2.2, not the release 1.2.3");
    expect(oneVersionProblems("1.2.3", { "apps/desktop": undefined, "apps/moss": "1.2.3" })[0]).toContain("no version");
  });

  test("the checkout's own apps are one release", () => {
    const release = read("VERSION").trim();
    const versions = Object.fromEntries(RELEASE_APPS.map((a) => [a.dir, (JSON.parse(read(`${a.dir}/package.json`)) as { version: string }).version]));
    expect(oneVersionProblems(release, versions)).toEqual([]);
  });
});

describe("MOSS's names in the one release", () => {
  test("its installers and update files: never MOSS Code's names", () => {
    expect(mossInstallers("1.2.3", "mac")).toEqual(["MOSS-1.2.3.dmg", "MOSS-1.2.3-mac.zip"]);
    expect(mossArtifacts("1.2.3", "mac", "latest")).toEqual(["MOSS-1.2.3.dmg", "MOSS-1.2.3-mac.zip", "moss-latest-mac.yml", "moss-beta-mac.yml"]);
    expect(mossArtifacts("1.2.3", "win", "beta")).toEqual(["MOSS-Setup-1.2.3.exe", "moss-beta.yml"]);
    expect(mossTestBuildArtifacts("1.2.3")).toEqual({ dmg: "MOSS-1.2.3-TEST.dmg", zip: "MOSS-1.2.3-TEST-mac.zip" });
    // Each is a name the feed's signature covers.
    for (const os of RELEASE_OSES) for (const ch of ["latest", "beta"] as const) expect(FEED_NAME.test(mossFeedFile(ch, os))).toBe(true);
  });

  test("electron-builder is told MOSS's test names; MOSS Code's stay its own", () => {
    const a = { os: "mac" as const, channel: "beta" as const, sign: true, signDev: false, testBuild: true, dryRun: true };
    const env = { MOSS_MAC_IDENTITY: "Developer ID Application: X (ABCDE12345)" };
    expect(releaseBuilderArgs(a, env, undefined, MOSS_APP)).toContain("-c.dmg.artifactName=MOSS-${version}-TEST.${ext}");
    expect(releaseBuilderArgs(a, env, undefined, CODE_APP)).toContain("-c.dmg.artifactName=MOSS-Code-${version}-TEST.${ext}");
  });

  test("MOSS's outputs move beside MOSS Code's, its update files renamed; MOSS Code's are never touched", () => {
    const from = join(root, "moss-out"), to = join(root, "code-out");
    mkdirSync(join(from, "mac-arm64", "MOSS.app", "Contents"), { recursive: true });
    mkdirSync(join(to, "mac-arm64", "MOSS Code.app"), { recursive: true });
    for (const n of ["MOSS-1.2.3.dmg", "MOSS-1.2.3.dmg.blockmap", "MOSS-1.2.3-mac.zip", "latest-mac.yml", "builder-debug.yml"]) writeFileSync(join(from, n), n);
    writeFileSync(join(from, "mac-arm64", "MOSS.app", "Contents", "Info.plist"), "moss");
    writeFileSync(join(to, "latest-mac.yml"), "code's");
    const moved = moveMossOutputs(from, to, "mac");
    expect(moved.sort()).toEqual(["MOSS-1.2.3-mac.zip", "MOSS-1.2.3.dmg", "MOSS-1.2.3.dmg.blockmap", "mac-arm64/MOSS.app", "moss-latest-mac.yml"]);
    expect(readFileSync(join(to, "latest-mac.yml"), "utf8")).toBe("code's");
    expect(readFileSync(join(to, "moss-latest-mac.yml"), "utf8")).toBe("latest-mac.yml");
    expect(readdirSync(join(to, "mac-arm64")).sort()).toEqual(["MOSS Code.app", "MOSS.app"]);
    // A latest release serves beta users MOSS's file under MOSS's beta name.
    expect(mossServedCopies(to, "latest", "mac", (f, t) => cpSync(f, t))).toEqual(["moss-beta-mac.yml"]);
    expect(existsSync(join(to, "beta-mac.yml"))).toBe(false);
  });
});

/** A laid-out, unsigned app with an Electron-like frameworks folder and an asar whose integrity its plist names. */
async function fakeApp(dir: string, name: string, appId: string, code: string): Promise<string> {
  const app = join(dir, `${name}.app`);
  const c = join(app, "Contents");
  for (const d of ["MacOS", "Resources", "Frameworks/Electron Framework.framework/Versions/A"]) mkdirSync(join(c, d), { recursive: true });
  writeFileSync(join(c, "MacOS", name), "launcher");
  writeFileSync(join(c, "Frameworks/Electron Framework.framework/Versions/A/Electron Framework"), "framework");
  for (const k of ["", " (GPU)"]) {
    const h = join(c, "Frameworks", `${name} Helper${k}.app`, "Contents");
    mkdirSync(join(h, "MacOS"), { recursive: true });
    writeFileSync(join(h, "MacOS", `${name} Helper${k}`), "helper");
    writeFileSync(join(h, "Info.plist"), `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>${name} Helper${k}</string>\n\t<key>CFBundleIdentifier</key>\n\t<string>${appId}.helper</string>\n</dict>\n</plist>\n`);
  }
  const src = join(dir, `${name}-src`);
  mkdirSync(join(src, "out", "main"), { recursive: true });
  writeFileSync(join(src, "out", "main", "index.js"), code);
  await createPackage(src, join(c, "Resources", "app.asar"));
  const hash = asarHeaderHash(new Uint8Array(readFileSync(join(c, "Resources", "app.asar"))));
  writeFileSync(join(c, "Info.plist"), `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>${name}</string>\n\t<key>CFBundleIdentifier</key>\n\t<string>${appId}</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>1.2.3</string>\n\t<key>ElectronAsarIntegrity</key>\n\t<dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string><key>hash</key><string>${hash}</string></dict></dict>\n</dict>\n</plist>\n`);
  for (const part of ["daemon", "plugins"]) { mkdirSync(join(c, "Resources", part), { recursive: true }); writeFileSync(join(c, "Resources", part, "moss-core"), `${part} bytes`); }
  return app;
}

describe("the host helper: made once by MOSS Code's build, carried by MOSS", () => {
  test("MOSS carries MOSS Code's very helper (its code, its identity), not one made of MOSS's own asar", async () => {
    const dir = join(root, "helpers");
    mkdirSync(dir, { recursive: true });
    const code = await fakeApp(dir, "MOSS Code", "com.waifucave.moss.code", "MOSS Code's main: the host when it runs from the helper");
    const moss = await fakeApp(dir, "MOSS", "com.waifucave.moss", "MOSS's main: no host in it");
    const host = makeHostHelper({ appPath: code, appName: "MOSS Code", appId: "com.waifucave.moss.code" }) as string;
    const stash = join(dir, "stash");
    stashHostHelper(host, stash);
    expect(hostHelperName("com.waifucave.moss")).toBe("MOSS Host.app");
    expect(hostHelperName("com.waifucave.moss.dev")).toBe("MOSS Host Dev.app");
    const carried = carryHostHelper({ appPath: moss, appId: "com.waifucave.moss", stash }) as string;
    expect(carried).toBe(join(moss, "Contents", "Frameworks", "MOSS Host.app"));
    expect(readFileSync(join(carried, "Contents", "Resources", "app.asar"))).toEqual(readFileSync(join(code, "Contents", "Resources", "app.asar")));
    expect(helperIntegrityProblems("MOSS", carried, "com.waifucave.moss.host")).toEqual([]);
    // The whole check passes on the pair, and names each break.
    const same = { codeResources: join(code, "Contents", "Resources"), mossResources: join(moss, "Contents", "Resources"), codeBundle: code, mossBundle: moss };
    expect(samePayloadProblems(same)).toEqual([]);
    writeFileSync(join(moss, "Contents", "Resources", "daemon", "moss-core"), "another engine");
    expect(samePayloadProblems(same).join(" ")).toContain("the two apps' daemon differ");
    writeFileSync(join(moss, "Contents", "Resources", "daemon", "moss-core"), "daemon bytes");
    expect(samePayloadProblems(same)).toEqual([]);
    // A helper made from MOSS's own asar (the wrong way) runs other code than MOSS Code's helper.
    const wrong = makeHostHelper({ appPath: moss, appName: "MOSS", appId: "com.waifucave.moss" }) as string;
    expect(samePayloadProblems(same).join(" ")).toContain("the two apps' host helpers run different code");
    rmSync(wrong, { recursive: true, force: true });
    expect(samePayloadProblems(same).join(" ")).toContain("MOSS carries no host helper");
    carryHostHelper({ appPath: moss, appId: "com.waifucave.moss", stash });
    // A plist whose asar integrity isn't its own asar's: the integrity fuse would refuse to start it.
    const plist = join(carried, "Contents", "Info.plist");
    const xml = readFileSync(plist, "utf8");
    writeFileSync(plist, xml.replace(plistAsarHash(xml)!, "0".repeat(64)));
    expect(helperIntegrityProblems("MOSS", carried, "com.waifucave.moss.host")[0]).toContain("the integrity fuse would refuse to start it");
  });

  test("MOSS's afterPack: nothing without a stash (a plain dist), and refuses a stash with no helper", async () => {
    const appOutDir = join(root, "after");
    await fakeApp(appOutDir, "MOSS", "com.waifucave.moss", "x");
    const ctx = { electronPlatformName: "darwin", appOutDir, packager: { appInfo: { productFilename: "MOSS", id: "com.waifucave.moss" } } };
    const before = process.env.MOSS_HOST_HELPER_STASH;
    try {
      delete process.env.MOSS_HOST_HELPER_STASH;
      await mossAfterPack(ctx);
      expect(existsSync(join(appOutDir, "MOSS.app", "Contents", "Frameworks", "MOSS Host.app"))).toBe(false);
      process.env.MOSS_HOST_HELPER_STASH = join(root, "empty-stash");
      await expect(mossAfterPack(ctx)).rejects.toThrow(/holds no MOSS Host.app/);
    } finally {
      if (before === undefined) delete process.env.MOSS_HOST_HELPER_STASH; else process.env.MOSS_HOST_HELPER_STASH = before;
    }
  });
});

describe("MOSS's electron-builder config", () => {
  test("packs MOSS Code's stage, carries the helper, unpacks its add-on, and has MOSS Code's fuses and entitlements", () => {
    const moss = yml("apps/moss/electron-builder.yml"), code = yml("apps/desktop/electron-builder.yml");
    expect(moss.appId).toBe("com.waifucave.moss");
    expect(moss.productName).toBe("MOSS");
    // One stage: the very engine and tree MOSS Code packs.
    expect(moss.extraResources.map((r: { from: string; to: string }) => [r.from, r.to])).toEqual([["../desktop/out/daemon", "daemon"], ["../desktop/out/plugins", "plugins"]]);
    expect(moss.extraResources[0].filter).toEqual(code.extraResources[0].filter);
    expect(moss.extraResources[1].filter).toEqual(code.extraResources[1].filter);
    expect(moss.afterPack).toBe("scripts/host-helper.mjs");
    expect(moss.asarUnpack).toEqual(["out/main/native/*.node"]);
    expect(moss.electronFuses).toEqual(code.electronFuses);
    for (const k of ["hardenedRuntime", "entitlements", "entitlementsInherit", "signIgnore", "identity", "notarize"]) expect(`${k}: ${JSON.stringify(moss.mac[k])}`).toBe(`${k}: ${JSON.stringify(code.mac[k])}`);
    expect(moss.mac.artifactName).toBe("MOSS-${version}-mac.${ext}");
    expect(moss.dmg.artifactName).toBe("MOSS-${version}.${ext}");
    expect(existsSync(join(ROOT, "apps", "moss", moss.mac.icon.startsWith("build/") ? "" : "build", moss.mac.icon))).toBe(true);
    // The same release feed (one release for everything); MOSS's own files in it carry MOSS's names (two-apps.ts).
    expect(moss.publish).toEqual(code.publish);
  });
});
