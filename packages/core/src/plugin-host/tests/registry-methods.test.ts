// The app's and the CLI's plugin methods over a real registry: the protocol's views, the switch, logs, the adult
// confirmation, development folders, removing, and what isn't served yet. Temp homes; no window.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { PluginDetail, PluginSummary } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { beforePluginsOpen, pluginRegistryMethods } from "../registry-methods";
import { pluginDataFolder } from "../paths";

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
      await call("plugin.restart", { id: "tarot" });
      expect(restarted).toEqual(["tarot"]);
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

  test("before the registry opens, the lists are empty and anything else is refused while it opens", () => {
    expect(beforePluginsOpen("plugin.list")).toEqual({ plugins: [], adultConfirmed: false });
    expect(beforePluginsOpen("point.list")).toEqual({ points: [] });
    expect(() => beforePluginsOpen("plugin.setEnabled")).toThrow("still opening");
  });
});
