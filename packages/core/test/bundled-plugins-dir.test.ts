// The bundled plugins' one rule (#259 check 3): the signed core carries the manifest, and a bundled file counts only
// through readBundledFile's single verified read. bundledPluginsDir finds the candidate folder by layout alone; a
// copied genuine core beside swapped plugins finds a folder and has each swapped or extra file refused. A core with
// no manifest (dev, source) bundles nothing. A server's <home>/plugins is never bundled.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync as mkdtempRaw, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bundledManifest, bundledPluginIds, bundledPluginsDir, EMPTY_BUNDLED_MANIFEST, formatBundledManifest, loadEmbeddedManifest, measureBundledTree,
  parseBundledManifest, readBundledFile, readBundledPlugin, validBundledPath, type BundledManifest,
} from "../src/bundled-plugins-dir";

const HOME = "/srv/clover-home";
/** A temp folder by its real path (macOS's /var is /private/var): bundledPluginsDir answers real paths. */
const mkdtempSync = (prefix: string) => realpathSync(mkdtempRaw(prefix));
/** Symlinks need a privilege on Windows. */
const posixTest = test.skipIf(process.platform === "win32");
const same = (p: string) => p;
const SOME: BundledManifest = { files: { "clover/clover.json": { sha256: "0".repeat(64), size: 2 } } };

/** An installed app's resources: the core and the bundled plugins, with the manifest measured from them. */
function install(): { root: string; core: string; plugins: string; manifest: BundledManifest } {
  const root = mkdtempSync(join(tmpdir(), "lane-m-bundled-install-"));
  const res = join(root, "Clover.app", "Contents", "Resources");
  mkdirSync(join(res, "daemon"), { recursive: true });
  writeFileSync(join(res, "daemon", "clover-core"), "the genuine core");
  const files: Record<string, string> = {
    "clover/clover.json": `{"id":"clover"}`,
    "clover/host.js": "export const ok = true;\n",
    "alpha/clover.json": `{"id":"alpha"}`,
    "alpha/ui/index.js": "export default 1;\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(res, "plugins", rel, ".."), { recursive: true });
    writeFileSync(join(res, "plugins", rel), body);
  }
  const plugins = join(res, "plugins");
  return { root, core: join(res, "daemon", "clover-core"), plugins, manifest: measureBundledTree(plugins) };
}

describe("the candidate folder, by layout", () => {
  test("an app's resources/daemon core has resources/plugins; a server's <home>/bin/daemon core has <home>/bin/plugins", () => {
    expect(bundledPluginsDir("/Applications/Clover.app/Contents/Resources/daemon/clover-core", { realpath: same, manifest: SOME })).toBe(resolve("/Applications/Clover.app/Contents/Resources/plugins"));
    expect(bundledPluginsDir("/opt/Clover/resources/daemon/clover-core", { realpath: same, manifest: SOME })).toBe(resolve("/opt/Clover/resources/plugins"));
    expect(bundledPluginsDir("C:/Program Files/Clover/resources/daemon/clover-core.exe", { realpath: same, manifest: SOME })).toBe(resolve("C:/Program Files/Clover/resources/plugins"));
    expect(bundledPluginsDir(`${HOME}/bin/daemon/clover-core`, { cloverHome: HOME, realpath: same, manifest: SOME })).toBe(resolve(`${HOME}/bin/plugins`));
  });

  test("a core with no manifest (dev, source) bundles nothing; nor does the old layout, a dev checkout or <home>/plugins", () => {
    expect(bundledPluginsDir("/opt/Clover/resources/daemon/clover-core", { realpath: same, manifest: EMPTY_BUNDLED_MANIFEST })).toBeUndefined();
    expect(bundledPluginsDir(`${HOME}/bin/clover-core`, { cloverHome: HOME, realpath: same, manifest: SOME })).toBeUndefined();
    expect(bundledPluginsDir("/src/clover/dist/daemon/darwin-arm64/clover-core", { realpath: same, manifest: SOME })).toBeUndefined();
    expect(bundledPluginsDir(`${HOME}/daemon/clover-core`, { cloverHome: HOME, realpath: same, manifest: SOME })).toBeUndefined();
  });

  posixTest("the binary's real path decides: a symlink named like a core in resources/daemon proves nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-m-bundled-link-"));
    mkdirSync(join(dir, "resources", "daemon"), { recursive: true });
    writeFileSync(join(dir, "real-core"), "");
    symlinkSync(join(dir, "real-core"), join(dir, "resources", "daemon", "clover-core"));
    expect(bundledPluginsDir(join(dir, "resources", "daemon", "clover-core"), { manifest: SOME })).toBeUndefined();
    expect(bundledPluginsDir("/nowhere/resources/daemon/clover-core", { manifest: SOME })).toBeUndefined();
  });

  test("this test process (bun, not a compiled core) carries no manifest", () => {
    expect(bundledManifest().files).toEqual({});
  });
});

