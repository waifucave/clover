// The bundled plugins' one rule (#259 check 3): the signed core carries the manifest, and a bundled file counts only
// through readBundledFile's single verified read. bundledPluginsDir finds the candidate folder by layout alone; a
// copied genuine core beside swapped plugins finds a folder and has each swapped or extra file refused. A core with
// no manifest (dev, source) bundles nothing. A server's <home>/plugins is never bundled.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync as mkdtempRaw, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bundledManifest, bundledPluginIds, bundledPluginsDir, EMPTY_BUNDLED_MANIFEST, formatBundledManifest, loadBundledManifest, loadEmbeddedManifest, measureBundledTree, nonPortablePath,
  parseBundledManifest, readBundledFile, readBundledPlugin, validBundledPath, type BundledManifest,
} from "../src/bundled-plugins-dir";

const HOME = "/srv/moss-home";
/** A temp folder by its real path (macOS's /var is /private/var): bundledPluginsDir answers real paths. */
const mkdtempSync = (prefix: string) => realpathSync(mkdtempRaw(prefix));
/** Symlinks need a privilege on Windows. */
const posixTest = test.skipIf(process.platform === "win32");
const same = (p: string) => p;
const SOME: BundledManifest = { files: { "moss/moss.json": { sha256: "0".repeat(64), size: 2 } } };

/** An installed app's resources: the core and the bundled plugins, with the manifest measured from them. */
function install(): { root: string; core: string; plugins: string; manifest: BundledManifest } {
  const root = mkdtempSync(join(tmpdir(), "lane-m-bundled-install-"));
  const res = join(root, "MOSS Code.app", "Contents", "Resources");
  mkdirSync(join(res, "daemon"), { recursive: true });
  writeFileSync(join(res, "daemon", "moss-core"), "the genuine core");
  const files: Record<string, string> = {
    "moss/moss.json": `{"id":"moss"}`,
    "moss/host.js": "export const ok = true;\n",
    "alpha/moss.json": `{"id":"alpha"}`,
    "alpha/ui/index.js": "export default 1;\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(res, "plugins", rel, ".."), { recursive: true });
    writeFileSync(join(res, "plugins", rel), body);
  }
  const plugins = join(res, "plugins");
  return { root, core: join(res, "daemon", "moss-core"), plugins, manifest: measureBundledTree(plugins) };
}

describe("the candidate folder, by layout", () => {
  test("an app's resources/daemon core has resources/plugins; a server's <home>/bin/daemon core has <home>/bin/plugins", () => {
    expect(bundledPluginsDir("/Applications/MOSS Code.app/Contents/Resources/daemon/moss-core", { realpath: same, manifest: SOME })).toBe(resolve("/Applications/MOSS Code.app/Contents/Resources/plugins"));
    expect(bundledPluginsDir("/opt/moss-code/resources/daemon/moss-core", { realpath: same, manifest: SOME })).toBe(resolve("/opt/moss-code/resources/plugins"));
    expect(bundledPluginsDir("C:/Program Files/MOSS Code/resources/daemon/moss-core.exe", { realpath: same, manifest: SOME })).toBe(resolve("C:/Program Files/MOSS Code/resources/plugins"));
    expect(bundledPluginsDir(`${HOME}/bin/daemon/moss-core`, { mossHome: HOME, realpath: same, manifest: SOME })).toBe(resolve(`${HOME}/bin/plugins`));
  });

  test("a core with no manifest (dev, source) bundles nothing; nor does the old layout, a dev checkout or <home>/plugins", () => {
    expect(bundledPluginsDir("/opt/moss-code/resources/daemon/moss-core", { realpath: same, manifest: EMPTY_BUNDLED_MANIFEST })).toBeUndefined();
    expect(bundledPluginsDir(`${HOME}/bin/moss-core`, { mossHome: HOME, realpath: same, manifest: SOME })).toBeUndefined();
    expect(bundledPluginsDir("/src/moss/dist/daemon/darwin-arm64/moss-core", { realpath: same, manifest: SOME })).toBeUndefined();
    expect(bundledPluginsDir(`${HOME}/daemon/moss-core`, { mossHome: HOME, realpath: same, manifest: SOME })).toBeUndefined();
  });

  posixTest("the binary's real path decides: a symlink named like a core in resources/daemon proves nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-m-bundled-link-"));
    mkdirSync(join(dir, "resources", "daemon"), { recursive: true });
    writeFileSync(join(dir, "real-core"), "");
    symlinkSync(join(dir, "real-core"), join(dir, "resources", "daemon", "moss-core"));
    expect(bundledPluginsDir(join(dir, "resources", "daemon", "moss-core"), { manifest: SOME })).toBeUndefined();
    expect(bundledPluginsDir("/nowhere/resources/daemon/moss-core", { manifest: SOME })).toBeUndefined();
  });

  posixTest("a home reached through a link (macOS's /var → /private/var): the engine in <home>/bin/daemon still finds <home>/bin/plugins, and <home>/plugins is still never the bundled one", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ei-bundled-home-")));
    mkdirSync(join(dir, "real", "bin", "daemon"), { recursive: true });
    writeFileSync(join(dir, "real", "bin", "daemon", "moss-core"), "");
    symlinkSync(join(dir, "real"), join(dir, "named"));
    // Started through the link (the home as named), its real path is under the real folder.
    expect(bundledPluginsDir(join(dir, "named", "bin", "daemon", "moss-core"), { mossHome: join(dir, "named"), manifest: SOME })).toBe(join(dir, "real", "bin", "plugins"));
    // Started by the real path with the home named through the link.
    expect(bundledPluginsDir(join(dir, "real", "bin", "daemon", "moss-core"), { mossHome: join(dir, "named"), manifest: SOME })).toBe(join(dir, "real", "bin", "plugins"));
    // Another home's engine under this home's name proves nothing.
    mkdirSync(join(dir, "other", "bin", "daemon"), { recursive: true });
    writeFileSync(join(dir, "other", "bin", "daemon", "moss-core"), "");
    expect(bundledPluginsDir(join(dir, "other", "bin", "daemon", "moss-core"), { mossHome: join(dir, "named"), manifest: SOME })).toBeUndefined();
    // The user's own plugins folder is never the bundled one, whichever way the home is named.
    mkdirSync(join(dir, "real", "daemon"), { recursive: true });
    writeFileSync(join(dir, "real", "daemon", "moss-core"), "");
    expect(bundledPluginsDir(join(dir, "named", "daemon", "moss-core"), { mossHome: join(dir, "named"), manifest: SOME })).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("this test process (bun, not a compiled core) carries no manifest, loaded or not", async () => {
    expect(bundledManifest().files).toEqual({});
    expect((await loadBundledManifest()).manifest.files).toEqual({});
    expect(bundledManifest().files).toEqual({});
  });
});

