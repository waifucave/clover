// The tool setting (spec §6.7, G10), end to end over the real `PluginMcp`, the real store and the bridge's real listing: a tool
// the user turned OFF is in no model's tool list (a bot, a side thread, MOSS's own agent, an ACP agent through the bridge, the
// Glossary's index) and a call to it is refused with a plain reason, also by a session already running that cached its name;
// ON DEMAND is found through Glossary and not preloaded; ALWAYS ON is preloaded; the default is what the plugin declares and
// survives an update; the setting changes nothing about what raises a card; and only the user's own client sets it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import { pruneDroppedTools, pluginToolName, toolPermissionMethods, toolSettingFor } from "../../src/approvals/tool-permissions";
import { EngineToolSettings, toolOffMessage } from "../../src/approvals/tool-settings";
import type { BotSessionContext } from "../../src/bots/service";
import type { ConnectorPermissionSource } from "../../src/agent/mcp/connector-permissions";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { isContractError, Listeners } from "../../src/contracts/common";
import type { McpChannel } from "../../src/contracts/plugin-host";
import type { Contribution, PluginRecord, RegistryChange } from "../../src/contracts/plugin-registry";
import type { MethodContext } from "../../src/rpc/handler";
import { agentGlossary, agentPluginTools } from "../../src/agents/plugin-reach";
import type { AgentSessionFacts } from "../../src/agents/bridge/tools";
import { connectorPermissionTable, type Settings } from "../../src/settings";
import { localMcpRunner, PluginMcp } from "../../src/runtime-sdk/turn-loop/plugin-mcp";
import { routedMcpServer } from "../../src/runtime-sdk/turn-loop/servers";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const BOT: Caller = { kind: "session", sessionId: "s_bot", sessionKind: "bot", bot: "luna" } as unknown as Caller;
const KINDS = ["bot", "side-thread", "agent", "coding"] as const;
const ACME = "acme-blender";

/** A host whose servers list the tools `toolsOf` names, and answer a call with `ran <tool>`. */
function fakeHost(toolsOf: (server: string) => string[]) {
  const calls: string[] = [];
  const host = {
    async openMcp(_plugin: string, server: string): Promise<McpChannel> {
      const out = new Listeners<Record<string, unknown>>();
      const reply = (m: Record<string, unknown>) => queueMicrotask(() => out.emit(m));
      return {
        send(m: Record<string, unknown>) {
          if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } } });
          else if (m.method === "tools/list") reply({ jsonrpc: "2.0", id: m.id, result: { tools: toolsOf(server).map((name) => ({ name, description: `${name} does its work.`, inputSchema: { type: "object" } })) } });
          else if (m.method === "tools/call") {
            const name = (m.params as { name: string }).name;
            calls.push(name);
            reply({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `ran ${name}` }] } });
          }
        },
        onMessage: (fn: (m: Record<string, unknown>) => void) => out.add(fn),
        close() {},
        get closed() { return false; },
      } as unknown as McpChannel;
    },
  };
  return { host, calls };
}

const entry = (pluginId: string, name: string, tools: Record<string, string>): Contribution =>
  ({ point: "mcpServers", pluginId, ref: `mcpServers/${name}`, entryId: name, value: { name, type: "host", tools }, state: "active" }) as Contribution;

