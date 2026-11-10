// The bundled plugins the registry loads: a private copy of verified bytes (#259's rule), and the dev stage built from
// the repository's plugins/. The last test is the milestone's check on this computer: every bundled plugin with Bun host
// code starts through the plugin host. Temp homes, the fake approval broker, an in-memory secret store; no window.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { measureBundledTree } from "../../bundled-plugins-dir";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { startPluginHost } from "../../plugin-host/daemon-host";
import { buildDevBundledPlugins, devBundledSource, stageBundledPlugins, stagedBundledDir } from "../bundled-stage";
import { openPluginRegistry } from "../open";

const REPO_PLUGINS = join(import.meta.dir, "..", "..", "..", "..", "..", "plugins");

describe("stageBundledPlugins", () => {
  test("copies each plugin whose files all verify; one with a changed or extra file is left out whole", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-stage-"));
    const root = join(home, "resources", "plugins");
    for (const id of ["good", "edited", "extra"]) {
      mkdirSync(join(root, id, "data"), { recursive: true });
      writeFileSync(join(root, id, "clover.json"), JSON.stringify({ id }));
      writeFileSync(join(root, id, "data", "a.txt"), `${id}'s data`);
    }
    const manifest = measureBundledTree(root);
    writeFileSync(join(root, "edited", "data", "a.txt"), "swapped after the build");
    writeFileSync(join(root, "extra", "planted.js"), "x");
    const out = stagedBundledDir(home);
    const r = stageBundledPlugins({ root, manifest, out });
    expect([r.dir, r.staged]).toEqual([out, ["good"]]);
    expect(r.refused.length).toBe(2);
    expect(readFileSync(join(out, "good", "data", "a.txt"), "utf8")).toBe("good's data");
    expect(existsSync(join(out, "edited"))).toBe(false);
    expect(existsSync(join(out, "extra"))).toBe(false);
    // Staged again from a clean tree: the copy is replaced whole.
    expect(stageBundledPlugins({ root, manifest: { files: {} }, out }).dir).toBeUndefined();
    expect(existsSync(out)).toBe(false);
  });
});

