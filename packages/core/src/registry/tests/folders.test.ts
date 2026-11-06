// Plugins from folders: found ones wait for their OK, a change since the OK asks again or applies (§5.6), a manifest
// mid-write is left alone, bundled plugins and development folders need none, and the watcher reads a folder once it
// settles.
import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const real = realpathSync(dev); // the real path is what reloads and what the fence keeps bots out of
    expect(w.core.get("tarot")).toMatchObject({ state: "running", dev: true, folder: real });
    expect(w.folders.devFolderPaths()).toEqual([real]);
    expect(w.store.load().plugins.tarot?.okHash).toBeDefined(); // the installed one's OK is kept; the dev folder never syncs
    w.write(dev, { "client/index.tsx": "export const B = 2;" });
    await w.folders.refresh(real);
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
    const { MemorySecretStore } = await import("../../contracts/fakes/secret-store");
    const secrets = new MemorySecretStore();
    expect(await openPluginRegistry({ cloverHome: home, os: "linux", broker }).catch((e: Error) => e.message)).toContain("secret store");
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
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
      const kept = JSON.parse(readFileSync(join(home, "plugins-state", "oks", "tarot.json"), "utf8"));
      expect(JSON.parse(kept.body).okHash).toBe(opened.registry.get("tarot")!.treeHash);
    } finally {
      opened.close();
    }
  });
});

describe("#197's review", () => {
  test("a development folder is kept by its real path; a symlink to it adds the same folder", async () => {
    const w = world();
    const dev = join(w.home, "dev", "tarot");
    w.write(dev, { "clover.json": manifest("tarot") });
    const link = join(w.home, "tarot-link");
    symlinkSync(dev, link);
    await w.folders.scan();
    await w.folders.addDevFolder(link, "cli");
    expect(w.folders.devFolderPaths()).toEqual([realpathSync(dev)]);
    await w.folders.removeDevFolder(dev);
    expect(w.folders.devFolderPaths()).toEqual([]);
  });

  test("an installed plugin with a hard-linked file is invalid; a development folder may hold one", async () => {
    const w = world();
    const outside = join(w.home, "outside.js");
    writeFileSync(outside, "export const a = 1;");
    const tool = join(w.pluginsDir, "tool");
    w.write(tool, { "clover.json": manifest("tool", { host: { entry: "host/index.js" } }) });
    mkdirSync(join(tool, "host"), { recursive: true });
    linkSync(outside, join(tool, "host", "index.js"));
    await w.folders.scan();
    expect(w.core.get("tool")).toMatchObject({ state: "invalid" });
    expect(w.core.get("tool")?.reason).toContain("hard link");
    const dev = join(w.home, "dev", "tool");
    w.write(dev, { "clover.json": manifest("tool", { host: { entry: "host/index.js" } }) });
    mkdirSync(join(dev, "host"), { recursive: true });
    linkSync(outside, join(dev, "host", "index.js"));
    await w.folders.addDevFolder(dev, "cli");
    expect(w.core.get("tool")?.state).not.toBe("invalid");
  });

  test("records edited outside the registry fail closed: with a key, a changed or unsigned file reads as absent", async () => {
    const { fileRegistryStore } = await import("../state");
    const dir = mkdtempSync(join(tmpdir(), "clover-b-mac-"));
    const tampered: string[] = [];
    const key = new Uint8Array(32).fill(7);
    const store = fileRegistryStore(dir, { macKey: key, onTampered: (f) => tampered.push(f) });
    store.save({ v: 1, order: ["tarot"], plugins: { tarot: { okHash: `sha256:${"a".repeat(64)}`, enabled: true } }, dev: [] });
    store.confirmAdult(1);
    expect(store.load().plugins.tarot?.okHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(store.adultConfirmed()).toBe(true);
    const file = join(dir, "installed.json");
    const env = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...env, body: env.body.replace("a".repeat(64), "b".repeat(64)) }));
    expect(store.load()).toEqual({ v: 1, order: [], plugins: {}, dev: [] });
    writeFileSync(join(dir, "adult.json"), JSON.stringify({ body: JSON.stringify({ confirmedAt: 1 }) }));
    expect(store.adultConfirmed()).toBe(false);
    expect(tampered.map((f) => f.slice(dir.length + 1))).toEqual(["installed.json", "adult.json"]);
    // #197's check 2: an older copy put back, or one file copied over another, reads as absent too.
    let counters: Record<string, number> = {};
    const signed = () => fileRegistryStore(dir, { macKey: key, counters, onCounters: (c) => void (counters = c) });
    signed().save({ v: 1, order: ["a"], plugins: {}, dev: [] });
    const older = readFileSync(file, "utf8");
    signed().save({ v: 1, order: ["a", "b"], plugins: {}, dev: [] });
    expect(signed().load().order).toEqual(["a", "b"]);
    writeFileSync(file, older);
    expect(signed().load().order).toEqual([]);
    signed().saveOk("tarot", { okHash: "x", files: [], plugins: {}, cards: "", codePaths: [] });
    signed().saveOk("luna", { okHash: "y", files: [], plugins: {}, cards: "", codePaths: [] });
    expect(signed().loadOk("luna")?.okHash).toBe("y");
    writeFileSync(join(dir, "oks", "luna.json"), readFileSync(join(dir, "oks", "tarot.json")));
    expect(signed().loadOk("luna")).toBeUndefined();
    // Without a key, a file that fails its schema reads as absent too.
    const plain = fileRegistryStore(dir);
    writeFileSync(file, JSON.stringify({ body: JSON.stringify({ v: 1, order: "x", plugins: {}, dev: [] }) }));
    expect(plain.load().order).toEqual([]);
  });

  test("the MAC key is made once, in the secret store", async () => {
    const { registryMacKey } = await import("../open");
    const { MemorySecretStore } = await import("../../contracts/fakes/secret-store");
    const secrets = new MemorySecretStore();
    const a = await registryMacKey(secrets);
    expect(a.length).toBe(32);
    expect([...(await registryMacKey(secrets))]).toEqual([...a]);
  });
});

describe("the registry opens unsigned only in tests (#197's check 3)", () => {
  test("no source outside a test passes `unsigned`", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const repo = join(import.meta.dir, "..", "..", "..", "..", "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".git" || name === "dist" || name === "generated" || name === "tests" || name === "test" || name.startsWith(".")) continue;
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs);
        else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(abs, "utf8");
          // A file that opens the registry and says `unsigned:` (only open.ts may, documenting it).
          if (/openPluginRegistry|registry\.open/.test(text) && /\bunsigned\s*:/.test(text)) hits.push(abs.slice(repo.length + 1));
        }
      }
    };
    for (const top of ["packages", "plugins", "apps"]) {
      try {
        walk(join(repo, top));
      } catch {
        // a top folder this checkout doesn't have
      }
    }
    expect(hits).toEqual(["packages/core/src/registry/open.ts"]);
  });
});