/** The real `PluginMcp` over a fake registry and host, the real store over in-memory settings, wired as the daemon wires them. */
async function world(declared: { web: Record<string, string>; blender: Record<string, string> } = { web: { WebSearch: "preload", WebFetch: "preload" }, blender: { Render: "preload", Export: "on-demand" } }, withSetting = true) {
  const entries = [entry("moss", "web", declared.web), entry("acme", "blender", declared.blender)];
  const folder = mkdtempSync(join(tmpdir(), "moss-ts-"));
  temps.push(folder);
  const watchers = new Listeners<RegistryChange>();
  const registry = {
    entries: (point: string) => (point === "mcpServers" ? entries : []),
    get: (id: string) => ({ id, source: id === "moss" ? "bundled" : "user", folder, enabled: true, state: "running", treeHash: "t", okHash: "t" } as unknown as PluginRecord),
    list: () => [] as PluginRecord[],
    points: () => [],
    watch: (fn: (c: RegistryChange) => void) => watchers.add(fn),
  };
  let blenderTools = ["Render", "Export"];
  const { host, calls } = fakeHost((server) => (server === "web" ? ["WebSearch", "WebFetch"] : blenderTools));
  let settings = {} as Settings;
  let file = settings; // the settings file: a write reaches it at once, and the live copy only when the watcher swaps it
  const saves: Settings[] = [];
  const events: unknown[] = [];
  let mcp!: PluginMcp;
  const store = new EngineToolSettings({
    read: () => settings, load: () => file, save: (next) => { settings = next; file = next; saves.push(next); },
    listing: () => mcp.toolListing(), emit: (e) => events.push(e),
  });
  mcp = new PluginMcp({ registry: registry as never, host: host as never, self: () => "Studio", ...(withSetting ? { availability: (s: string, t: string) => store.availabilityOf(s, t) } : {}) });
  await mcp.refresh();
  return {
    mcp, store, calls, events, saves, settings: () => settings, setSettings: (s: Settings) => { settings = s; file = s; }, setLive: (s: Settings) => { settings = s; },
    /** What the plugin declares changes (an update of the plugin), and the registry says so. */
    redeclare: async (blender: Record<string, string>, listed?: string[]) => {
      (entries[1]!.value as { tools: unknown }).tools = blender;
      if (listed !== undefined) blenderTools = listed;
      await mcp.relist("acme", ["blender"]);
    },
    loads: (kind: (typeof KINDS)[number], server = ACME) => Object.fromEntries((mcp.servers(kind).find((s) => s.server === server)?.tools ?? []).map((t) => [t.name, t.load])),
    close: () => mcp.close(),
  };
}

