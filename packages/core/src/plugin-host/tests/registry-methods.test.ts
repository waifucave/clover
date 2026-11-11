// The app's and the CLI's plugin methods over a real registry: the protocol's views, the switch, logs, the adult
// confirmation, development folders, removing, and what isn't served yet. Temp homes; no window.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { PluginDetail, PluginSummary } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { beforePluginsOpen, pluginRegistryMethods, summaryOf } from "../registry-methods";
import { iconOf } from "../ui";
import { CORE_VERSION } from "../../version";
import { pluginDataFolder } from "../paths";
import { brokerCardOpener } from "../../devices/rpc";
import type { Card } from "@waifucave/clover-protocol";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const CLI = { caller: { kind: "user", client: "cli" } } as never;
const APP = { caller: { kind: "user", client: "app" } } as never;
const manifest = (id: string) => JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } });

describe("what a plugin's row shows", () => {
  const record = (o: Record<string, unknown>) => ({
    id: "tarot", name: "Tarot", version: "1.0.0", state: "running", enabled: true, source: "index", class: "code", namespace: "tarot",
    scope: "both", adult: false, children: [], dev: false, granted: [], ...o,
  }) as never;

  test("the bundled clover tree wears the app's version; a plugin its own; a wrapper with none keeps its 0.0.0 (the page shows none)", () => {
    expect(summaryOf(record({ id: "clover", source: "bundled", version: "0.0.0", manifest: { manifest: 1, id: "clover", name: "Clover" } })).version).toBe(CORE_VERSION);
    expect(summaryOf(record({ id: "clover/shell", source: "bundled", version: "0.0.0", manifest: { manifest: 1, id: "clover/shell", name: "Shell" } })).version).toBe(CORE_VERSION);
    expect(summaryOf(record({ id: "alpha", source: "bundled", version: "0.0.0", manifest: { manifest: 1, id: "alpha", name: "Alpha" } })).version).toBe("0.0.0");
    expect(summaryOf(record({ source: "index", manifest: { manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0" } })).version).toBe("1.0.0");
    expect(summaryOf(record({ id: "clover", source: "index", version: "0.0.0", manifest: { manifest: 1, id: "clover", name: "Clover" } })).version).toBe("0.0.0");
  });

  test("its description when it's text, cut; never a table that isn't, nor anything else", () => {
    expect(summaryOf(record({ manifest: { description: "Draws a card." } })).description).toBe("Draws a card.");
    expect(summaryOf(record({ manifest: { description: { en: "Draws.", fr: "Tire." } } })).description).toEqual({ en: "Draws.", fr: "Tire." });
    expect((summaryOf(record({ manifest: { description: "x".repeat(5000) } })).description as string).length).toBe(500);
    for (const bad of [{ fr: "Tire." }, { en: "Draws.", fr: 3 }, 42, null, ["a"]]) expect(summaryOf(record({ manifest: { description: bad } })).description).toBeUndefined();
    expect(summaryOf(record({})).description).toBeUndefined();
  });

  test("its picture: the manifest's icon, else its bot's avatar portrait, else none", () => {
    expect(iconOf({ icon: "assets/icon.png", contributes: { bot: { avatar: { portrait: "assets/p.png" } } } })).toBe("assets/icon.png");
    expect(iconOf({ contributes: { bot: { avatar: { portrait: "assets/p.png" } } } })).toBe("assets/p.png");
    expect(iconOf({ icon: "" })).toBeUndefined();
    expect(iconOf({ icon: 3 })).toBeUndefined();
    expect(iconOf({})).toBeUndefined();
    for (const bad of ["/etc/a.png", "../a.png", "a//b.png", "https://x.example/a.png", "x".repeat(4097)]) expect(iconOf({ icon: bad })).toBeUndefined();
    expect(iconOf({ icon: "../a.png", contributes: { bot: { avatar: { portrait: "assets/p.png" } } } })).toBe("assets/p.png");
  });
});

describe("plugin.* over the registry", () => {
  test("views, the switch, logs, the adult confirmation, development folders, removal, and what isn't served", async () => {
    const home = temp("clover-b2-methods-");
    mkdirSync(join(home, "plugins", "tarot"), { recursive: true });
    writeFileSync(join(home, "plugins", "tarot", "clover.json"), manifest("tarot"));
    mkdirSync(join(home, "logs", "plugins"), { recursive: true });
    writeFileSync(join(home, "logs", "plugins", "tarot.log"), "one\ntwo\nthree\n");
    const dev = join(temp("clover-b2-dev-"), "luna");
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "clover.json"), manifest("luna"));
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets, settleMs: 50 });
    const restarted: string[] = [];
    const m = pluginRegistryMethods({ opened, host: { restart: async (id) => void restarted.push(id) }, home, secrets });
    const call = (name: string, params: unknown, ctx = CLI) => m[name]!(params, ctx);
    try {
      const list = (await call("plugin.list", {})) as { plugins: unknown[]; adultConfirmed: boolean };
      expect(list.plugins.map((p) => PluginSummary.parse(p).id)).toEqual(["tarot"]);
      expect(list.adultConfirmed).toBe(false);
      const detail = PluginDetail.parse(((await call("plugin.get", { id: "tarot" })) as { plugin: unknown }).plugin);
      expect([detail.state, detail.logTail]).toEqual(["found", ["one", "two", "three"]]);
      expect(await call("plugin.logs", { id: "tarot", lines: 2 })).toEqual({ lines: ["two", "three"] });
      // Switching a found plugin on raises its OK card, never loads it.
      expect(await call("plugin.setEnabled", { id: "tarot", enabled: true })).toMatchObject({ applied: false });
      // A plugin with no OK yet (or blocked, refused, off) has nothing to restart: refused, the host never asked.
      expect((await call("plugin.restart", { id: "tarot" }).catch((e: Error) => e.message)) as string).toContain("nothing to restart");
      expect(restarted).toEqual([]);
      await call("plugin.confirmAdult", {});
      expect(((await call("plugin.list", {})) as { adultConfirmed: boolean }).adultConfirmed).toBe(true);

      // Development folders: the CLI adds one; the app's add waits for the broker's card.
      expect((await call("plugin.dev.add", { path: dev }, APP).catch((e: Error) => e.message)) as string).toContain("approval broker");
      expect(await call("plugin.dev.add", { path: dev })).toEqual({ applied: true });
      const folders = ((await call("plugin.dev.list", {})) as { folders: { path: string; pluginId?: string }[] }).folders;
      expect(folders.map((f) => f.pluginId)).toEqual(["luna"]);
      await call("plugin.dev.remove", { path: dev });
      expect(await call("plugin.dev.list", {})).toEqual({ folders: [] });

      // Not served yet: refused with why.
      expect((await call("plugin.install", { source: { from: "npm", name: "x" } }).catch((e: Error) => e.message)) as string).toContain("isn't served on this computer yet");
      expect(await call("plugin.index.list", {})).toEqual({ indexes: [] });

      // Removing deletes the folder; the registry forgets it.
      // Only the user switches or restarts a plugin (#332's review).
      const BOT = { caller: { kind: "session", sessionId: "s_1", sessionKind: "bot" } } as never;
      for (const [name, params] of [["plugin.setEnabled", { id: "tarot", enabled: false }], ["plugin.restart", { id: "tarot" }]] as const) {
        expect((await call(name, params, BOT).catch((e: Error) => e.message)) as string).toMatch(/only the user/i);
      }

      // What tarot leaves: its secrets, settings and synced store go; its data folder is kept, keyed to this install.
      const ref = { owner: { kind: "plugin" as const, pluginId: "tarot" }, name: "key" };
      await secrets.set(ref, "sk-tarot" as never);
      await secrets.set({ owner: { kind: "plugin", pluginId: "luna" }, name: "key" }, "sk-luna" as never);
      for (const dir of ["plugins", "plugin-stores"]) {
        mkdirSync(join(home, "settings", dir), { recursive: true });
        writeFileSync(join(home, "settings", dir, "tarot.json"), "{}");
      }
      writeFileSync(join(pluginDataFolder(home, "tarot"), "deck.json"), "the old deck");
      await call("plugin.remove", { id: "tarot" });
      expect(existsSync(join(home, "plugins", "tarot"))).toBe(false);
      expect(opened.registry.get("tarot")).toBeUndefined();
      expect(await secrets.get(ref)).toBeNull();
      expect(await secrets.get({ owner: { kind: "plugin", pluginId: "luna" }, name: "key" })).not.toBeNull();
      expect([existsSync(join(home, "settings", "plugins", "tarot.json")), existsSync(join(home, "settings", "plugin-stores", "tarot.json"))]).toEqual([false, false]);
      // A plugin installed later under the same id starts with an empty data folder; the old one is kept aside.
      expect(readdirSync(pluginDataFolder(home, "tarot"))).toEqual([]);
      const kept = readdirSync(join(home, "plugin-data", ".removed", "tarot"));
      expect(kept.length).toBe(1);
      expect(readFileSync(join(home, "plugin-data", ".removed", "tarot", kept[0]!, "deck.json"), "utf8")).toBe("the old deck");
      expect(JSON.parse(readFileSync(join(home, "plugin-data", ".removed", "tarot", kept[0]!, ".clover-removed.json"), "utf8"))).toMatchObject({ id: "tarot", source: "local" });
    } finally {
      opened.close();
    }
  });

  test("a secret that can't be deleted stops the removal: the folder stays, so nothing is left for a same-id reinstall (#332's second review)", async () => {
    const home = temp("clover-b2-methods-");
    mkdirSync(join(home, "plugins", "tarot"), { recursive: true });
    writeFileSync(join(home, "plugins", "tarot", "clover.json"), manifest("tarot"));
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets, settleMs: 50 });
    await secrets.set({ owner: { kind: "plugin", pluginId: "tarot" }, name: "key" }, "sk" as never);
    const failing = { list: secrets.list.bind(secrets), delete: async () => { throw new Error("the store is locked"); } };
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, secrets: failing });
    try {
      expect((await m["plugin.remove"]!({ id: "tarot" }, CLI).catch((e: Error) => e.message)) as string).toContain("locked");
      expect(existsSync(join(home, "plugins", "tarot"))).toBe(true);
      expect(opened.registry.get("tarot")).toBeDefined();
    } finally {
      opened.close();
    }
  });

  // J's macOS audit: install from a folder, and add a development folder from the app.
  test("an OK that lands while the folder's settle is reading it stays: the plugin turns on (acceptance step 4's race)", async () => {
    const home = temp("clover-b2-race-");
    const src = join(temp("clover-b2-src-"), "tarot");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "clover.json"), manifest("tarot"));
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    // No settle of its own in the test's time: the race is played by hand, in order.
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 60_000 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    try {
      const r = (await m["plugin.install"]!({ source: { from: "folder", path: src } }, APP)) as { id: string; state: string; treeHash: string };
      expect(r.state).toBe("found");
      // The settle of the install's folder starts: it reads the records (no OK yet) and then the folder...
      const reading = opened.folders.refresh(join(home, "plugins", "tarot"));
      // ...while the user's OK lands...
      expect(await opened.registry.approve("tarot", r.treeHash)).toBe("approved");
      expect(opened.registry.get("tarot")?.state).toBe("running");
      // ...and the read puts what it found: the same tree, which the OK covers.
      await reading;
      expect(opened.registry.get("tarot")?.state).toBe("running");
      // A read after it, of the same tree, keeps it on; a data file applies at once; code added still asks again.
      await opened.folders.refresh(join(home, "plugins", "tarot"));
      expect(opened.registry.get("tarot")?.state).toBe("running");
      writeFileSync(join(home, "plugins", "tarot", "notes.txt"), "changed");
      await opened.folders.refresh(join(home, "plugins", "tarot"));
      expect(opened.registry.get("tarot")?.state).toBe("running");
      writeFileSync(join(home, "plugins", "tarot", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
      await opened.folders.refresh(join(home, "plugins", "tarot"));
      expect(opened.registry.get("tarot")?.state).toBe("found");
    } finally {
      opened.close();
    }
  });

  test("plugin.install from a folder: copied in, validated, found, and its OK card raised; never over an installed id", async () => {
    const home = temp("clover-b2-install-");
    const src = join(temp("clover-b2-src-"), "tarot");
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "clover.json"), manifest("tarot"));
    writeFileSync(join(src, "readme.md"), "Tarot");
    writeFileSync(join(src, "bin", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("readme.md", join(src, "README"));
    mkdirSync(join(src, ".git"));
    writeFileSync(join(src, ".git", "config"), "[core]\n");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    const call = (name: string, params: unknown, ctx = APP) => m[name]!(params, ctx);
    try {
      const r = (await call("plugin.install", { source: { from: "folder", path: src } })) as { id: string; state: string; treeHash: string; card?: string };
      expect([r.id, r.state]).toEqual(["tarot", "found"]);
      expect(r.treeHash).toMatch(/^sha256:/);
      expect(broker.cards().find((c) => c.id === r.card)).toMatchObject({ kind: "plugin-ok", pluginId: "tarot" });
      const dest = join(home, "plugins", "tarot");
      expect(readFileSync(join(dest, "README"), "utf8")).toBe("Tarot");
      expect(statSync(join(dest, "README")).isFile()).toBe(true);
      expect(statSync(join(dest, "bin", "run.sh")).mode & 0o111).not.toBe(0);
      expect(existsSync(join(dest, ".git"))).toBe(false);
      expect(readdirSync(join(home, "run", "plugin-install"))).toEqual([]);
      const detail = PluginDetail.parse(((await call("plugin.get", { id: "tarot" })) as { plugin: unknown }).plugin);
      expect([detail.state, detail.provenance.by]).toEqual(["found", "user-app"]);
      // The same id again: refused, the installed copy untouched.
      expect(((await call("plugin.install", { source: { from: "folder", path: src } }).catch((e: Error) => e.message)) as string)).toContain("already installed");
      // A link that leaves the folder, an invalid manifest, a folder inside the plugins folder, a missing one: refused,
      // nothing left behind.
      const out = join(temp("clover-b2-src-"), "leaky");
      mkdirSync(out);
      writeFileSync(join(out, "clover.json"), manifest("leaky"));
      symlinkSync("/etc/hosts", join(out, "hosts"));
      const bad = join(temp("clover-b2-src-"), "bad");
      mkdirSync(bad);
      writeFileSync(join(bad, "clover.json"), JSON.stringify({ manifest: 1, id: "bad", name: "Bad", version: "not a version" }));
      for (const path of [out, bad, dest, join(src, "nope")]) {
        expect([path, ((await call("plugin.install", { source: { from: "folder", path } }).catch((e: Error) => "refused: " + e.message)) as string).startsWith("refused: ")]).toEqual([path, true]);
      }
      expect(readdirSync(join(home, "plugins")).sort()).toEqual(["tarot"]);
      expect(readdirSync(join(home, "run", "plugin-install"))).toEqual([]);
      // npm and the index wait for their clients.
      expect(((await call("plugin.install", { source: { from: "npm", name: "x" } }).catch((e: Error) => e.message)) as string)).toContain("this computer has no index client");
      // In the terminal, the provenance says so.
      const other = join(temp("clover-b2-src-"), "luna");
      mkdirSync(other);
      writeFileSync(join(other, "clover.json"), manifest("luna"));
      await call("plugin.install", { source: { from: "folder", path: other } }, CLI);
      expect(PluginDetail.parse(((await call("plugin.get", { id: "luna" })) as { plugin: unknown }).plugin).provenance.by).toBe("user-terminal");
    } finally {
      opened.close();
    }
  });

  test("plugin.dev.add from the app raises a dev-folder card; the folder loads only on the user's yes", async () => {
    const home = temp("clover-b2-devcard-");
    const dev = join(temp("clover-b2-dev-"), "luna");
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "clover.json"), manifest("luna"));
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, openCard: brokerCardOpener(broker) });
    const call = (name: string, params: unknown, ctx = APP) => m[name]!(params, ctx);
    const answer = async (card: Card, optionId: string) =>
      broker.answer(card.id, { optionId, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: Date.now() } }, { role: "app" });
    const listed = async () => ((await call("plugin.dev.list", {})) as { folders: { path: string }[] }).folders.length;
    try {
      const no = (await call("plugin.dev.add", { path: dev })) as { applied: boolean; card: string };
      expect(no.applied).toBe(false);
      const noCard = broker.cards().find((c) => c.id === no.card)!;
      expect(noCard).toMatchObject({ kind: "change", change: "dev-folder" });
      expect(await answer(noCard, "deny")).toBe("accepted");
      await Bun.sleep(20);
      expect(await listed()).toBe(0);
      const yes = (await call("plugin.dev.add", { path: dev })) as { applied: boolean; card: string };
      expect(await answer(broker.cards().find((c) => c.id === yes.card)!, "approve")).toBe("accepted");
      for (let i = 0; i < 50 && (await listed()) === 0; i++) await Bun.sleep(10);
      expect(await listed()).toBe(1);
      // A folder that isn't a plugin raises no card.
      expect(((await call("plugin.dev.add", { path: home }).catch((e: Error) => e.message)) as string)).toContain("has no clover.json");
    } finally {
      opened.close();
    }
  });

  test("before the registry opens, the lists are empty and anything else is refused while it opens", () => {
    expect(beforePluginsOpen("plugin.list")).toEqual({ plugins: [], adultConfirmed: false });
    expect(beforePluginsOpen("point.list")).toEqual({ points: [] });
    expect(() => beforePluginsOpen("plugin.setEnabled")).toThrow("still opening");
  });
});
