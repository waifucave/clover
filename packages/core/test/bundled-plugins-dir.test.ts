// The bundled plugins folder is returned only when it can be trusted (whatever it returns is approved without a
// card): an installed layout, by the binary's real path, and on macOS a Clover.app that passes the signature check,
// on Linux a root-owned read-only tree or a read-only mount, on a server a feed-verified folder. A server's
// <home>/plugins is never bundled.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundledPluginsDir, CLOVER_APP_REQUIREMENT, linuxFolderTrusted, onReadOnlyMount, verifyMacAppSignature } from "../src/bundled-plugins-dir";
import { darwinTest } from "./helpers/darwin-only";

const HOME = "/srv/clover-home";
const same = (p: string) => p;
const APP = "/Applications/Clover.app";
const MAC_CORE = `${APP}/Contents/Resources/daemon/clover-core`;

test("macOS: a signed Clover.app's core has its resources/plugins; the requirement names Clover's identifier and team", () => {
  const checked: string[] = [];
  expect(bundledPluginsDir(MAC_CORE, { platform: "darwin", realpath: same, verifyMacApp: (a) => { checked.push(a); return true; } })).toBe(resolve(`${APP}/Contents/Resources/plugins`));
  expect(checked).toEqual([resolve(APP)]);
  expect(CLOVER_APP_REQUIREMENT).toBe('identifier "com.waifucave.clover" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ"');
});

test("macOS: an app that fails the signature check, or a copied core in a foreign resources/, gets none", () => {
  const lines: string[] = [];
  expect(bundledPluginsDir(MAC_CORE, { platform: "darwin", realpath: same, verifyMacApp: () => false, log: (l) => lines.push(l) })).toBeUndefined();
  expect(lines[0]).toContain("code-signature check");
  // A same-user copy of the signed core, beside plugins of its own: no .app to verify, or one that fails.
  expect(bundledPluginsDir("/tmp/evil/resources/daemon/clover-core", { platform: "darwin", realpath: same, verifyMacApp: () => true })).toBeUndefined();
  expect(bundledPluginsDir("/tmp/evil/Fake.app/Contents/Resources/daemon/clover-core", { platform: "darwin", realpath: same, verifyMacApp: () => false })).toBeUndefined();
});

test("the binary's real path decides: a symlinked core path is judged where it really lives", () => {
  const dir = mkdtempSync(join(tmpdir(), "lane-m-bpd-"));
  const real = join(dir, "elsewhere", "clover-core");
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(real, "");
  const app = join(dir, "Clover.app", "Contents", "Resources", "daemon");
  mkdirSync(app, { recursive: true });
  symlinkSync(real, join(app, "clover-core"));
  // Its name says Clover.app, its real path doesn't: none, and the app is never even checked.
  expect(bundledPluginsDir(join(app, "clover-core"), { platform: "darwin", verifyMacApp: () => { throw new Error("checked"); } })).toBeUndefined();
  // A path that doesn't exist: none.
  expect(bundledPluginsDir(join(dir, "missing", "daemon", "clover-core"), { platform: "darwin" })).toBeUndefined();
});