describe("off: in no model's list, and a call is refused", () => {
  test("a tool set to off is left out for a bot, a side thread, MOSS's own agent and an ACP agent, and out of every Glossary", async () => {
    const w = await world();
    try {
      for (const kind of KINDS) expect([kind, Object.keys(w.loads(kind))]).toEqual([kind, ["Render", "Export"]]);
      w.store.setAvailability(ACME, "Export", "off");
      for (const kind of KINDS) expect([kind, Object.keys(w.loads(kind))]).toEqual([kind, ["Render"]]);
      // The bridge an ACP agent (and MOSS's own coding agent, through the in-process bridge) is handed, and its Glossary.
      const session: AgentSessionFacts = { id: "a1", kind: "agent", backend: "codex", bot: "luna", computer: "Studio", root: "/tmp" };
      const reach = { servers: (k: "agent" | "coding", b: string, bot?: string, o?: { keepOff?: boolean }) => w.mcp.servers(k, b, bot, o), runner: localMcpRunner(w.mcp, () => "Studio"), judge: async () => ({ allowed: true as const, input: {} }), registry: { entries: () => [], get: () => undefined, list: () => [], points: () => [] } };
      const listed = (await agentPluginTools(reach as never).tools("a1", session)).map((t) => t.name);
      expect(listed).toContain(`${ACME}__Render`);
      expect(listed).not.toContain(`${ACME}__Export`);
      const found = await agentGlossary(reach as never)("a1", { query: "Export" }, session);
      expect(JSON.stringify(found)).not.toContain("Export");
      // On again: it is back, in the same places.
      w.store.setAvailability(ACME, "Export", "on-demand");
      expect(Object.keys(w.loads("bot"))).toEqual(["Render", "Export"]);
    } finally {
      w.close();
    }
  });

  test("a direct call is refused with a plain reason that says off, not blocked, and the plugin never runs", async () => {
    const w = await world();
    try {
      w.store.setAvailability(ACME, "Export", "off");
      let err: unknown;
      try { await w.mcp.call({ server: ACME, tool: "Export", input: {}, as: BOT, session: "s_bot" }); } catch (e) { err = e; }
      expect(isContractError(err, "refused")).toBe(true);
      expect((err as Error).message).toBe(toolOffMessage(pluginToolName(ACME, "Export")));
      expect((err as Error).message).toContain("turned the tool mcp__acme-blender__Export off in Settings");
      expect((err as Error).message).not.toContain("blocked");
      expect(w.calls).toEqual([]);
      // A tool still on runs as before.
      await w.mcp.call({ server: ACME, tool: "Render", input: {}, as: BOT, session: "s_bot" });
      expect(w.calls).toEqual(["Render"]);
    } finally {
      w.close();
    }
  });

  test("a session already running that cached the name earlier is refused too, even over a stored Always allow: a bot's runtime, an ACP agent's bridge, the approval check", async () => {
    const w = await world();
    try {
      // The runtime's list, made while the tool was on: it keeps calling it by name.
      const cached = w.mcp.servers("bot").find((s) => s.server === ACME)!;
      expect(cached.tools.map((t) => t.name)).toContain("Export");
      const server = routedMcpServer({ server: cached, runner: localMcpRunner(w.mcp, () => "Studio"), session: "s_bot", as: BOT });
      const ok = await (server as { instance: { callTool(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: { text: string }[] }> } }).instance.callTool("Export", {});
      expect(ok.isError).toBe(false);
      // The agent's bridge listed it at the start too.
      const session: AgentSessionFacts = { id: "a1", kind: "agent", backend: "codex", bot: "luna", computer: "Studio", root: "/tmp" };
      let judged = 0;
      const reach = { servers: (k: "agent" | "coding", b: string, bot?: string, o?: { keepOff?: boolean }) => w.mcp.servers(k, b, bot, o), runner: localMcpRunner(w.mcp, () => "Studio"), judge: async () => (judged++, { allowed: true as const, input: {} }), registry: { entries: () => [], get: () => undefined, list: () => [], points: () => [] } };
      const bridge = agentPluginTools(reach as never);
      expect((await bridge.call("a1", { callId: "c1", tool: `${ACME}__Export`, input: {} }, { computer: "Studio", origin: "agent", session })).isError).toBe(false);
      // The user stored Always allow, then turned the tool off.
      w.store.setPermission(ACME, "Export", "allow");
      w.store.setAvailability(ACME, "Export", "off");
      w.calls.length = 0;
      const refused = await (server as { instance: { callTool(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: { text: string }[] }> } }).instance.callTool("Export", {});
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain("turned the tool mcp__acme-blender__Export off in Settings");
      const viaBridge = await bridge.call("a1", { callId: "c2", tool: `${ACME}__Export`, input: {} }, { computer: "Studio", origin: "agent", session });
      expect(viaBridge.isError).toBe(true);
      expect(JSON.stringify(viaBridge.content)).toContain("turned the tool mcp__acme-blender__Export off in Settings");
      expect(judged).toBe(1);
      // The bots' approval check says so before anything else, whatever the permission.
      const source: ConnectorPermissionSource = { table: () => connectorPermissionTable(w.settings()), readOnly: () => undefined };
      const verdict = toolSettingFor(source, w.mcp.toolListing(), pluginToolName(ACME, "Export"), (s, t) => w.store.availabilityOf(s, t));
      expect(verdict).toEqual({ setting: "deny", message: toolOffMessage(pluginToolName(ACME, "Export")) });
      expect(w.calls).toEqual([]);
    } finally {
      w.close();
    }
  });
});

describe("on demand and always on", () => {
  test("on demand is behind Glossary and not preloaded; always on is preloaded; each follows the user, whatever the plugin declared", async () => {
    const w = await world();
    try {
      // Declared: Render preload, Export on demand: the defaults.
      for (const kind of KINDS) expect(w.loads(kind)).toEqual({ Render: "preload", Export: "on-demand" });
      w.store.setAvailability(ACME, "Render", "on-demand");
      w.store.setAvailability(ACME, "Export", "always");
      for (const kind of KINDS) expect(w.loads(kind)).toEqual({ Render: "on-demand", Export: "preload" });
      // On demand is found (and loaded) through the bridge's Glossary; the preloaded one is offered at once.
      const session: AgentSessionFacts = { id: "a1", kind: "coding", backend: "codex", computer: "Studio", root: "/tmp" };
      const reach = { servers: (k: "agent" | "coding", b: string, bot?: string, o?: { keepOff?: boolean }) => w.mcp.servers(k, b, bot, o), runner: localMcpRunner(w.mcp, () => "Studio"), judge: async () => ({ allowed: true as const, input: {} }), registry: { entries: () => [], get: () => undefined, list: () => [], points: () => [] } };
      const tools = await agentPluginTools(reach as never).tools("a1", session);
      expect(tools.find((t) => t.name === `${ACME}__Render`)?.preload).toBeUndefined();
      expect(tools.find((t) => t.name === `${ACME}__Export`)?.preload).toBe(true);
      const found = await agentGlossary(reach as never)("a1", { query: "Render", load: `${ACME}__Render` }, session);
      expect(JSON.stringify(found)).toContain(`${ACME}__Render`);
    } finally {
      w.close();
    }
  });

  test("a whole server's value covers the tools it lists now; one the plugin adds later starts at its own declared default", async () => {
    const w = await world();
    try {
      w.store.setAvailability(ACME, undefined, "off");
      expect(w.loads("bot")).toEqual({});
      // Every tool off: the server itself is not offered.
      for (const kind of KINDS) expect(w.mcp.servers(kind).map((s) => s.server)).toEqual(["web"]);
      await w.redeclare({ Render: "preload", Export: "on-demand", Bake: "preload" }, ["Render", "Export", "Bake"]);
      expect(w.store.list().filter((r) => r.server === ACME).map((r) => [r.tool, r.availability])).toEqual([["Bake", "always"], ["Export", "off"], ["Render", "off"]]);
      expect(w.loads("bot")).toEqual({ Bake: "preload" });
    } finally {
      w.close();
    }
  });
});

