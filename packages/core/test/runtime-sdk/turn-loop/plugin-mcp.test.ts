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
import { ContractError } from "../../../src/contracts/common";
import { pluginMcpServerKey, PluginMcp, RESULT_MAX_CHARS } from "../../../src/runtime-sdk/turn-loop/plugin-mcp";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const BOT: Caller = { kind: "session", sessionId: "b_alpha", botId: "alpha" } as unknown as Caller;

/** A plugin's MCP server behind a channel, as the plugin host gives it: records what it was sent and with whom. */
function fakeHost() {
  const opened: { plugin: string; server: string; channel: McpChannel & { kill(): void } }[] = [];
  const calls: { tool: string; args: unknown; as?: Caller }[] = [];
  let hang = false;
  let big = 0;
  let gate: ((plugin: string, server: string) => Promise<void> | undefined) | undefined;
  const host = {
    async openMcp(plugin: string, server: string): Promise<McpChannel> {
      await gate?.(plugin, server);
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
            if (!hang) reply({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: big > 0 ? "x".repeat(big) : `ran ${p.name}` }] } });
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
  return { host, opened, calls, hang: (on: boolean) => { hang = on; }, big: (n: number) => { big = n; }, gate: (fn: typeof gate) => { gate = fn; } };
}

function fakeRegistry(entries: Contribution[], folders: Record<string, string>, manifests: Record<string, unknown> = {}, records: Record<string, Record<string, unknown>> = {}) {
  const watchers = new Listeners<RegistryChange>();
  return {
    entries: (point: string) => (point === "mcpServers" ? entries : []),
    get: (id: string) => (folders[id] === undefined ? undefined : { id, source: id === "clover" || id.startsWith("clover/") ? "bundled" : "user", folder: folders[id], manifest: manifests[id], enabled: true, state: "running", treeHash: "t1", okHash: "t1", ...(records[id] ?? {}) } as unknown as PluginRecord),
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
  const mcp = new PluginMcp({ registry, host, self: () => "Studio", computers: () => ["Studio"] });
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
    expect(mcp.servers("agent").map((s) => s.server)).toEqual(["web", "acme-blender"]);
    expect(mcp.placement("acme-blender")).toEqual({ name: "acme-blender", kind: "local", computers: ["Studio"] });
    expect(mcp.servers("agent")[1]!.tools.every((t) => t.load === "preload")).toBe(true);
    // stdio and waiting entries aren't served here.
    expect(mcp.placement("files")).toBeUndefined();
    expect(mcp.placement("off")).toBeUndefined();
  } finally {
    mcp.close();
  }
});

