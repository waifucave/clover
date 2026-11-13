// Manifest fields over the REAL registry (checklist row 26): `enabledByDefault` on a child decides whether it is on after
// its tree's OK; `scope` (bots, agents, both) decides which sessions get a plugin's MCP servers (PluginMcp over the real
// registry, a stand-in host for the servers); `locales` reach the app's view of the plugin (its language files). Temp
// homes, the fake approval broker and an in-memory secret store; nothing opens a window. `platforms` and `onlyBackends`
// aren't here: nothing in the core reads them yet (the checklist says so).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { Listeners } from "../../contracts/common";
import type { McpChannel } from "../../contracts/plugin-host";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { uiPluginViews } from "../../plugin-host/ui";
import { PluginMcp } from "../../runtime-sdk/turn-loop/plugin-mcp";
import { openPluginRegistry } from "../open";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const ENGINES = { clover: `^${PLUGIN_API_VERSION}` };

async function world(files: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "clover-b-fields-"));
  temps.push(home);
  for (const [path, value] of Object.entries(files)) {
    const at = join(home, "plugins", path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, typeof value === "string" ? value : JSON.stringify(value));
  }
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets: new MemorySecretStore(), settleMs: 50 });
  const approve = async (id: string) => {
    const { card } = await opened.registry.installed(id, "app");
    const shown = broker.cards().find((c) => c.id === card)!;
    await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
    for (let i = 0; i < 250 && opened.registry.get(id)?.state === "found"; i++) await Bun.sleep(20);
  };
  return { home, opened, approve };
}

/** A stand-in for the plugin host's MCP servers: each lists one tool. */
const host = {
  async openMcp(_plugin: string, server: string): Promise<McpChannel> {
    const out = new Listeners<Record<string, unknown>>();
    let closed = false;
    const reply = (m: Record<string, unknown>) => queueMicrotask(() => { if (!closed) out.emit(m); });
    return {
      send(m: Record<string, unknown>) {
        if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } } });
        else if (m.method === "tools/list") reply({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: `${server}_tool`, inputSchema: { type: "object" } }] } });
      },
      onMessage: (fn: (m: Record<string, unknown>) => void) => out.add(fn),
      close() { closed = true; },
      get closed() { return closed; },
    } as unknown as McpChannel;
  },
};

describe("manifest fields over the real registry", () => {
  test("enabledByDefault: a child that says false is off after its tree's OK; one that says nothing is on", async () => {
    const w = await world({
      "kit/clover.json": { manifest: 1, id: "kit", name: "Kit", version: "1.0.0", engines: ENGINES, capabilities: ["notify"] },
      "kit/plugins/core/clover.json": { manifest: 1, name: "Kit core", engines: ENGINES, capabilities: ["notify"] },
      "kit/plugins/extra/clover.json": { manifest: 1, name: "Kit extra", engines: ENGINES, enabledByDefault: false, capabilities: ["notify"] },
    });
    try {
      await w.approve("kit");
      expect([w.opened.registry.get("kit")?.enabled, w.opened.registry.get("kit/core")?.enabled, w.opened.registry.get("kit/extra")?.enabled]).toEqual([true, true, false]);
    } finally {
      w.opened.close();
    }
  });

  test("scope: a plugin's MCP servers reach bots, agents or both as its manifest says", async () => {
    const plugin = (id: string, scope?: string) => ({
      manifest: 1, id, name: id, version: "1.0.0", engines: ENGINES, host: { entry: "host/index.js" },
      ...(scope !== undefined ? { scope } : {}),
      contributes: { mcpServers: { srv: { type: "host" } } },
    });
    const w = await world({
      "for-bots/clover.json": plugin("for-bots", "bots"), "for-bots/host/index.js": "export {};\n",
      "for-agents/clover.json": plugin("for-agents", "agents"), "for-agents/host/index.js": "export {};\n",
      "for-all/clover.json": plugin("for-all"), "for-all/host/index.js": "export {};\n",
    });
    const mcp = new PluginMcp({ registry: w.opened.registry, host: host as never, self: () => "Studio", computers: () => ["Studio"] });
    try {
      for (const id of ["for-bots", "for-agents", "for-all"]) await w.approve(id);
      await mcp.refresh();
      const plugins = (kind: "bot" | "side-thread" | "agent" | "coding") => mcp.servers(kind).map((s) => s.plugin).sort();
      expect(plugins("bot")).toEqual(["for-all", "for-bots"]);
      expect(plugins("side-thread")).toEqual(["for-all", "for-bots"]);
      expect(plugins("agent")).toEqual(["for-agents", "for-all"]);
      expect(plugins("coding")).toEqual(["for-agents", "for-all"]);
    } finally {
      mcp.close();
      w.opened.close();
    }
  });

  test("locales: a plugin's language files reach the app's view of it", async () => {
    const w = await world({
      "words/clover.json": { manifest: 1, id: "words", name: "Words", version: "1.0.0", engines: ENGINES, contributes: { locales: [{ lang: "fr", file: "locales/fr.json" }, { lang: "de", file: "locales/de.json" }] } },
      "words/locales/fr.json": { locale: 1, lang: "fr", strings: { "words.hello": "Bonjour" } },
      "words/locales/de.json": { locale: 1, lang: "de", strings: { "words.hello": "Hallo" } },
    });
    try {
      // A data plugin applies with no card; its view lists its languages.
      for (let i = 0; i < 100 && w.opened.registry.get("words")?.state !== "running"; i++) {
        if (w.opened.registry.get("words")?.state === "found") await w.approve("words");
        await Bun.sleep(20);
      }
      const view = uiPluginViews(w.opened.registry).find((v) => v.pluginId === "words");
      expect(view?.locales).toEqual([{ lang: "fr", file: "locales/fr.json" }, { lang: "de", file: "locales/de.json" }]);
    } finally {
      w.opened.close();
    }
  });
});