describe("the default is what the plugin declares, and it survives an update", () => {
  test("with nothing stored the tool follows its declaration, and a changed declaration moves it", async () => {
    const w = await world();
    try {
      expect(w.store.row(ACME, "Render")).toMatchObject({ declared: "preload", availability: "always", permission: "ask" });
      expect(w.store.row(ACME, "Export")).toMatchObject({ declared: "on-demand", availability: "on-demand" });
      await w.redeclare({ Render: "on-demand", Export: "preload" });
      expect(w.store.row(ACME, "Render")).toMatchObject({ declared: "on-demand", availability: "on-demand" });
      expect(w.store.row(ACME, "Export")).toMatchObject({ declared: "preload", availability: "always" });
      expect(w.loads("bot")).toEqual({ Render: "on-demand", Export: "preload" });
      expect(w.settings().mcp?.toolAvailability).toBeUndefined();
    } finally {
      w.close();
    }
  });

  test("what the user chose stays through an update of the plugin and its re-listing; it goes only with the tool or the plugin", async () => {
    const w = await world();
    try {
      w.store.setAvailability(ACME, "Render", "off");
      w.store.setAvailability(ACME, "Export", "always");
      await w.redeclare({ Render: "preload", Export: "preload" });
      expect(w.store.row(ACME, "Render")).toMatchObject({ declared: "preload", availability: "off" });
      expect(w.store.row(ACME, "Export")).toMatchObject({ declared: "preload", availability: "always" });
      // The listing the Tools tab prunes by still names both: nothing is dropped.
      expect(pruneDroppedTools(w.settings(), w.mcp.toolListing())).toBeUndefined();
      // A tool the plugin stops listing takes its value with it; listed again it starts at its declared default.
      const dropped = pruneDroppedTools(w.settings(), [{ server: ACME, tools: [{ name: "Render" }] }]);
      expect(dropped).toBeDefined();
      w.setSettings(dropped!);
      expect(w.store.availabilityOf(ACME, "Export")).toBeUndefined();
      expect(w.store.availabilityOf(ACME, "Render")).toBe("off");
      // The plugin's uninstall clears every value its servers held.
      const { dropPluginServers } = await import("../../src/approvals/tool-permissions");
      w.setSettings(dropPluginServers(w.settings(), "acme")!);
      expect(w.store.availabilityOf(ACME, "Render")).toBeUndefined();
    } finally {
      w.close();
    }
  });

  test("with nothing stored the offered list is exactly what it was before the setting existed (no option, no change)", async () => {
    const withIt = await world();
    const without = await world(undefined, false);
    try {
      for (const kind of KINDS) expect(withIt.mcp.servers(kind)).toEqual(without.mcp.servers(kind));
    } finally {
      withIt.close();
      without.close();
    }
  });
});

