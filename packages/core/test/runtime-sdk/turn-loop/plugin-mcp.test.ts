// Plugins' `host` MCP servers for bots (lane A over lane B's plugin host): listed with their loading, placed for lane J's
// router, called as the session's caller (R7) over one shared channel per server, and opened again after it closes.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { Listeners } from "../../../src/contracts/common";
import type { McpChannel } from "../../../src/contracts/plugin-host";
import type { Contribution, PluginRecord, RegistryChange } from "../../../src/contracts/plugin-registry";
import { PluginMcp } from "../../../src/runtime-sdk/turn-loop/plugin-mcp";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const BOT: Caller = { kind: "session", sessionId: "b_alpha", botId: "alpha" } as unknown as Caller;

/** A plugin's MCP server behind a channel, as the plugin host gives it: records what it was sent and with whom. */
function fakeHost() {
  const opened: { plugin: string; server: string; channel: McpChannel & { kill(): void } }[] = [];
  const calls: { tool: string; args: unknown; as?: Caller }[] = [];
  let hang = false;
  const host = {
    async openMcp(plugin: string, server: string): Promise<McpChannel> {
      const out = new Listeners<Record<string, unknown>>();
      let closed = false;
      const reply = (m: Record<string, unknown>) => queueMicrotask(() => { if (!closed) out.emit(m); });
      const channel = {
        send(m: Record<string, unknown>, as?: Caller) {
          if (closed) throw new Error("closed");
          if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } } });
          else if (m.method === "tools/list") reply({ jsonrpc: "2.0", id: m.id, result: { tools: [
            { name: "WebSearch", description: "Search the web.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
            { name: "WebFetch", description: "Fetch a page.", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
            { name: "Later", inputSchema: { type: "object" } },
          ] } });
          else if (m.method === "tools/call") {
            const p = m.params as { name: string; arguments: unknown };
            calls.push({ tool: p.name, args: p.arguments, ...(as === undefined ? {} : { as }) });
            if (!hang) reply({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `ran ${p.name}` }] } });
          }
        },
        onMessage: (fn: (m: Record<string, unknown>) => void) => out.add(fn),
        close() { closed = true; },
        get closed() { return closed; },
        kill() { closed = true; },
      };
      opened.push({ plugin, server, channel });
      return channel;
    },
  };
  return { host, opened, calls, hang: (on: boolean) => { hang = on; } };
}

function fakeRegistry(entries: Contribution[], folders: Record<string, string>, manifests: Record<string, unknown> = {}) {
  const watchers = new Listeners<RegistryChange>();
  return {
    entries: (point: string) => (point === "mcpServers" ? entries : []),
    get: (id: string) => (folders[id] === undefined ? undefined : { folder: folders[id], manifest: manifests[id] } as unknown as PluginRecord),
    watch: (fn: (c: RegistryChange) => void) => watchers.add(fn),
    changed: () => watchers.emit({ type: "entries", point: "mcpServers" }),
  };
}

const entry = (pluginId: string, name: string, value: Record<string, unknown>, state: Contribution["state"] = "active"): Contribution =>
  ({ point: "mcpServers", pluginId, ref: `mcpServers/${name}`, entryId: name, value: { name, ...value }, state }) as Contribution;