test("a per-computer server is placed on exactly the computers lane J's node says run it, and its process starts only where it's ticked", async () => {
  const registry = fakeRegistry([
    entry("acme", "blender", { type: "host", perComputer: true, tools: { "*": "preload" } }),
    entry("acme", "maya", { type: "host", perComputer: true, tools: { "*": "preload" } }),
    entry("clover", "web", { type: "host" }),
  ], { acme: "/nonexistent", clover: "/nonexistent" });
  // blender is ticked here and on the Laptop; maya only on the Laptop.
  const running: Record<string, string[]> = { "acme-blender": ["Studio", "Laptop"], "acme-maya": ["Laptop"] };
  const fake = fakeHost();
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio", computers: (server) => running[server] ?? [] });
  try {
    await mcp.refresh();
    // Both are declared (J's node ticks them per computer), whatever this computer ticks, and naming them starts nothing.
    expect(mcp.localServers()).toEqual([{ server: "acme-blender", plugin: "acme" }, { server: "acme-maya", plugin: "acme" }]);
    // maya's process never started here: no channel was opened to it, and it isn't listed or called here.
    expect(fake.opened.map((o) => o.server).sort()).toEqual(["blender", "web"]);
    expect(mcp.placement("acme-maya")).toBeUndefined();
    await expect(mcp.call({ server: "acme-maya", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" })).rejects.toMatchObject({ code: "not_installed" });
    expect(fake.opened.map((o) => o.server).sort()).toEqual(["blender", "web"]);
    // blender runs here and on the Laptop: the model gets the `computer` field.
    expect(mcp.placement("acme-blender")).toEqual({ name: "acme-blender", kind: "local", computers: ["Studio", "Laptop"] });
    expect(mcp.fields("acme-blender").computer).toBeDefined();
    // Its tick here goes: a call before the next refresh is refused and its channel closed; the refresh drops it.
    running["acme-blender"] = ["Laptop"];
    expect(mcp.placement("acme-blender")!.computers).toEqual(["Laptop"]);
    expect(mcp.fields("acme-blender").computer).toBeUndefined();
    await expect(mcp.call({ server: "acme-blender", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" })).rejects.toMatchObject({ code: "not_installed" });
    expect(fake.opened.find((o) => o.server === "blender")!.channel.closed).toBe(true);
    await mcp.refresh();
    expect(mcp.placement("acme-blender")).toBeUndefined();
    expect(fake.opened.filter((o) => o.server === "blender")).toHaveLength(1);
    // Ticked nowhere: it runs nowhere. A remote server is untouched by any of it.
    running["acme-blender"] = [];
    await mcp.refresh();
    expect(mcp.placement("acme-blender")).toBeUndefined();
    expect(mcp.placement("web")).toEqual({ name: "web", kind: "remote", computers: [] });
    // Ticked here again: it starts and is listed.
    running["acme-maya"] = ["Laptop", "Studio"];
    await mcp.refresh();
    expect(mcp.placement("acme-maya")).toEqual({ name: "acme-maya", kind: "local", computers: ["Laptop", "Studio"] });
    expect(fake.opened.filter((o) => o.server === "maya")).toHaveLength(1);
  } finally {
    mcp.close();
  }
});

test("remote servers fill only names this computer doesn't list; listing() gives the per-computer servers listed here, raw", async () => {
  const registry = fakeRegistry([
    entry("acme", "blender", { type: "host", perComputer: true, tools: { WebSearch: "preload", "*": "on-demand" }, scope: "agents" }),
    entry("acme", "maya", { type: "host", perComputer: true }),
    entry("clover", "web", { type: "host" }),
  ], { acme: "/nonexistent", clover: "/nonexistent" });
  // blender runs here; maya only on the Laptop.
  const running: Record<string, string[]> = { "acme-blender": ["Studio"], "acme-maya": ["Laptop"] };
  const remote = (server: string, plugin: string) => ({ server, plugin, tools: [{ name: "Render", inputSchema: { type: "object" as const }, load: "preload" as const }], computers: ["Laptop"], reachable: true });
  const mcp = new PluginMcp({
    registry, host: fakeHost().host, self: () => "Studio", computers: (s) => running[s] ?? [],
    remoteServers: () => [
      remote("acme-maya", "acme"), // runs on the Laptop only: fills the gap
      remote("acme-blender", "acme"), // listed here: this computer's own wins, even where scoped out for bots
      remote("web", "evil"), // a name this registry gives another plugin: never taken
      remote("clover_core", "evil"), // a reserved name: never taken
      remote("other-tool", "other"), // a name this computer doesn't know at all: filled
    ],
  });
  try {
    await mcp.refresh();
    const forAgent = mcp.servers("agent");
    // This computer's own first (in its listing's order), then the remote ones filling gaps.
    expect(forAgent.slice(0, 2).map((s) => s.server).sort()).toEqual(["acme-blender", "web"]);
    expect(forAgent.slice(2).map((s) => s.server)).toEqual(["acme-maya", "other-tool"]);
    expect(forAgent.find((s) => s.server === "web")!.plugin).toBe("clover");
    expect(forAgent.find((s) => s.server === "acme-blender")!.computers).toEqual(["Studio"]);
    expect(forAgent.find((s) => s.server === "acme-maya")!.computers).toEqual(["Laptop"]);
    // For a bot, blender is scoped out here, and the remote copy doesn't bring it back.
    expect(mcp.servers("bot").map((s) => s.server)).toEqual(["web", "acme-maya", "other-tool"]);
    // The listing: per-computer servers listed here, raw tools with their loading, scope; never web, never maya.
    const listing = mcp.listing();
    expect(listing.map((l) => l.server)).toEqual(["acme-blender"]);
    // The name round-trips: the served key is the plugin's and its own name's.
    expect(listing[0]!.name).toBe("blender");
    expect(pluginMcpServerKey(listing[0]!.plugin, listing[0]!.name)).toBe(listing[0]!.server);
    expect(listing[0]!.scope).toBe("agents");
    expect(listing[0]!.scope).toBe("agents");
    expect(listing[0]!.tools.map((t) => [t.name, t.load])).toEqual([["WebSearch", "preload"], ["WebFetch", "on-demand"], ["Later", "on-demand"]]);
    expect(Object.keys(listing[0]!.tools[0]!.inputSchema.properties ?? {})).not.toContain("computer");
  } finally {
    mcp.close();
  }
});

test("with no tick list from the host (no node yet), a per-computer server fails closed: it never starts, isn't listed or called", async () => {
  const registry = fakeRegistry([entry("acme", "blender", { type: "host", perComputer: true }), entry("clover", "web", { type: "host" })], { acme: "/nonexistent", clover: "/nonexistent" });
  const fake = fakeHost();
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio" });
  try {
    await mcp.refresh();
    expect(fake.opened.map((o) => o.server)).toEqual(["web"]);
    expect(mcp.placement("acme-blender")).toBeUndefined();
    await expect(mcp.call({ server: "acme-blender", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" })).rejects.toMatchObject({ code: "not_installed" });
    expect(fake.opened.map((o) => o.server)).toEqual(["web"]);
    // Still declared, for J's node to tick (localServers reads the registry).
    expect(mcp.localServers()).toEqual([{ server: "acme-blender", plugin: "acme" }]);
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

const names = (mcp: PluginMcp) => mcp.servers("agent").map((s) => s.server);

test("a third-party server is served under its plugin's key; a bundled one keeps its plain name", async () => {
  const registry = fakeRegistry([
    entry("clover", "web", { type: "host" }),
    entry("acme/tools", "blender", { type: "host" }),
  ], { clover: "/nonexistent", "acme/tools": "/nonexistent" });
  const fake = fakeHost();
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio" });
  try {
    await mcp.refresh();
    expect(names(mcp)).toEqual(["web", "acme-tools-blender"]);
    // The call reaches the plugin under its own server name.
    await mcp.call({ server: "acme-tools-blender", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" });
    expect(fake.opened.map((o) => [o.plugin, o.server])).toEqual([["clover", "web"], ["acme/tools", "blender"]]);
  } finally {
    mcp.close();
  }
});

test("a third-party `web` server can't take mcp__web__*, and a third-party `clover_core` or `clover` is refused", async () => {
  const registry = fakeRegistry([
    entry("acme", "web", { type: "host" }),
    entry("acme", "clover_core", { type: "host" }),
    entry("acme", "clover", { type: "host" }),
    entry("acme", "fine", { type: "host" }),
    entry("clover", "web", { type: "host" }),
  ], { clover: "/nonexistent", acme: "/nonexistent" });
  const lines: string[] = [];
  const fake = fakeHost();
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio", log: (l) => lines.push(l) });
  try {
    await mcp.refresh();
    expect(new Set(names(mcp))).toEqual(new Set(["web", "acme-fine"]));
    expect(mcp.servers("agent").find((s) => s.server === "web")!.plugin).toBe("clover");
    expect(lines.filter((l) => l.includes("refused"))).toHaveLength(3);
    expect(fake.opened.map((o) => o.plugin + "/" + o.server).sort()).toEqual(["acme/fine", "clover/web"]);
  } finally {
    mcp.close();
  }
});

test("every server key round-trips through a tool name, never holds `__`, and is a namespace; a name that gives none is refused", async () => {
  const { isServerKey } = await import("../../../src/runtime-sdk/turn-loop/plugin-mcp");
  const { mcpToolName, parseMcpToolName } = await import("../../../src/computers/mcp");
  const cases: [string, string, string][] = [["acme", "blender", "acme-blender"], ["pack/luna", "voice", "pack-luna-voice"], ["clover", "model-google", "clover-model-google"], ["a1", "b-2-c", "a1-b-2-c"]];
  for (const [plugin, name, want] of cases) {
    const key = pluginMcpServerKey(plugin, name)!;
    expect(key).toBe(want);
    expect(key).not.toContain("_");
    expect(isServerKey(key)).toBe(true);
    expect(parseMcpToolName(mcpToolName(key, "Some__Tool"))).toEqual({ server: key, tool: "Some__Tool" });
  }
  // A bundled server keeps its name; a name that isn't a namespace is refused, never escaped.
  expect(pluginMcpServerKey("clover", "web", true)).toBe("web");
  for (const bad of ["Blender", "big__server", "x.y", "_x", "x-", "", "ünï"]) expect(pluginMcpServerKey("acme", bad)).toBeUndefined();
  expect(pluginMcpServerKey("acme", "x".repeat(60))).toBeUndefined(); // past 64 characters
  for (const bad of ["a__b", "a_b", "_a", "a-", "A", "a--b", ""]) expect(isServerKey(bad)).toBe(false);
  // Served keys too: each one the registry gives round-trips, and a plugin whose server name gives no key is refused.
  const registry = fakeRegistry([
    entry("acme/tools", "big-server", { type: "host" }),
    entry("acme", "Big__Server", { type: "host" }),
    entry("clover", "web", { type: "host" }),
    entry("clover", "Not_A_Namespace", { type: "host" }),
  ], { "acme/tools": "/nonexistent", acme: "/nonexistent", clover: "/nonexistent" });
  const lines: string[] = [];
  const mcp = new PluginMcp({ registry, host: fakeHost().host, self: () => "Studio", log: (l) => lines.push(l) });
  try {
    await mcp.refresh();
    expect(new Set(names(mcp))).toEqual(new Set(["web", "acme-tools-big-server"]));
    for (const key of names(mcp)) expect(parseMcpToolName(mcpToolName(key, "T"))!.server).toBe(key);
    // The bot driver keeps them (its server names are namespaces): none refused on the way to the runtime.
    const { mergedServers } = await import("../../../src/runtime-sdk/turn-loop/driver");
    const driverRefused: string[] = [];
    expect(mergedServers(mcp.servers("agent"), (s) => driverRefused.push(s.server)).map((s) => s.server).sort()).toEqual(["acme-tools-big-server", "web"]);
    expect(driverRefused).toEqual([]);
    expect(lines.filter((l) => l.includes("refused"))).toHaveLength(2);
    // known(): the key and scope this registry gives a plugin's server; none for a refused or unknown one.
    // Neither is a per-computer server: known() answers nothing for them (see the known() test).
    expect(mcp.known("acme/tools", "big-server")).toBeUndefined();
    expect(mcp.known("clover", "web")).toBeUndefined();
  } finally {
    mcp.close();
  }
});

test("known(): only a per-computer server of a plugin installed, enabled, running and OK'd here, under a key no other plugin here reaches; never from the peer's strings", async () => {
  const pc = { type: "host", perComputer: true };
  const registry = fakeRegistry([
    entry("acme", "blender", { ...pc, scope: "agents" }),
    entry("acme", "plain", { type: "host" }),
    entry("a-b/c", "x", pc), // a-b-c-x
    entry("a/b-c", "x", pc), // a-b-c-x too: both refused
    entry("off", "s", pc),
    entry("found", "s", pc),
    entry("changed", "s", pc),
    entry("blocked", "s", pc),
    entry("clover", "studio", pc),
    entry("tree/kid", "s", pc),
    entry("stale/kid", "s", pc),
  ], { acme: "/n", "a-b/c": "/n", "a/b-c": "/n", off: "/n", found: "/n", changed: "/n", blocked: "/n", clover: "/n", tree: "/n", "tree/kid": "/n", stale: "/n", "stale/kid": "/n" }, {}, {
    "tree/kid": { okHash: undefined, treeHash: "kid-hash" },
    "stale/kid": { okHash: undefined },
    stale: { treeHash: "t2" },
    off: { enabled: false, state: "off" },
    found: { state: "found", okHash: undefined },
    changed: { treeHash: "t2" }, // its folder changed since the OK
    blocked: { state: "blocked" },
    clover: { okHash: undefined }, // bundled: the core's own
  });
  const mcp = new PluginMcp({ registry, host: fakeHost().host, self: () => "Studio" });
  try {
    await mcp.refresh();
    expect(mcp.known("acme", "blender")).toEqual({ server: "acme-blender", scope: "agents" });
    expect(mcp.known("clover", "studio")).toEqual({ server: "studio", scope: "both" });
    // Not per-computer, not that name, not installed here.
    expect(mcp.known("acme", "plain")).toBeUndefined();
    expect(mcp.known("acme", "Blender")).toBeUndefined();
    expect(mcp.known("acme", "blender-2")).toBeUndefined();
    expect(mcp.known("evil", "blender")).toBeUndefined();
    // Real ids whose keys meet: a-b/c + x and a/b-c + x are both a-b-c-x, so neither answers.
    expect(pluginMcpServerKey("a-b/c", "x")).toBe("a-b-c-x");
    expect(pluginMcpServerKey("a/b-c", "x")).toBe("a-b-c-x");
    expect(mcp.known("a-b/c", "x")).toBeUndefined();
    expect(mcp.known("a/b-c", "x")).toBeUndefined();
    // Off, never OK'd, changed since its OK, blocked: nothing.
    for (const p of ["off", "found", "changed", "blocked"]) expect(mcp.known(p, "s")).toBeUndefined();
    // A child carries no OK of its own: its tree's top-level plugin's OK covers it (and a stale tree OK doesn't).
    expect(mcp.known("tree/kid", "s")).toEqual({ server: "tree-kid-s", scope: "both" });
    expect(mcp.known("stale/kid", "s")).toBeUndefined();
  } finally {
    mcp.close();
  }
});

test("localServers: the per-computer servers of plugins enabled and OK'd here, running or not; never one not OK'd here", async () => {
  const pc = { type: "host", perComputer: true };
  const registry = fakeRegistry([
    entry("acme", "blender", pc),
    entry("synced", "maya", pc), // synced from another computer, not OK'd here
    entry("off", "x", pc),
    entry("tree/kid", "y", pc), // a child: its tree's OK covers it
    entry("acme", "notes", { type: "host" }), // not per-computer
  ], { acme: "/n", synced: "/n", off: "/n", tree: "/n", "tree/kid": "/n" }, {}, {
    synced: { state: "found", okHash: undefined },
    off: { enabled: false, state: "off" },
    "tree/kid": { okHash: undefined, treeHash: "kid" },
  });
  // No tick list: nothing runs, and the declared ones are still offered.
  const mcp = new PluginMcp({ registry, host: fakeHost().host, self: () => "Studio" });
  try {
    await mcp.refresh();
    expect(mcp.localServers()).toEqual([{ server: "acme-blender", plugin: "acme" }, { server: "tree-kid-y", plugin: "tree/kid" }]);
  } finally {
    mcp.close();
  }
});

test("stdio servers: opened through the launcher, local (ticked), framed like host servers; a stopped plugin keeps its listing and its calls say why", async () => {
  const registry = fakeRegistry([
    entry("acme", "files", { type: "stdio", command: "x", tools: { "*": "preload" } }),
    entry("clover", "web", { type: "host" }),
  ], { acme: "/nonexistent", clover: "/nonexistent" });
  const host = fakeHost();
  const launcher = fakeHost();
  let stopped: string | undefined;
  const stdio = { openMcp: async (plugin: string, server: string) => {
    if (stopped !== undefined) throw new ContractError("plugin_stopped", stopped);
    return launcher.host.openMcp(plugin, server);
  } };
  const running: Record<string, string[]> = { "acme-files": ["Studio"] };
  const mcp = new PluginMcp({ registry, host: host.host, self: () => "Studio", computers: (s) => running[s] ?? [], stdio });
  try {
    await mcp.refresh();
    // Through the launcher, never the plugin host; local, on the computers that tick it.
    expect(launcher.opened.map((o) => o.server)).toEqual(["files"]);
    expect(host.opened.map((o) => o.server)).toEqual(["web"]);
    expect(mcp.placement("acme-files")).toEqual({ name: "acme-files", kind: "local", computers: ["Studio"] });
    expect(mcp.localServers()).toEqual([{ server: "acme-files", plugin: "acme" }]);
    expect(mcp.servers("agent").find((s) => s.server === "acme-files")!.tools.every((t) => t.load === "preload")).toBe(true);
    expect(await mcp.call({ server: "acme-files", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" })).toEqual({ content: [{ type: "text", text: "ran WebSearch" }] });
    // It crashed too often: the launcher refuses with the reason. The listing stays, and a call answers the reason.
    launcher.opened[0]!.channel.kill();
    stopped = "plugin stopped: it crashed 3 times in 10 minutes";
    await mcp.refresh();
    expect(mcp.placement("acme-files")).toBeDefined();
    await expect(mcp.call({ server: "acme-files", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" })).rejects.toMatchObject({ code: "plugin_stopped", message: stopped });
    // Restarted: the next listing serves it again.
    stopped = undefined;
    await mcp.refresh();
    expect(await mcp.call({ server: "acme-files", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" })).toEqual({ content: [{ type: "text", text: "ran WebSearch" }] });
    // Unticked here: it doesn't start, as a per-computer host server.
    running["acme-files"] = [];
    await mcp.refresh();
    expect(mcp.placement("acme-files")).toBeUndefined();
  } finally {
    mcp.close();
  }
  // Without the launcher, a stdio entry isn't served here at all.
  const none = new PluginMcp({ registry, host: fakeHost().host, self: () => "Studio", computers: () => ["Studio"] });
  try {
    await none.refresh();
    expect(none.placement("acme-files")).toBeUndefined();
  } finally {
    none.close();
  }
});

test("two plugins that come to the same key are both refused, logged, never first wins", async () => {
  const registry = fakeRegistry([
    entry("acme", "x-y", { type: "host" }),
    entry("acme-x", "y", { type: "host" }),
    entry("other", "y", { type: "host" }),
  ], { acme: "/nonexistent", "acme-x": "/nonexistent", other: "/nonexistent" });
  const lines: string[] = [];
  const mcp = new PluginMcp({ registry, host: fakeHost().host, self: () => "Studio", log: (l) => lines.push(l) });
  try {
    await mcp.refresh();
    expect(names(mcp)).toEqual(["other-y"]);
    expect(lines.filter((l) => l.includes("acme-x-y"))).toHaveLength(2);
  } finally {
    mcp.close();
  }
});

test("after close(), refresh does nothing and a channel that opens late is closed at once", async () => {
  const entries = [entry("clover", "web", { type: "host" })];
  const registry = fakeRegistry(entries, { clover: "/nonexistent" });
  const fake = fakeHost();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  fake.gate(() => held);
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio" });
  const pending = mcp.refresh();
  await Bun.sleep(10);
  mcp.close();
  release();
  await pending;
  expect(fake.opened).toHaveLength(1);
  expect(fake.opened[0]!.channel.closed).toBe(true);
  expect(mcp.servers("bot")).toEqual([]);
  fake.gate(undefined);
  await mcp.refresh();
  registry.changed();
  await Bun.sleep(10);
  expect(fake.opened).toHaveLength(1);
  expect(mcp.servers("bot")).toEqual([]);
});

test("a call to a tool the server didn't list is refused", async () => {
  const mcp = new PluginMcp({ registry: fakeRegistry([entry("clover", "web", { type: "host" })], { clover: "/nonexistent" }), host: fakeHost().host, self: () => "Studio" });
  try {
    await mcp.refresh();
    await expect(mcp.call({ server: "web", tool: "Hidden", input: {}, as: BOT, session: "b_alpha" })).rejects.toMatchObject({ code: "not_found" });
  } finally {
    mcp.close();
  }
});

test("a result over 1 MiB is cut and says so", async () => {
  const fake = fakeHost();
  const mcp = new PluginMcp({ registry: fakeRegistry([entry("clover", "web", { type: "host" })], { clover: "/nonexistent" }), host: fake.host, self: () => "Studio" });
  try {
    await mcp.refresh();
    fake.big(3 * 1_048_576);
    const r = await mcp.call({ server: "web", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" });
    expect(JSON.stringify(r.content).length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
    expect(r.content.at(-1)).toEqual({ type: "text", text: expect.stringContaining("truncated") });
    expect(r.content).toHaveLength(2);
    fake.big(100);
    const small = await mcp.call({ server: "web", tool: "WebSearch", input: {}, as: BOT, session: "b_alpha" });
    expect(small.content).toEqual([{ type: "text", text: "x".repeat(100) }]);
  } finally {
    mcp.close();
  }
});

test("servers are listed at once; a hung one times out (open included), is reported and not served, the rest are", async () => {
  const registry = fakeRegistry([
    entry("clover", "web", { type: "host" }),
    entry("acme", "stuck", { type: "host" }),
    entry("acme", "ok", { type: "host" }),
  ], { clover: "/nonexistent", acme: "/nonexistent" });
  const fake = fakeHost();
  fake.gate((_p, server) => (server === "stuck" ? new Promise<void>(() => {}) : undefined));
  const lines: string[] = [];
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio", log: (l) => lines.push(l), listTimeoutMs: 150 });
  try {
    const t0 = Date.now();
    await mcp.refresh();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(new Set(names(mcp))).toEqual(new Set(["web", "acme-ok"]));
    expect(lines.some((l) => l.includes("acme/stuck") && l.includes("couldn't be listed"))).toBe(true);
  } finally {
    mcp.close();
  }
});

test("each server lists on its own: one installed while another hangs is served as soon as it answers; settled waits for its first listing, never for one that failed", async () => {
  const entries = [entry("clover", "web", { type: "host" })];
  const registry = fakeRegistry(entries, { clover: "/nonexistent", acme: "/nonexistent" });
  const fake = fakeHost();
  let releaseOk: () => void = () => {};
  const okGate = new Promise<void>((r) => { releaseOk = r; });
  fake.gate((_p, server) => (server === "web" ? new Promise<void>(() => {}) : server === "ok" ? okGate : undefined));
  const mcp = new PluginMcp({ registry, host: fake.host, self: () => "Studio", log: () => {}, listTimeoutMs: 400 });
  try {
    await mcp.refresh(); // web never answers: it fails at its limit
    expect(names(mcp)).toEqual([]);
    // A plugin is installed: the change relists web (which hangs again) and the new server, each on its own.
    entries.push(entry("acme", "ok", { type: "host" }));
    registry.changed();
    await Bun.sleep(20);
    // A turn starting now waits for the new server's first listing, never for web, which failed.
    const t0 = Date.now();
    const waited = mcp.settled(2_000);
    setTimeout(releaseOk, 100);
    await waited;
    expect(Date.now() - t0).toBeLessThan(350); // well before web's 400 ms limit: it never held the new one up
    expect(names(mcp)).toEqual(["acme-ok"]);
    // Nothing new pending: settled is immediate.
    const t1 = Date.now();
    await mcp.settled(2_000);
    expect(Date.now() - t1).toBeLessThan(50);
  } finally {
    mcp.close();
  }
}, 15_000);