describe("a bundled file counts only through its verified bytes", () => {
  test("a genuine install reads: every plugin, every file, the bytes the manifest names", () => {
    const { core, plugins, manifest } = install();
    const dir = bundledPluginsDir(core, { manifest })!;
    expect(dir).toBe(plugins);
    expect(bundledPluginIds(manifest)).toEqual(["alpha", "clover"]);
    const r = readBundledPlugin(dir, "clover", manifest);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new TextDecoder().decode(r.files.get("clover/host.js"))).toBe("export const ok = true;\n");
  });

  test("a copied genuine core beside a swapped plugin file: the folder is found, the swapped file and its plugin refused", () => {
    const genuine = install();
    const copy = mkdtempSync(join(tmpdir(), "lane-m-bundled-copy-"));
    cpSync(join(genuine.root, "Clover.app"), join(copy, "Clover.app"), { recursive: true });
    const core = join(copy, "Clover.app", "Contents", "Resources", "daemon", "clover-core");
    const dir = bundledPluginsDir(core, { manifest: genuine.manifest })!;
    expect(dir).toBe(join(copy, "Clover.app", "Contents", "Resources", "plugins"));
    // Same size, other bytes.
    writeFileSync(join(dir, "clover", "host.js"), "export const ok = fals;\n");
    const file = readBundledFile(dir, "clover/host.js", genuine.manifest);
    expect(file).toEqual({ ok: false, refusal: "clover/host.js: its contents aren't the manifest's (SHA-256 differs)" });
    const plugin = readBundledPlugin(dir, "clover", genuine.manifest);
    expect(plugin.ok).toBe(false);
    // The untouched plugin still reads.
    expect(readBundledPlugin(dir, "alpha", genuine.manifest).ok).toBe(true);
  });

  posixTest("a size mismatch, a hash mismatch, a symlink and a missing file are each refused", () => {
    const { plugins, manifest } = install();
    writeFileSync(join(plugins, "alpha", "ui", "index.js"), "export default 12;\n");
    expect(readBundledFile(plugins, "alpha/ui/index.js", manifest)).toEqual({ ok: false, refusal: "alpha/ui/index.js: 19 bytes, not the manifest's 18" });
    writeFileSync(join(plugins, "alpha", "clover.json"), `{"id":"alphA"}`);
    expect(readBundledFile(plugins, "alpha/clover.json", manifest).ok).toBe(false);
    const outside = join(plugins, "..", "outside.js");
    writeFileSync(outside, "export const ok = true;\n");
    rmSync(join(plugins, "clover", "host.js"));
    symlinkSync(outside, join(plugins, "clover", "host.js"));
    const linked = readBundledFile(plugins, "clover/host.js", manifest);
    expect(linked.ok).toBe(false);
    rmSync(join(plugins, "clover", "host.js"));
    expect(readBundledFile(plugins, "clover/host.js", manifest)).toEqual({ ok: false, refusal: "clover/host.js: can't be opened (ENOENT)" });
  });

  test("an extra file is refused: by name, and the plugin whose folder holds it", () => {
    const { plugins, manifest } = install();
    writeFileSync(join(plugins, "clover", "extra.js"), "globalThis.evil = 1;\n");
    expect(readBundledFile(plugins, "clover/extra.js", manifest)).toEqual({ ok: false, refusal: "clover/extra.js: not in the bundled-plugins manifest this core was built with" });
    const r = readBundledPlugin(plugins, "clover", manifest);
    expect(r).toEqual({ ok: false, refusal: "clover: its folder holds what the manifest doesn't name: clover/extra.js" });
    // A plugin the manifest doesn't name at all.
    mkdirSync(join(plugins, "evil"));
    writeFileSync(join(plugins, "evil", "clover.json"), "{}");
    expect(readBundledPlugin(plugins, "evil", manifest).ok).toBe(false);
  });

  test("the bytes returned are the ones checked: a swap after the read changes nothing already read", () => {
    const { plugins, manifest } = install();
    const r = readBundledFile(plugins, "clover/host.js", manifest);
    writeFileSync(join(plugins, "clover", "host.js"), "export const ok = fals;\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(new TextDecoder().decode(r.bytes)).toBe("export const ok = true;\n");
  });

  test("paths outside the tree are refused before anything is opened", () => {
    const { plugins, manifest } = install();
    for (const rel of ["../outside.js", "clover/../alpha/clover.json", "/etc/passwd", "clover\\host.js", "C:/x", "", "clover//host.js"]) {
      expect(validBundledPath(rel)).toBe(false);
      expect(readBundledFile(plugins, rel, manifest).ok).toBe(false);
    }
    expect(readBundledPlugin(plugins, "../x", manifest).ok).toBe(false);
  });
});