describe("a bundled file counts only through its verified bytes", () => {
  test("a genuine install reads: every plugin, every file, the bytes the manifest names", () => {
    const { core, plugins, manifest } = install();
    const dir = bundledPluginsDir(core, { manifest })!;
    expect(dir).toBe(plugins);
    expect(bundledPluginIds(manifest)).toEqual(["alpha", "moss"]);
    const r = readBundledPlugin(dir, "moss", manifest);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new TextDecoder().decode(r.files.get("moss/host.js"))).toBe("export const ok = true;\n");
  });

  test("a copied genuine core beside a swapped plugin file: the folder is found, the swapped file and its plugin refused", () => {
    const genuine = install();
    const copy = mkdtempSync(join(tmpdir(), "lane-m-bundled-copy-"));
    cpSync(join(genuine.root, "MOSS Code.app"), join(copy, "MOSS Code.app"), { recursive: true });
    const core = join(copy, "MOSS Code.app", "Contents", "Resources", "daemon", "moss-core");
    const dir = bundledPluginsDir(core, { manifest: genuine.manifest })!;
    expect(dir).toBe(join(copy, "MOSS Code.app", "Contents", "Resources", "plugins"));
    // Same size, other bytes.
    writeFileSync(join(dir, "moss", "host.js"), "export const ok = fals;\n");
    const file = readBundledFile(dir, "moss/host.js", genuine.manifest);
    expect(file).toEqual({ ok: false, refusal: "moss/host.js: its contents aren't the manifest's (SHA-256 differs)" });
    const plugin = readBundledPlugin(dir, "moss", genuine.manifest);
    expect(plugin.ok).toBe(false);
    // The untouched plugin still reads.
    expect(readBundledPlugin(dir, "alpha", genuine.manifest).ok).toBe(true);
  });

  posixTest("a FIFO named in the manifest is refused at once, never read (a blocking read would hang the daemon)", () => {
    const { plugins, manifest } = install();
    rmSync(join(plugins, "moss", "host.js"));
    const made = Bun.spawnSync(["mkfifo", join(plugins, "moss", "host.js")]);
    expect(made.exitCode).toBe(0);
    const started = performance.now();
    expect(readBundledFile(plugins, "moss/host.js", manifest)).toEqual({ ok: false, refusal: "moss/host.js: not a regular file" });
    expect(readBundledPlugin(plugins, "moss", manifest).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  posixTest("a size mismatch, a hash mismatch, a symlink and a missing file are each refused", () => {
    const { plugins, manifest } = install();
    writeFileSync(join(plugins, "alpha", "ui", "index.js"), "export default 12;\n");
    expect(readBundledFile(plugins, "alpha/ui/index.js", manifest)).toEqual({ ok: false, refusal: "alpha/ui/index.js: 19 bytes, not the manifest's 18" });
    writeFileSync(join(plugins, "alpha", "moss.json"), `{"id":"alphA"}`);
    expect(readBundledFile(plugins, "alpha/moss.json", manifest).ok).toBe(false);
    const outside = join(plugins, "..", "outside.js");
    writeFileSync(outside, "export const ok = true;\n");
    rmSync(join(plugins, "moss", "host.js"));
    symlinkSync(outside, join(plugins, "moss", "host.js"));
    const linked = readBundledFile(plugins, "moss/host.js", manifest);
    expect(linked.ok).toBe(false);
    rmSync(join(plugins, "moss", "host.js"));
    expect(readBundledFile(plugins, "moss/host.js", manifest)).toEqual({ ok: false, refusal: "moss/host.js: can't be opened (ENOENT)" });
    // A symlink is refused before it is opened.
    expect(linked).toEqual({ ok: false, refusal: "moss/host.js: not a regular file" });
  });

  test("an extra file is refused: by name, and the plugin whose folder holds it", () => {
    const { plugins, manifest } = install();
    writeFileSync(join(plugins, "moss", "extra.js"), "globalThis.evil = 1;\n");
    expect(readBundledFile(plugins, "moss/extra.js", manifest)).toEqual({ ok: false, refusal: "moss/extra.js: not in the bundled-plugins manifest this core was built with" });
    const r = readBundledPlugin(plugins, "moss", manifest);
    expect(r).toEqual({ ok: false, refusal: "moss: its folder holds what the manifest doesn't name: moss/extra.js" });
    // A plugin the manifest doesn't name at all.
    mkdirSync(join(plugins, "evil"));
    writeFileSync(join(plugins, "evil", "moss.json"), "{}");
    expect(readBundledPlugin(plugins, "evil", manifest).ok).toBe(false);
  });

  test("the bytes returned are the ones checked: a swap after the read changes nothing already read", () => {
    const { plugins, manifest } = install();
    const r = readBundledFile(plugins, "moss/host.js", manifest);
    writeFileSync(join(plugins, "moss", "host.js"), "export const ok = fals;\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(new TextDecoder().decode(r.bytes)).toBe("export const ok = true;\n");
  });

  test("paths outside the tree are refused before anything is opened", () => {
    const { plugins, manifest } = install();
    for (const rel of ["../outside.js", "moss/../alpha/moss.json", "/etc/passwd", "moss\\host.js", "C:/x", "", "moss//host.js"]) {
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

  test("the embedded file, read from its Blob: none is the empty manifest, one is read, two or a bad one are refused", async () => {
    const text = formatBundledManifest(SOME);
    const file = (name: string, body: string) => ({ name, bytes: async () => new TextEncoder().encode(body) });
    expect((await loadEmbeddedManifest([])).manifest).toEqual(EMPTY_BUNDLED_MANIFEST);
    expect((await loadEmbeddedManifest([file("other.txt", "x")])).manifest).toEqual(EMPTY_BUNDLED_MANIFEST);
    const one = await loadEmbeddedManifest([file("moss-bundled-plugins-abc123.manifest", text), file("other.txt", "x")]);
    expect(one.manifest).toEqual(parseBundledManifest(text));
    expect(one.text).toBe(text);
    await expect(loadEmbeddedManifest([file("moss-bundled-plugins-a.manifest", text), file("moss-bundled-plugins-b.manifest", text)])).rejects.toThrow("2 bundled-plugins manifests");
    await expect(loadEmbeddedManifest([file("moss-bundled-plugins-a.manifest", "{")])).rejects.toThrow();
  });

  test("a path that can't ship to every OS (a Windows device name, a trailing dot or space) is refused when measured", () => {
    for (const rel of ["a/CON", "a/nul.txt", "a/Com1.js", "a/lpt9", "a/com\u00b9", "aux/x.js", "a/x.", "a/x "]) expect(nonPortablePath(rel)).toBeDefined();
    for (const rel of ["a/console.js", "a/null.js", "a/com10", "a/x.js", "a/.env.example"]) expect(nonPortablePath(rel)).toBeUndefined();
    const { plugins } = install();
    writeFileSync(join(plugins, "alpha", "nul.json"), "{}");
    expect(() => measureBundledTree(plugins)).toThrow("Windows device name");
  });

  posixTest("measuring refuses a symlink in the tree", () => {
    const { plugins } = install();
    symlinkSync("/etc", join(plugins, "alpha", "etc"));
    expect(() => measureBundledTree(plugins)).toThrow("is a symlink");
  });
});