describe("a bundled plugin runs only verified bytes", () => {
  test("every module of its tree is checked at load: a lib rewritten, or a file planted, after staging is refused, and its code never runs (#322's review, S2)", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-verified-"));
    const root = join(home, "resources", "plugins");
    const tree = join(root, "ledger");
    mkdirSync(join(tree, "host"), { recursive: true });
    writeFileSync(join(tree, "clover.json"), JSON.stringify({ manifest: 1, id: "ledger", name: "Ledger", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }));
    writeFileSync(join(tree, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(tree, "host", "index.js"), `export const total = async () => (await import("./lib.js")).total();\nexport const extra = async () => (await import("./extra.js")).x;\n`);
    writeFileSync(join(tree, "host", "lib.js"), "export const total = () => 42;\n");
    const staged = stageBundledPlugins({ root, manifest: measureBundledTree(root), out: stagedBundledDir(home) });
    expect(staged.staged).toEqual(["ledger"]);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    mkdirSync(join(home, "plugins"), { recursive: true });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests });
    const mark = join(home, "tampered-ran");
    const USER = { kind: "user", client: "app" } as const;
    try {
      expect(await ph.host.invoke({ pluginId: "ledger", handler: "total", args: null, caller: USER })).toBe(42);
      // A file planted in the verified copy after staging has no digest: refused.
      writeFileSync(join(stagedBundledDir(home), "ledger", "host", "extra.js"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\nexport const x = 1;\n`);
      const planted = await ph.host.invoke({ pluginId: "ledger", handler: "extra", args: null, caller: USER }).then(() => "ran", (e: Error) => e.message);
      expect(planted).toContain("no verified copy recorded");
      // A lib rewritten after staging: refused at its load, after a restart.
      await ph.host.stop("ledger", "test");
      writeFileSync(join(stagedBundledDir(home), "ledger", "host", "lib.js"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\nexport const total = () => 0;\n`);
      await Promise.race([ph.host.restart("ledger").catch(() => {}), Bun.sleep(10_000)]);
      const rewritten = await ph.host.invoke({ pluginId: "ledger", handler: "total", args: null, caller: USER }).then(() => "ran", (e: Error) => e.message);
      expect(rewritten).toContain("isn't the bundled code Clover verified");
      expect(existsSync(mark)).toBe(false);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);
});

describe("the dev stage from the repository's plugins/", () => {
  test("every bundled plugin loads, and each one with Bun host code starts through the plugin host", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-devstage-"));
    const built = await buildDevBundledPlugins({ sources: REPO_PLUGINS, ids: ["alpha", "clover"], cloverHome: home });
    expect(built.built).toEqual(["alpha", "clover"]);
    const source = devBundledSource(home)!;
    const staged = stageBundledPlugins({ ...source, out: stagedBundledDir(home) });
    expect([staged.staged, staged.refused]).toEqual([["alpha", "clover"], []]);

    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    mkdirSync(join(home, "plugins"), { recursive: true });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests });
    try {
      const all = opened.registry.list();
      // Bundled plugins need no OK: none is waiting on a card, refused or invalid.
      const notLoaded = all.filter((p) => !["running", "waiting"].includes(p.state)).map((p) => `${p.id}: ${p.state}${p.reason ? ` (${p.reason})` : ""}`);
      expect(notLoaded).toEqual([]);
      const hosted = all.filter((p) => p.manifest?.host !== undefined && (p.manifest.host.runtime ?? "bun") === "bun");
      expect(hosted.length).toBeGreaterThan(10);
      const failed: string[] = [];
      for (const p of hosted) {
        try {
          await ph.host.ensureStarted(p.id);
        } catch (err) {
          failed.push(`${p.id}: ${(err as Error).message}`);
        }
      }
      // The one known gap: the web companion's host code calls API it asked lanes B and H for in I-M2 (the device
      // registry, `adoptLink` and its `pairs` store, plugins/clover/plugins/companion-web/host/api.ts), which isn't in the
      // plugin API yet. Anything else that fails to start fails this test; fixing that one updates it.
      expect(failed.map((f) => f.split(":")[0])).toEqual(["clover/companion-web"]);
      expect(failed[0]).toContain("pairs.list isn't a call of the plugin API");

      // #322's review, S2: a bundled entry rewritten after staging (run/bundled-plugins/clover/...) is refused at load,
      // and its new code never runs.
      const target = hosted.find((p) => p.id.startsWith("clover/") && p.id !== "clover/companion-web")!;
      await ph.host.stop(target.id, "test");
      const entry = join(target.folder, target.manifest!.host!.entry);
      const mark = join(home, "tampered-ran");
      writeFileSync(entry, `${readFileSync(entry, "utf8")}\nrequire("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\n`);
      const refused = await Promise.race([ph.host.restart(target.id).then(() => "started", (err: unknown) => (err as Error).message), Bun.sleep(20_000).then(() => "timed out")]);
      expect(`${refused} / ${ph.host.status(target.id).reason ?? ""}`).toContain("isn't the bundled code Clover verified");
      expect(existsSync(mark)).toBe(false);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 180_000);

  test("a bundled plugin with no verified digest recorded doesn't run", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-devstage-"));
    await buildDevBundledPlugins({ sources: REPO_PLUGINS, ids: ["clover"], cloverHome: home });
    const staged = stageBundledPlugins({ ...devBundledSource(home)!, out: stagedBundledDir(home) });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    mkdirSync(join(home, "plugins"), { recursive: true });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
    try {
      const hosted = opened.registry.list().find((p) => p.manifest?.host !== undefined && (p.manifest.host.runtime ?? "bun") === "bun" && p.id !== "clover/companion-web")!;
      const refused = await Promise.race([ph.host.ensureStarted(hosted.id).then(() => "started", (err: unknown) => (err as Error).message), Bun.sleep(20_000).then(() => "timed out")]);
      expect(`${refused} / ${ph.host.status(hosted.id).reason ?? ""}`).toContain("no verified copy recorded");
    } finally {
      await ph.close();
      opened.close();
    }
  }, 180_000);
});