describe("what raises a card is not changed by the setting", () => {
  const ctx = { botId: "luna", sessionId: "s1", kind: "bot", computer: "Studio", paths: { scratch: "/tmp" }, caller: BOT } as unknown as BotSessionContext;
  const run = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
  const BUNDLED = ["mcp__web__WebSearch", "mcp__web__WebFetch"];

  test("a bundled tool's row reads Ask with nothing stored, and the approval check judges it as it did without the setting, at any availability but off", async () => {
    const w = await world();
    try {
      for (const t of ["WebSearch", "WebFetch"]) expect(w.store.row("web", t)).toMatchObject({ permission: "ask", declared: "preload", availability: "always" });
      const source: ConnectorPermissionSource = { table: () => connectorPermissionTable(w.settings()), readOnly: () => undefined };
      const decide = async (hook: boolean, tool: string) => {
        const requests: ApprovalRequest[] = [];
        const recorder = { request: async (r: ApprovalRequest) => (requests.push(structuredClone(r)), { allowed: true, by: "level" } as never) };
        const check = botApprovalCheck(recorder, {
          ...(hook ? { toolSetting: (_c: BotSessionContext, name: string) => toolSettingFor(source, w.mcp.toolListing(), name, (s, t) => w.store.availabilityOf(s, t)) } : {}),
        });
        const result = await check(ctx, () => "user")(tool, { query: "moss" }, run);
        return { result, requests };
      };
      for (const tool of BUNDLED) {
        const before = await decide(false, tool);
        // The hook the daemon installs, with nothing stored: nothing differs.
        expect(await decide(true, tool)).toEqual(before);
        // Whatever availability the user picked (but off) leaves what a call raises unchanged.
        for (const a of ["on-demand", "always"] as const) {
          w.store.setAvailability("web", undefined, a);
          expect([a, await decide(true, tool)]).toEqual([a, before]);
        }
        w.store.setAvailability("web", undefined, "off");
        expect((await decide(true, tool)).result).toMatchObject({ behavior: "deny" });
        w.setSettings({} as Settings);
      }
    } finally {
      w.close();
    }
  });
});

describe("only the user's own client sets it", () => {
  const caller = (c: Caller): MethodContext => ({ caller: c });
  const USER = caller({ kind: "user", client: "app" } as Caller);

  test("a plugin, a bot, an agent, a peer and the core are each refused, and the user's own press is served", async () => {
    const w = await world();
    try {
      const methods = toolPermissionMethods({
        listing: () => w.mcp.toolListing(), toolSettings: w.store, pluginName: () => "Blender",
        loadSettings: () => w.settings(), saveSettings: (n) => w.setSettings(n), savedFor: () => [], forgetSaved: () => 0,
      });
      const call = (ctx: MethodContext) => methods["tool.setAvailability"]!({ server: ACME, tool: "Export", availability: "always" }, ctx);
      const others: [string, Caller][] = [
        ["a plugin", { kind: "plugin", pluginId: "acme" } as Caller],
        ["a bot", { kind: "session", sessionId: "s_bot", sessionKind: "bot", bot: "luna" } as Caller],
        ["an agent", { kind: "session", sessionId: "s_agent", sessionKind: "agent", bot: "luna" } as Caller],
        ["a coding agent", { kind: "session", sessionId: "s_code", sessionKind: "coding" } as Caller],
        ["a peer", { kind: "peer", device: "dev_1" } as Caller],
        ["the core", { kind: "core" } as Caller],
      ];
      for (const [who, c] of others) {
        const err = await call(caller(c)).then(() => undefined, (e: unknown) => e);
        expect([who, (err as { message?: string } | undefined)?.message]).toEqual([who, "only the user can set a tool's availability"]);
      }
      expect(w.store.availabilityOf(ACME, "Export")).toBeUndefined();
      expect(w.events).toEqual([]);
      expect(await call(USER)).toEqual({ ok: true });
      expect(w.store.availabilityOf(ACME, "Export")).toBe("always");
      // One event, naming the tool and the value and nothing of the plugin's own words.
      expect(w.events).toEqual([{ type: "tool_settings_changed", server: ACME, tool: "Export", availability: "always" }]);
      // An unknown plugin or tool is refused, and `*` is not a tool.
      for (const bad of [{ server: "ghost", availability: "off" }, { server: ACME, tool: "Nope", availability: "off" }, { server: ACME, tool: "*", availability: "off" }]) {
        await expect(methods["tool.setAvailability"]!(bad, USER)).rejects.toThrow();
      }
      // The Settings rows carry both values, each its own.
      const rows = (await methods["tool.permissions"]!({}, USER)) as { plugins: { server: string; tools: { name: string; permission: string; availability: string; declared: string }[] }[] };
      expect(rows.plugins.find((p) => p.server === ACME)!.tools).toEqual([
        expect.objectContaining({ name: "Render", permission: "ask", availability: "always", declared: "preload" }),
        expect.objectContaining({ name: "Export", permission: "ask", availability: "always", declared: "on-demand" }),
      ]);
    } finally {
      w.close();
    }
  });
});

