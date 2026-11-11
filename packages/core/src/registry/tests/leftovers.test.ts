// What a plugin leaves when its folder goes without `plugin.remove` (the controller's ruling, 2026-11-11): recorded,
// nothing deleted; kept for the same tree or source when a tree next comes under the id, else forgotten first; a
// forget that fails stops the install.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { pluginRegistryMethods } from "../../plugin-host/registry-methods";
import { sameSource } from "../leftovers";
import { openPluginRegistry } from "../open";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  temps.push(d);
  return d;
};
const APP = { caller: { kind: "user", client: "app" } } as never;

/** A plugin folder `tarot` to install from, its text telling trees apart. */
function source(text: string): string {
  const dir = join(temp("clover-left-src-"), "tarot");
  mkdirSync(join(dir, "skills", "read"), { recursive: true });
  writeFileSync(join(dir, "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
  writeFileSync(join(dir, "skills", "read", "SKILL.md"), `---\nname: read\ndescription: Reads\n---\n${text}\n`);
  return dir;
}

async function world() {
  const home = temp("clover-left-");
  let failDelete = false;
  // The credential store, whose deletes the test can make fail (the registry and the methods share it, as in the daemon).
  const secrets = new (class extends MemorySecretStore {
    override async delete(ref: Parameters<MemorySecretStore["delete"]>[0]): Promise<boolean> {
      if (failDelete) throw new Error("the keychain refused");
      return super.delete(ref);
    }
  })();
  const store = secrets;
  const opened = await openPluginRegistry({
    cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets, settleMs: 50,
    indexes: { cacheDir: join(home, "plugins-state", "index-cache"), fetch: async () => { throw new Error("offline"); }, official: undefined as never },
  });
  const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, secrets: store, indexes: opened.indexes! });
  const dir = join(home, "plugins", "tarot");
  const install = (src: string) => m["plugin.install"]!({ source: { from: "folder", path: src } }, APP) as Promise<{ id: string; state: string; treeHash: string }>;
  /** What tarot has: its keys, its settings file, its data. */
  const has = async () => ({
    keys: (await secrets.list({ kind: "plugin", pluginId: "tarot" })).map((x) => x.ref.name),
    settings: existsSync(join(home, "settings", "plugins", "tarot.json")),
    data: existsSync(join(home, "plugin-data", "tarot")) ? readdirSync(join(home, "plugin-data", "tarot")) : [],
  });
  /** tarot's key, settings and data, as a running plugin would have them. */
  const leave = async () => {
    await secrets.set({ owner: { kind: "plugin", pluginId: "tarot" }, name: "KEY" }, "s3cret");
    mkdirSync(join(home, "settings", "plugins"), { recursive: true });
    writeFileSync(join(home, "settings", "plugins", "tarot.json"), JSON.stringify({ deck: "rider" }));
    mkdirSync(join(home, "plugin-data", "tarot"), { recursive: true });
    writeFileSync(join(home, "plugin-data", "tarot", "journal.md"), "today");
  };
  /** The folder deleted by hand, as a sync or the Finder would. */
  const deleteByHand = async () => {
    rmSync(dir, { recursive: true, force: true });
    await opened.folders.refresh(dir);
  };
  return { home, opened, m, dir, install, has, leave, deleteByHand, failDeletes: (v: boolean) => { failDelete = v; } };
}

const KEPT = { keys: ["KEY"], settings: true, data: ["journal.md"] };
const NONE = { keys: [], settings: false, data: [] };

