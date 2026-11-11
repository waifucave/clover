// A plugin's display-only tools through a bot's approval check: the router binds a call to the plugin, server and tool
// it really reaches (never by splitting its name), the check asks the daemon's predicate at each call, and a hit is a
// contained `other` call: allowed at the default level, a card at "ask", refused at read-only, after the broker's
// earlier rules.
import { expect, test } from "bun:test";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import type { BotSessionContext } from "../../src/bots/service";
import { Listeners } from "../../src/contracts/common";
import { levelDecision, type ApprovalRequest } from "../../src/contracts/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { McpChannel } from "../../src/contracts/plugin-host";
import type { Contribution } from "../../src/contracts/plugin-registry";
import { PluginMcp } from "../../src/runtime-sdk/turn-loop/plugin-mcp";

const ctx = { botId: "luna", sessionId: "s1", kind: "bot", computer: "Studio", paths: { scratch: "/tmp" }, caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } } as unknown as BotSessionContext;
const run = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };

/** A host whose servers list the tools `toolsOf` names. */
function host(toolsOf: (server: string) => string[]) {
  return {
    async openMcp(_plugin: string, server: string): Promise<McpChannel> {
      const out = new Listeners<Record<string, unknown>>();
      const reply = (m: Record<string, unknown>) => queueMicrotask(() => out.emit(m));
      return {
        send(m: Record<string, unknown>) {
          if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } } });
          else if (m.method === "tools/list") reply({ jsonrpc: "2.0", id: m.id, result: { tools: toolsOf(server).map((name) => ({ name, inputSchema: { type: "object" } })) } });
        },
        onMessage: (fn: (m: Record<string, unknown>) => void) => out.add(fn),
        close() {},
        get closed() { return false; },
      } as unknown as McpChannel;
    },
  };
}

const entry = (pluginId: string, name: string): Contribution =>
  ({ point: "mcpServers", pluginId, ref: `mcpServers/${name}`, entryId: name, value: { name, type: "host" }, state: "active" }) as Contribution;

test("routedTool binds a call to the plugin and server it reaches by the served name, never by splitting it", async () => {
  const entries = [entry("acme/tools", "stage"), entry("acme", "tools-stage"), entry("clover", "web")];
  const registry = {
    entries: (point: string) => (point === "mcpServers" ? entries : []),
    get: (id: string) => ({ id, source: id === "clover" ? "bundled" : "user", folder: "/nonexistent", enabled: true, state: "running" }),
    watch: () => () => {},
  };
  const mcp = new PluginMcp({ registry: registry as never, host: host((s) => (s === "web" ? ["WebSearch"] : ["set_mood"])) as never, self: () => "Studio" });
  try {
    await mcp.refresh();
    const served = mcp.servers("bot").map((s) => s.server);
    // `acme/tools`'s `stage` and `acme`'s `tools-stage` would both mint `acme-tools-stage`: the router serves neither.
    expect(served).not.toContain("acme-tools-stage");
    expect(mcp.routedTool("bot", "mcp__acme-tools-stage__set_mood")).toBeUndefined();
    expect(mcp.routedTool("bot", "mcp__web__WebSearch")).toEqual({ plugin: "clover", server: "web", tool: "WebSearch" });
    // A name the router never served routes nowhere.
    for (const crafted of ["mcp__web__set_mood", "mcp__web__WebSearch ", "web__WebSearch", "mcp__web__"]) expect([crafted, mcp.routedTool("bot", crafted)]).toEqual([crafted, undefined]);
  } finally {
    mcp.close();
  }
  const one = [entry("acme", "stage")];
  const lone = new PluginMcp({
    registry: { entries: (p: string) => (p === "mcpServers" ? one : []), get: (id: string) => ({ id, source: "user", folder: "/nonexistent", enabled: true, state: "running" }), watch: () => () => {} } as never,
    host: host(() => ["set_mood"]) as never, self: () => "Studio",
  });
  try {
    await lone.refresh();
    const s = lone.servers("bot")[0]!;
    expect(lone.routedTool("bot", `mcp__${s.server}__set_mood`)).toEqual({ plugin: "acme", server: "stage", tool: "set_mood" });
  } finally {
    lone.close();
  }
});

test("the check marks a routed display-only tool contained, at each call; nothing else is", async () => {
  const requests: ApprovalRequest[] = [];
  const recorder = { request: async (r: ApprovalRequest) => (requests.push(structuredClone(r)), { allowed: true, by: "level" } as never) };
  let asked = 0;
  let declared = true;
  const check = botApprovalCheck(recorder, {
    hostTools: () => ["SendMessage", "Agent"],
    containedTool: (_c, tool) => (asked++, declared && tool === "mcp__acme-stage__set_mood"),
  });
  const call = async (tool: string) => {
    requests.length = 0;
    await check(ctx, () => "user")(tool, {}, run);
    return requests[0]!;
  };
  expect(await call("mcp__acme-stage__set_mood")).toMatchObject({ effect: "other", contained: true });
  expect((await call("mcp__acme-stage__wipe")).contained).toBeUndefined();
  // The host's own tools are judged by their own rules, never by a plugin's list.
  expect(await call("Agent")).toMatchObject({ contained: true });
  // Asked again at each call: an OK withdrawn since (or a dev folder over the plugin) counts at once.
  const before = asked;
  declared = false;
  expect((await call("mcp__acme-stage__set_mood")).contained).toBeUndefined();
  expect(asked).toBe(before + 1);
});

test("a contained tool call runs at the default level and above, asks at ask, and is refused at read-only", async () => {
  expect(levelDecision("ask-risky", "other", false, true)).toBe("allow");
  expect(levelDecision("accept-edits", "other", false, true)).toBe("allow");
  expect(levelDecision("automatic", "other", false, true)).toBe("allow");
  expect(levelDecision("ask", "other", false, true)).toBe("ask");
  expect(levelDecision("read-only", "other", false, true)).toBe("deny");
  // Through the real broker at the default level: no card.
  const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "ask-risky", localComputer: "Studio" });
  const check = botApprovalCheck(broker, { containedTool: (_c, tool) => tool === "mcp__acme-stage__set_mood" });
  expect(await check(ctx, () => "user")("mcp__acme-stage__set_mood", { mood: "sunny" }, run)).toMatchObject({ behavior: "allow" });
  const readOnly = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "read-only", localComputer: "Studio" });
  const refused = botApprovalCheck(readOnly, { containedTool: () => true });
  expect(await refused(ctx, () => "user")("mcp__acme-stage__set_mood", {}, run)).toMatchObject({ behavior: "deny" });
});