describe("set, then send at once: the next turn's list has the new value", () => {
  test("with no wait, and with the settings watcher's late reload of the older file between the press and the turn", async () => {
    const w = await world();
    try {
      const older = w.settings();
      w.store.setAvailability(ACME, "Export", "off");
      expect(Object.keys(w.loads("bot"))).toEqual(["Render"]);
      w.setLive({ ...older }); // the watcher swaps in a reload of the file as it was before the press
      expect(Object.keys(w.loads("bot"))).toEqual(["Render"]);
      expect(await w.mcp.call({ server: ACME, tool: "Export", input: {}, as: BOT, session: "s_bot" }).then(() => "ran", (e: Error) => e.message)).toContain("turned the tool");
      w.setLive({ ...w.saves[0]! }); // the watcher catches up to the press
      w.store.setAvailability(ACME, "Export", "on-demand");
      w.setLive({ ...w.saves[0]! }); // a late reload again, of the state before the second press
      expect(w.loads("bot")).toEqual({ Render: "preload", Export: "on-demand" });
    } finally {
      w.close();
    }
  });
});

describe("a press of the user's stands until the live settings have caught up to it", () => {
  // The settings watcher's reload of the file as it was a moment before a write can land after the write. A turn that
  // starts then must still be offered the tool as the user just set it (found on the acceptance row: on demand set, a message
  // sent at once, the model's list still carried the old value).
  function store() {
    let file = {} as Settings;
    let live = file;
    const s = new EngineToolSettings({
      read: () => live, load: () => file, save: (n) => { file = n; },
      listing: () => [{ server: "acme", plugin: "acme", tools: [{ name: "Export", declared: "preload" }] }],
    });
    return { s, file: () => file, setFile: (x: Settings) => { file = x; }, setLive: (x: Settings) => { live = x; } };
  }
  const ask = (s: EngineToolSettings) => s.availabilityOf("acme", "Export");

  test("a live copy that is OLDER than the write does not undo it", () => {
    const w = store();
    const older = {} as Settings;
    w.s.setAvailability("acme", "Export", "off");
    expect(ask(w.s)).toBe("off");
    w.setLive(older); // the late reload of the file as it was before the write: a new object, none of the choice
    expect(ask(w.s)).toBe("off");
    w.s.setAvailability("acme", "Export", "on-demand");
    w.setLive({ ...older }); // and again, now with the second press
    expect(ask(w.s)).toBe("on-demand");
    expect(w.s.row("acme", "Export")?.availability).toBe("on-demand");
  });

  test("once the live copy carries the write, the live copy is what is read (an edit by hand after it counts)", () => {
    const w = store();
    w.s.setAvailability("acme", "Export", "off");
    w.setLive({ ...w.file() }); // the watcher caught up
    expect(ask(w.s)).toBe("off");
    const edited = { ...w.file(), mcp: { ...(w.file().mcp ?? {}), toolAvailability: { acme: { Export: "always" } } } } as Settings;
    w.setLive(edited);
    expect(ask(w.s)).toBe("always");
  });

  test("a file that someone else changed since the write is not ours to stand in for: the live copy is read", () => {
    const w = store();
    w.s.setAvailability("acme", "Export", "off");
    w.setLive({} as Settings);
    expect(ask(w.s)).toBe("off"); // the file still has the press
    w.setFile({} as Settings); // an edit by hand, or another writer: the file no longer has it
    expect(ask(w.s)).toBeUndefined();
  });

  test("a write made elsewhere (a plugin dropped) is told to the store and read the same way", () => {
    const w = store();
    w.s.setAvailability("acme", "Export", "off");
    const cleared = {} as Settings;
    w.s.noteWritten(cleared);
    w.setLive({} as Settings);
    expect(ask(w.s)).toBeUndefined();
  });
});