describe("what a plugin leaves when its folder goes by hand", () => {
  test("recorded, nothing deleted; the same folder copied back keeps its key, settings and data", async () => {
    const w = await world();
    try {
      const src = source("one");
      const r = await w.install(src);
      await w.opened.registry.approve("tarot", r.treeHash);
      await w.leave();
      await w.deleteByHand();
      expect(w.opened.registry.get("tarot")).toBeUndefined();
      expect(w.opened.indexes!.leftBy("tarot")).toMatchObject({ treeHash: r.treeHash, source: "local" });
      expect(await w.has()).toEqual(KEPT);
      cpSync(src, w.dir, { recursive: true });
      await w.opened.folders.refresh(w.dir);
      expect(w.opened.registry.get("tarot")?.treeHash).toBe(r.treeHash);
      expect(await w.has()).toEqual(KEPT);
      expect(w.opened.indexes!.leftBy("tarot")).toBeUndefined();
    } finally {
      w.opened.close();
    }
  });

  test("another tree under the id, installed or copied in, starts with no key, no settings and an empty data folder", async () => {
    const w = await world();
    try {
      await w.opened.registry.approve("tarot", (await w.install(source("one"))).treeHash);
      await w.leave();
      await w.deleteByHand();
      await w.install(source("two"));
      expect(await w.has()).toEqual(NONE);
      // The data is kept aside, never in the new one's folder.
      expect(readdirSync(join(w.home, "plugin-data", ".removed", "tarot")).length).toBe(1);
      expect(w.opened.indexes!.leftBy("tarot")).toBeUndefined();
      // Again by hand, with a different tree copied in by hand: the same.
      await w.leave();
      await w.deleteByHand();
      cpSync(source("three"), w.dir, { recursive: true });
      await w.opened.folders.refresh(w.dir);
      expect(w.opened.registry.get("tarot")?.state).toBe("found");
      expect(await w.has()).toEqual(NONE);
    } finally {
      w.opened.close();
    }
  });

  test("a leftover with no record (a home from before) counts as another source's", async () => {
    const w = await world();
    try {
      await w.leave();
      await w.install(source("one"));
      expect(await w.has()).toEqual(NONE);
    } finally {
      w.opened.close();
    }
  });

  test("a forget that fails stops the install, with the reason, and nothing lands", async () => {
    const w = await world();
    try {
      await w.opened.registry.approve("tarot", (await w.install(source("one"))).treeHash);
      await w.leave();
      await w.deleteByHand();
      w.failDeletes(true);
      const why = await w.install(source("two")).then(() => "installed", (e: Error) => e.message);
      expect(why).toContain("couldn't be cleared for this one: the keychain refused");
      expect(existsSync(w.dir)).toBe(false);
      expect(w.opened.indexes!.leftBy("tarot")).toBeDefined();
    } finally {
      w.opened.close();
    }
  });

  test("plugin.remove forgets at once and leaves no record", async () => {
    const w = await world();
    try {
      await w.opened.registry.approve("tarot", (await w.install(source("one"))).treeHash);
      await w.leave();
      await w.m["plugin.remove"]!({ id: "tarot" }, APP);
      expect(w.opened.indexes!.leftBy("tarot")).toBeUndefined();
      expect(await w.has()).toEqual(NONE);
    } finally {
      w.opened.close();
    }
  });

  test("the same source: the same index URL, the same npm package; a local folder or a wrapper only by its tree", () => {
    const at = { by: "user-app", at: 0 } as const;
    const idx = (url: string) => ({ ...at, index: { url, version: "1.0.0" } });
    expect(sameSource(idx("https://a.test/index.json"), { ...idx("https://a.test/index.json"), index: { url: "https://a.test/index.json", version: "2.0.0" } })).toBe(true);
    expect(sameSource(idx("https://a.test/index.json"), idx("https://b.test/index.json"))).toBe(false);
    expect(sameSource({ ...at, npm: { name: "clover-tarot", version: "1.0.0" } }, { ...at, npm: { name: "clover-tarot", version: "2.0.0" } })).toBe(true);
    expect(sameSource({ ...at, npm: { name: "clover-tarot", version: "1.0.0" } }, idx("https://a.test/index.json"))).toBe(false);
    expect(sameSource(at, at)).toBe(false);
    expect(sameSource({ ...at, wrapped: { from: "mcp-config" } }, { ...at, wrapped: { from: "mcp-config" } })).toBe(false);
  });
});