describe("the manifest's text", () => {
  test("round-trips, sorted; a malformed one is refused", () => {
    const { manifest } = install();
    const text = formatBundledManifest(manifest);
    expect(parseBundledManifest(text)).toEqual(manifest);
    expect(Object.keys(JSON.parse(text).files)).toEqual(Object.keys(manifest.files).sort());
    expect(() => parseBundledManifest(`{"format":2,"files":{}}`)).toThrow("format 1");
    expect(() => parseBundledManifest(`{"format":1,"files":{"../x":{"sha256":"${"0".repeat(64)}","size":1}}}`)).toThrow("plain relative path");
    expect(() => parseBundledManifest(`{"format":1,"files":{"x/y":{"sha256":"ABC","size":1}}}`)).toThrow("{sha256, size}");
    expect(() => parseBundledManifest(`{"format":1,"files":{"x/y":{"sha256":"${"0".repeat(64)}","size":-1}}}`)).toThrow("{sha256, size}");
  });

  test("the embedded file: none is the empty manifest, one is read, two are refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-m-bundled-embed-"));
    const text = formatBundledManifest(SOME);
    writeFileSync(join(dir, "clover-bundled-plugins-abc123.manifest"), text);
    expect(loadEmbeddedManifest([], dir).manifest).toEqual(EMPTY_BUNDLED_MANIFEST);
    expect(loadEmbeddedManifest(["other.txt"], dir).manifest).toEqual(EMPTY_BUNDLED_MANIFEST);
    const one = loadEmbeddedManifest(["clover-bundled-plugins-abc123.manifest"], dir);
    expect(one.manifest).toEqual(parseBundledManifest(text));
    expect(one.text).toBe(readFileSync(join(dir, "clover-bundled-plugins-abc123.manifest"), "utf8"));
    expect(() => loadEmbeddedManifest(["clover-bundled-plugins-a.manifest", "clover-bundled-plugins-b.manifest"], dir)).toThrow("2 bundled-plugins manifests");
  });

  posixTest("measuring refuses a symlink in the tree", () => {
    const { plugins } = install();
    symlinkSync("/etc", join(plugins, "alpha", "etc"));
    expect(() => measureBundledTree(plugins)).toThrow("is a symlink");
  });
});