test.if(process.platform !== "win32")("Linux: the packages' root-owned read-only tree, or a read-only mount; a user-owned resources/ gets none", () => {
  expect(bundledPluginsDir("/opt/Clover/resources/daemon/clover-core", { platform: "linux", realpath: same, linuxTrusted: () => true })).toBe(resolve("/opt/Clover/resources/plugins"));
  expect(bundledPluginsDir("/home/me/evil/resources/daemon/clover-core", { platform: "linux", realpath: same, linuxTrusted: () => false })).toBeUndefined();
  const tree: Record<string, { uid: number; mode: number; isDir: boolean; isLink: boolean }> = {
    "/": { uid: 0, mode: 0o40755, isDir: true, isLink: false },
    "/opt": { uid: 0, mode: 0o40755, isDir: true, isLink: false },
    "/opt/Clover": { uid: 0, mode: 0o40755, isDir: true, isLink: false },
    "/opt/Clover/resources": { uid: 0, mode: 0o40755, isDir: true, isLink: false },
    "/opt/Clover/resources/plugins": { uid: 0, mode: 0o40755, isDir: true, isLink: false },
  };
  const stat = (t: typeof tree) => (p: string) => { const s = t[p]; if (!s) throw new Error("ENOENT"); return s; };
  const noMounts = () => "";
  expect(linuxFolderTrusted("/opt/Clover/resources/plugins", stat(tree), noMounts)).toBe(true);
  expect(linuxFolderTrusted("/opt/Clover/resources/plugins", stat({ ...tree, "/opt/Clover": { ...tree["/opt/Clover"]!, uid: 1000 } }), noMounts)).toBe(false);
  expect(linuxFolderTrusted("/opt/Clover/resources/plugins", stat({ ...tree, "/opt/Clover/resources": { ...tree["/opt/Clover/resources"]!, mode: 0o40775 } }), noMounts)).toBe(false);
  expect(linuxFolderTrusted("/opt/Clover/resources/plugins", stat({ ...tree, "/opt/Clover/resources/plugins": { ...tree["/opt/Clover/resources/plugins"]!, isLink: true } }), noMounts)).toBe(false);
  // An AppImage: user-owned, but on its read-only mount.
  const mi = "22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n81 22 0:50 / /tmp/.mount_CloverX ro,nosuid,nodev,relatime shared:40 - fuse.Clover.AppImage Clover.AppImage ro\n";
  expect(onReadOnlyMount("/tmp/.mount_CloverX/resources/plugins", () => mi)).toBe(true);
  expect(onReadOnlyMount("/home/me/resources/plugins", () => mi)).toBe(false);
  expect(linuxFolderTrusted("/tmp/.mount_CloverX/resources/plugins", () => { throw new Error("not root's"); }, () => mi)).toBe(true);
});

test("Windows: as laid out", () => {
  expect(bundledPluginsDir("C:/Users/me/AppData/Local/Programs/Clover/resources/daemon/clover-core.exe", { platform: "win32", realpath: same }))
    .toBe(join(resolve("C:/Users/me/AppData/Local/Programs/Clover/resources"), "plugins"));
});

test("a server: <home>/bin/plugins only when the signed feed vouches for each file; a tampered file gets none and an error", () => {
  const server = join(HOME, "bin", "daemon", "clover-core");
  expect(bundledPluginsDir(server, { cloverHome: HOME, platform: "linux", realpath: same, verifyServerPlugins: () => true })).toBe(resolve(HOME, "bin", "plugins"));
  const lines: string[] = [];
  expect(bundledPluginsDir(server, { cloverHome: HOME, platform: "linux", realpath: same, verifyServerPlugins: () => false, log: (l) => lines.push(l) })).toBeUndefined();
  expect(lines[0]).toContain("signed release's plugins manifest");
  // No verifier (before #244): never.
  expect(bundledPluginsDir(server, { cloverHome: HOME, platform: "darwin", realpath: same })).toBeUndefined();
});

test("a server's <home>/plugins is never bundled, whatever the layout; anything else has none", () => {
  const ok = { cloverHome: HOME, realpath: same, verifyServerPlugins: () => true, verifyMacApp: () => true, linuxTrusted: () => true };
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const exec of [join(HOME, "bin", "clover-core"), join(HOME, "daemon", "clover-core"), join(HOME, "bin", "daemon", "clover-core")]) {
      expect(bundledPluginsDir(exec, { ...ok, platform })).not.toBe(resolve(HOME, "plugins"));
    }
    expect(bundledPluginsDir(join(HOME, "bin", "clover-core"), { ...ok, platform })).toBeUndefined();
    expect(bundledPluginsDir(join(HOME, "daemon", "clover-core"), { ...ok, platform })).toBeUndefined();
    expect(bundledPluginsDir("/Users/me/clover/dist/daemon/darwin-arm64/clover-core", { ...ok, platform })).toBeUndefined();
    expect(bundledPluginsDir("/opt/homebrew/bin/bun", { ...ok, platform })).toBeUndefined();
  }
});

darwinTest("the real signature check refuses an unsigned app", () => {
  const app = join(mkdtempSync(join(tmpdir(), "lane-m-bpd-app-")), "Clover.app");
  mkdirSync(join(app, "Contents", "Resources", "plugins"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), "<plist/>");
  expect(verifyMacAppSignature(app)).toBe(false);
});
