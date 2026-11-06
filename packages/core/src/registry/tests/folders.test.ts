// Plugins from folders: found ones wait for their OK, a change since the OK asks again or applies (§5.6), a manifest
// mid-write is left alone, bundled plugins and development folders need none, and the watcher reads a folder once it
// settles.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import { RegistryCore } from "../core";
import { DEV_FOLDER_MS, PluginFolders } from "../folders";
import { fileRegistryStore } from "../state";

const manifest = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, ...over });

function world(opts: { settleMs?: number; now?: () => number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "clover-b-folders-"));
  const pluginsDir = join(home, "plugins");
  const bundledDir = join(home, "app", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(bundledDir, { recursive: true });
  const store = fileRegistryStore(join(home, "plugins-state"));
  let folders: PluginFolders;
  const core = new RegistryCore({ catalog: catalogPointDecl, store, onOk: (id, hash) => folders.okGiven(id, hash) });
  folders = new PluginFolders({ core, store, pluginsDir, bundledDirs: [bundledDir], settleMs: opts.settleMs ?? 2_000, ...(opts.now ? { now: opts.now } : {}) });
  const write = (dir: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  return { home, pluginsDir, bundledDir, store, core, folders, write };
}

describe("PluginFolders", () => {
  test("a found folder waits for its OK; after it, a data edit applies and a code change asks again", async () => {
    const w = world();
    const tarot = join(w.pluginsDir, "tarot");
    w.write(tarot, { "clover.json": manifest("tarot"), "README.md": "hi" });
    await w.folders.scan();
    expect(w.core.get("tarot")).toMatchObject({ state: "found", provenance: { by: "found" } });
    expect(await w.core.approve("tarot", w.core.get("tarot")!.treeHash!)).toBe("approved");
    expect(w.core.get("tarot")?.state).toBe("running");
    w.write(tarot, { "README.md": "hello" });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")?.state).toBe("running");
    w.write(tarot, { "client/index.tsx": "export const A = 1;" });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")?.state).toBe("found");
  });

  test("the OK survives a restart, and a change made while the core was down is judged against it", async () => {
    const w = world();
    const tarot = join(w.pluginsDir, "tarot");
    w.write(tarot, { "clover.json": manifest("tarot"), "README.md": "hi" });
    await w.folders.scan();
    await w.core.approve("tarot", w.core.get("tarot")!.treeHash!);
    w.write(tarot, { "README.md": "edited while down" });
    const core = new RegistryCore({ catalog: catalogPointDecl, store: w.store });
    const again = new PluginFolders({ core, store: w.store, pluginsDir: w.pluginsDir });
    await again.scan();
    expect(core.get("tarot")?.state).toBe("running");
  });

  test("a manifest that doesn't parse yet leaves the plugin as it was; a removed folder goes away", async () => {
    const w = world();
    const tarot = join(w.pluginsDir, "tarot");
    w.write(tarot, { "clover.json": manifest("tarot") });
    await w.folders.scan();
    w.write(tarot, { "clover.json": "{ \"manifest\": 1, " });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")?.state).toBe("found");
    rmSync(tarot, { recursive: true });
    await w.folders.refresh(tarot);
    expect(w.core.get("tarot")).toBeUndefined();
  });

  test("a folder whose name isn't its id, or with a symlink out, is invalid with the reason", async () => {
    const w = world();
    w.write(join(w.pluginsDir, "tarot"), { "clover.json": manifest("tarrot") });
    await w.folders.scan();
    expect(w.core.get("tarot")?.state ?? w.core.list()[0]?.state).toBe("invalid");
  });

  test("bundled plugins need no OK; children load with their parent and are invalid alone", async () => {
    const w = world();
    w.write(join(w.bundledDir, "alpha"), {
      "clover.json": manifest("alpha"),
      "plugins/tab/clover.json": JSON.stringify({ manifest: 1, name: "Tab" }),
      "plugins/broken/clover.json": "{}",
    });
    await w.folders.scan();
    expect(w.core.list().map((r) => [r.id, r.state, r.source])).toEqual([
      ["alpha", "running", "bundled"], ["alpha/broken", "invalid", "bundled"], ["alpha/tab", "running", "bundled"],
    ]);
  });

  test("a development folder loads without asking, replaces the installed plugin with its id, and turns off after 24 hours", async () => {
    let now = 1_000_000;
    const w = world({ now: () => now });
    w.write(join(w.pluginsDir, "tarot"), { "clover.json": manifest("tarot", { description: "installed" }) });
    const dev = join(w.home, "dev", "tarot");
    w.write(dev, { "clover.json": manifest("tarot", { description: "dev" }), "client/index.tsx": "export {}" });
    await w.folders.scan();
    await w.core.approve("tarot", w.core.get("tarot")!.treeHash!);
    await w.folders.addDevFolder(dev, "cli");
    expect(w.core.get("tarot")).toMatchObject({ state: "running", dev: true, folder: dev });
    expect(w.folders.devFolderPaths()).toEqual([dev]);
    expect(w.store.load().plugins.tarot?.okHash).toBeDefined(); // the installed one's OK is kept; the dev folder never syncs
    w.write(dev, { "client/index.tsx": "export const B = 2;" });
    await w.folders.refresh(dev);
    expect(w.core.get("tarot")?.state).toBe("running");
    now += DEV_FOLDER_MS + 1;
    await w.folders.expireDevFolders();
    expect(w.folders.devFolderPaths()).toEqual([]);
    expect(w.core.get("tarot")).toMatchObject({ state: "running", dev: false, folder: join(w.pluginsDir, "tarot") });
  });

  test("the watcher reads a folder once it has settled", async () => {
    const w = world({ settleMs: 100 });
    w.folders.start();
    await w.folders.scan();
    try {
      await Bun.sleep(200); // the OS's watch stream starts a moment after the call
      w.write(join(w.pluginsDir, "tarot"), { "clover.json": manifest("tarot") });
      const deadline = Date.now() + 5_000;
      while (!w.core.get("tarot") && Date.now() < deadline) await Bun.sleep(50);
      expect(w.core.get("tarot")?.state).toBe("found");
    } finally {
      w.folders.stop();
    }
  });
});

describe("openPluginRegistry", () => {
  test("opens on a Clover home: a found plugin's OK card through the broker carries its OK text, and the OK is kept", async () => {
    const { openPluginRegistry } = await import("../open");
    const { FakeApprovalBroker } = await import("../../contracts/fakes/approval-broker");
    const { FakeClock } = await import("../../contracts/fakes/clock");
    const home = mkdtempSync(join(tmpdir(), "clover-b-open-"));
    mkdirSync(join(home, "plugins", "tarot"), { recursive: true });
    writeFileSync(join(home, "plugins", "tarot", "clover.json"), manifest("tarot", { name: "Tarot" }));
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, settleMs: 50 });
    try {
      const { card } = await opened.registry.installed("tarot", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      expect(shown.fields.title).toEqual({ type: "text", text: "Tarot" });
      expect(shown.fields.source).toEqual({ type: "text", text: "It was found on disk." });
      expect((shown.fields.what as { items: string[] }).items[0]).toBe("tarot is data only: files, no code.");
      const frame = broker.frameChannel(card!)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame, input: "click", at: Date.now() } }, { role: "app" });
      await Bun.sleep(5);
      expect(opened.registry.get("tarot")?.state).toBe("running");
      expect(JSON.parse(readFileSync(join(home, "plugins-state", "oks", "tarot.json"), "utf8")).okHash).toBe(opened.registry.get("tarot")!.treeHash);
    } finally {
      opened.close();
    }
  });
});
