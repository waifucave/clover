// The bundled plugins the registry loads: a private copy of verified bytes (#259's rule), and the dev stage built from
// the repository's plugins/. The last test is the milestone's check on this computer: every bundled plugin with Bun host
// code starts through the plugin host. Temp homes, the fake approval broker, an in-memory secret store; no window.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
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
    } finally {
      await ph.close();
      opened.close();
    }
  }, 180_000);
});
