// The bundled plugins the registry loads: a private copy of verified bytes (#259's rule), and the dev stage built from
// the repository's plugins/. The last test is the milestone's check on this computer: every bundled plugin with Bun host
// code starts through the plugin host. Temp homes, the fake approval broker, an in-memory secret store; no window.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_AVAILABLE_YET, PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { measureBundledTree } from "../../bundled-plugins-dir";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { startPluginHost } from "../../plugin-host/daemon-host";
import { uiPluginViews } from "../../plugin-host/ui";
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
      // Bundled plugins need no OK: none is waiting on a card, refused or invalid. One its manifest has off by default
      // (`enabledByDefault: false`, Alpha's extras) is off until the user turns it on.
      // Clover's plugins this build can't run yet (`availability: not-yet`, the owner's PARKED list) are listed and off.
      const notYet = (p: { manifest?: unknown }) => (p.manifest as { availability?: { status?: string } } | undefined)?.availability?.status === "not-yet";
      expect(all.filter(notYet).map((p) => `${p.id}: ${p.state} (${p.reason ?? ""})`)).toEqual(
        ["clover/browser", "clover/companion-web", "clover/forwarder", "clover/push", "clover/relay-cloudflare"].map((id) => `${id}: off (${NOT_AVAILABLE_YET})`),
      );
      // None of them offers a server to any session (the bots' tool lists and their instructions come from these).
      expect(opened.registry.entries("mcpServers").filter((e) => all.some((p) => p.id === e.pluginId && notYet(p)))).toEqual([]);
      const notLoaded = all.filter((p) => !["running", "waiting"].includes(p.state) && !(p.state === "off" && p.manifest?.enabledByDefault === false) && !notYet(p))
        .map((p) => `${p.id}: ${p.state}${p.reason ? ` (${p.reason})` : ""}`);
      expect(all.find((p) => p.id === "alpha/extras")?.state).toBe("off");
      expect(notLoaded).toEqual([]);
      // Not one of them starts.
      for (const p of all.filter(notYet)) {
        expect([p.id, await ph.host.ensureStarted(p.id).then(() => "started", () => "not started")]).toEqual([p.id, "not started"]);
      }
      const hosted = all.filter((p) => p.manifest?.host !== undefined && (p.manifest.host.runtime ?? "bun") === "bun" && !notYet(p));
      expect(hosted.length).toBeGreaterThan(10);
      const failed: string[] = [];
      for (const p of hosted) {
        try {
          await ph.host.ensureStarted(p.id);
        } catch (err) {
          failed.push(`${p.id}: ${(err as Error).message}`);
        }
      }
      // Every other bundled host starts (the web companion, whose host code calls API the plugin API doesn't have yet,
      // is one of the not-yet four above).
      expect(failed).toEqual([]);

      // What the app mounts from (plugin.ui): every clover child with UI in the `clover` layer, its files the verified
      // copy's, its module a built .js, its tree hash real.
      const views = uiPluginViews(opened.registry);
      expect(views.length).toBeGreaterThan(10);
      const off = views.filter((v) => !v.assetBase.startsWith(staged.dir!) || (v.clientEntry !== undefined && !v.clientEntry.endsWith(".js"))
        || (v.pluginId.startsWith("clover/") && v.layer !== "clover") || !/^sha256:[0-9a-f]{64}$/.test(v.treeHash)).map((v) => v.pluginId);
      expect(off).toEqual([]);
      expect(views.map((v) => v.pluginId)).toContain("alpha");

      // #322's review, S2: a bundled entry rewritten after staging (run/bundled-plugins/clover/...) is refused at load,
      // and its new code never runs.
      const target = hosted.find((p) => p.id.startsWith("clover/"))!;
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
      // One that runs in this build (not one of Clover's not-yet plugins, which never start at all).
      const hosted = opened.registry.list().find((p) => p.manifest?.host !== undefined && (p.manifest.host.runtime ?? "bun") === "bun"
        && (p.manifest as { availability?: unknown }).availability === undefined)!;
      const refused = await Promise.race([ph.host.ensureStarted(hosted.id).then(() => "started", (err: unknown) => (err as Error).message), Bun.sleep(20_000).then(() => "timed out")]);
      expect(`${refused} / ${ph.host.status(hosted.id).reason ?? ""}`).toContain("no verified copy recorded");
    } finally {
      await ph.close();
      opened.close();
    }
  }, 180_000);
});