test("a host server's tools are listed with their loading and instructions, placed remote (saveTo) or here, and scoped", async () => {
  const folder = mkdtempSync(join(tmpdir(), "clover-a3-pmcp-"));
  temps.push(folder);
  writeFileSync(join(folder, "instructions.md"), "Search before you guess.\n");
  mkdirSync(join(folder, "elsewhere"));
  const registry = fakeRegistry([
    entry("clover", "web", { type: "host", tools: { WebSearch: "preload", WebFetch: "preload" }, instructions: "instructions.md" }),
    entry("acme", "blender", { type: "host", perComputer: true, tools: { "*": "preload" }, scope: "agents" }),
    entry("acme", "files", { type: "stdio", command: "x" }),
    entry("acme", "off", { type: "host" }, "waiting"),
  ], { clover: folder, acme: folder });
  const { host } = fakeHost();
  const mcp = new PluginMcp({ registry, host, self: () => "Studio" });
  try {
    await mcp.refresh();
    const forBot = mcp.servers("bot");
    expect(forBot.map((s) => s.server)).toEqual(["web"]);
    const web = forBot[0]!;
    expect(web.plugin).toBe("clover");
    expect(web.instructions).toBe("Search before you guess.");
    expect(web.tools.map((t) => [t.name, t.load])).toEqual([["WebSearch", "preload"], ["WebFetch", "preload"], ["Later", "on-demand"]]);
    // A remote server: the router's optional saveTo on every tool, and no computers.
    expect(mcp.placement("web")).toEqual({ name: "web", kind: "remote", computers: [] });
    expect(web.tools[0]!.inputSchema.properties).toHaveProperty("saveTo");
    expect(mcp.fields("web").saveTo).toBe("saveTo");
    // An agents-only, per-computer server: placed here, never a bot's.
    expect(mcp.servers("agent").map((s) => s.server)).toEqual(["web", "blender"]);
    expect(mcp.placement("blender")).toEqual({ name: "blender", kind: "local", computers: ["Studio"] });
    expect(mcp.servers("agent")[1]!.tools.every((t) => t.load === "preload")).toBe(true);
    // stdio and waiting entries aren't served here.
    expect(mcp.placement("files")).toBeUndefined();
    expect(mcp.placement("off")).toBeUndefined();
  } finally {
    mcp.close();
  }
});

test("calls go as the session's caller over one shared channel; a closed channel opens again; a cancel reaches the server", async () => {
  const registry = fakeRegistry([entry("clover", "web", { type: "host" })], { clover: "/nonexistent" });
  const fake = fakeHost();
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio" });
  try {
    await mcp.refresh();
    expect(fake.opened).toHaveLength(1);
    const r = await mcp.call({ server: "web", tool: "WebSearch", input: { query: "clover" }, as: BOT, session: "b_alpha" });
    expect(r).toEqual({ content: [{ type: "text", text: "ran WebSearch" }] });
    expect(fake.calls).toEqual([{ tool: "WebSearch", args: { query: "clover" }, as: BOT }]);
    // The listing and the call shared the channel.
    expect(fake.opened).toHaveLength(1);
    // The plugin crashed: the channel closed. The next call opens a new one (and initializes it).
    fake.opened[0]!.channel.kill();
    await mcp.call({ server: "web", tool: "WebFetch", input: { url: "https://example.org" }, as: BOT, session: "b_alpha" });
    expect(fake.opened).toHaveLength(2);
    // A call the session cancels fails cancelled, and the server is told.
    fake.hang(true);
    const abort = new AbortController();
    const pending = mcp.call({ server: "web", tool: "WebSearch", input: { query: "slow" }, as: BOT, session: "b_alpha", signal: abort.signal });
    await Bun.sleep(10);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    // A call whose channel closes while it waits fails closed.
    const waiting = mcp.call({ server: "web", tool: "WebSearch", input: { query: "slower" }, as: BOT, session: "b_alpha" });
    await Bun.sleep(10);
    fake.opened[1]!.channel.kill();
    await expect(waiting).rejects.toMatchObject({ code: "closed" });
    // An unknown server is not installed.
    await expect(mcp.call({ server: "nope", tool: "x", input: {}, as: BOT, session: "b_alpha" })).rejects.toMatchObject({ code: "not_installed" });
  } finally {
    mcp.close();
  }
});

test("the registry's change relists: a server that went away is forgotten and its channel closed", async () => {
  const entries = [entry("clover", "web", { type: "host" })];
  const registry = fakeRegistry(entries, { clover: "/nonexistent" });
  const fake = fakeHost();
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio" });
  try {
    await mcp.refresh();
    expect(mcp.servers("bot")).toHaveLength(1);
    entries.splice(0);
    registry.changed();
    await mcp.refresh();
    expect(mcp.servers("bot")).toEqual([]);
    expect(fake.opened[0]!.channel.closed).toBe(true);
  } finally {
    mcp.close();
  }
});
