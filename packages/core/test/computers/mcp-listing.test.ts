// Another computer's local MCP servers, listed here (`mcp-listing.ts`): a bot on a computer that doesn't run a server
// still sees its tools, from a computer that does, and its call goes there. This computer's own listing wins; a
// listing is kept only for what that computer's hello names, and within bounds.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { FileMcpTicks, mcpTicksPath } from "../../src/computers/mcp-ticks";
import { kindServed, MCP_LIST_MAX_BYTES, MCP_LIST_MAX_TOOLS, MCP_LIST_SCHEMA_MAX_BYTES, MCP_LIST_SERVER_TEXT_MAX, parseMcpList, RemoteMcpListings, servedKinds, type KnownMcpPlugin, type McpListing } from "../../src/computers/mcp-listing";
import type { DeviceChange, DeviceRegistry } from "../../src/contracts/device-registry";
import type { LinkTransport } from "../../src/contracts/link-transport";
import { mcpToolName, parseMcpToolName, type McpResult, type McpServerPlacement } from "../../src/computers/mcp";
import { answersFor, makePhone } from "../tree/answer-support";
import { Cluster, until } from "../tree/cluster-support";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const BOT: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, inputSchema: { type: "object", properties: { scene: { type: "string" } } }, ...extra });

/** This computer's record in these tests: `acme/*` plugins are known, each server's key is its name, scope both. */
const known: KnownMcpPlugin = (plugin, name) => (plugin.startsWith("acme/") ? { server: name } : undefined);
const entry = (server: string, extra: Record<string, unknown> = {}) => ({ server, plugin: `acme/${server}`, name: server, scope: "both", tools: [tool("Render")], ...extra });

describe("parseMcpList", () => {
  test("keeps only the servers the hello names, each within bounds; a bad server or tool is left out, the rest stays", () => {
    const lines: string[] = [];
    const raw = {
      servers: [
        entry("blender", { scope: "bots", tools: [tool("Render", { load: "preload" }), tool("Render"), { name: "bad name!", inputSchema: { type: "object" } }, tool("Big", { inputSchema: { type: "object", x: "y".repeat(MCP_LIST_SCHEMA_MAX_BYTES) } }), tool("Arr", { inputSchema: [] })] }),
        entry("unnamed"),
        entry("many", { tools: Array.from({ length: MCP_LIST_MAX_TOOLS + 1 }, (_, i) => tool(`T${i}`)) }),
      ],
    };
    const out = parseMcpList(raw, ["blender", "many"], known, (l) => lines.push(l));
    // The peer's `preload` is its claim: every tool from elsewhere loads on demand.
    expect(out).toEqual([{ server: "blender", plugin: "acme/blender", name: "blender", scope: "bots", tools: [{ name: "Render", inputSchema: { type: "object", properties: { scene: { type: "string" } } }, load: "on-demand" }] }]);
    expect(lines.some((l) => l.includes("unnamed was left out"))).toBe(true);
    expect(lines.some((l) => l.includes("Render is listed twice"))).toBe(true);
  });

  test("a key must round-trip through mcp__<server>__<tool> and be the key this computer gives the plugin's server", () => {
    const names = ["foo__bar", "_x", "x_", "a_b", "Blender", "a--b", "-a", "../evil", "x".repeat(65)];
    for (const server of names) expect(parseMcpList({ servers: [entry(server, { plugin: "acme/x", name: server })] }, [server], () => ({ server }))).toEqual([]);
    // With a namespace for its server, every tool kept reads back as exactly that server and tool.
    const tools = parseMcpList({ servers: [entry("blender", { tools: [tool("a__b"), tool("_x"), tool("Render")] })] }, ["blender"], known)[0]!.tools.map((t) => t.name);
    expect(tools).toEqual(["a__b", "_x", "Render"]);
    for (const t of tools) expect(parseMcpToolName(mcpToolName("blender", t))).toEqual({ server: "blender", tool: t });
    // The plugin is a plugin id; an unknown plugin, or a key this computer wouldn't give it, is left out.
    expect(parseMcpList({ servers: [entry("blender", { plugin: "Acme_X" })] }, ["blender"], known)).toEqual([]);
    expect(parseMcpList({ servers: [entry("blender", { plugin: "evil/blender" })] }, ["blender"], known)).toEqual([]);
    expect(parseMcpList({ servers: [entry("blender", { name: "other" })] }, ["blender"], known)).toEqual([]);
    expect(parseMcpList({ servers: [{ ...entry("blender"), name: undefined }] }, ["blender"], known)).toEqual([]);
  });

  test("a key two plugins claim in one listing is left out for both", () => {
    const raw = { servers: [entry("blender"), entry("blender", { plugin: "acme/other" }), entry("paint")] };
    expect(parseMcpList(raw, ["blender", "paint"], (_p, name) => ({ server: name })).map((l) => l.server)).toEqual(["paint"]);
  });

  test("a server's text in all is bounded: over it, the server is left out, never cut", () => {
    // Each description is within its own cap; together they are over the server's.
    const d = "d".repeat(8000);
    const n = Math.floor(MCP_LIST_SERVER_TEXT_MAX / 8000);
    const raw = { servers: [entry("blender", { tools: Array.from({ length: n }, (_, i) => tool(`T${i}`, { description: d })), instructions: "x".repeat(MCP_LIST_SERVER_TEXT_MAX - n * 8000 + 1) }), entry("paint", { tools: Array.from({ length: n }, (_, i) => tool(`T${i}`, { description: d })) })] };
    expect(parseMcpList(raw, ["blender", "paint"], known).map((l) => l.server)).toEqual(["paint"]);
  });

  test("an answer that isn't a listing, or is too large, lists nothing", () => {
    expect(parseMcpList(null, ["blender"], known)).toEqual([]);
    expect(parseMcpList({ servers: "blender" }, ["blender"], known)).toEqual([]);
    const huge = { servers: [entry("blender", { instructions: "x".repeat(MCP_LIST_MAX_BYTES) })] };
    expect(parseMcpList(huge, ["blender"], known)).toEqual([]);
  });

  test("a schema's __proto__ key stays data: nothing's prototype changes", () => {
    const raw = JSON.parse('{"servers":[{"server":"blender","plugin":"acme/blender","name":"blender","scope":"both","tools":[{"name":"Render","inputSchema":{"type":"object","__proto__":{"polluted":true}}}]}]}');
    const out = parseMcpList(raw, ["blender"], known);
    expect(out[0]!.tools[0]!.name).toBe("Render");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((out[0]!.tools[0]!.inputSchema as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("servedKinds", () => {
  test("a missing scope serves no one; a scope is cut to this computer's record", () => {
    expect([...servedKinds(undefined, undefined)]).toEqual([]);
    expect([...servedKinds(undefined, { scope: "both" })]).toEqual([]);
    expect([...servedKinds("both", undefined)]).toEqual(["bots", "agents"]);
    expect([...servedKinds("both", {})]).toEqual(["bots", "agents"]);
    expect([...servedKinds("both", { scope: "agents" })]).toEqual(["agents"]);
    expect([...servedKinds("bots", { scope: "agents" })]).toEqual([]);
    expect(kindServed(servedKinds("bots", undefined), "side-thread")).toBe(true);
    expect(kindServed(servedKinds("bots", undefined), "coding")).toBe(false);
  });
});

describe("RemoteMcpListings: revokes and clashes", () => {
  /** A device list and a link of the test's own: each `mcp.list` answers when the test says. */
  function rig() {
    const watchers: ((c: DeviceChange) => void)[] = [];
    const revoked = new Set<string>();
    const devices = {
      get: (id: string) => ({ id, name: id, kind: "desktop", runsCore: true, ...(revoked.has(id) ? { revokedAt: 1 } : {}) }),
      watch: (fn: (c: DeviceChange) => void) => { watchers.push(fn); return () => {}; },
    } as unknown as DeviceRegistry;
    const pending: ((v: unknown) => void)[] = [];
    const transport = { connect: async () => ({ request: () => new Promise((res) => pending.push(res)) }) } as unknown as LinkTransport;
    const hellos: ((d: string) => void)[] = [];
    const listings = new RemoteMcpListings({ transport, devices, known: (_p, name) => ({ server: name }), named: () => ["blender"], onHello: (fn) => { hellos.push(fn); return () => {}; } });
    return {
      listings,
      revoke: (id: string) => { revoked.add(id); for (const w of watchers) w({ type: "revoked", id }); },
      repair: (id: string) => { revoked.delete(id); for (const w of watchers) w({ type: "added", device: devices.get(id)! }); },
      hello: (d: string) => { for (const h of hellos) h(d); },
      fetching: () => until(() => pending.length > 0, 2000, "the fetch"),
      answer: async (servers: unknown[] = [entry("blender")]) => { await until(() => pending.length > 0, 2000, "the fetch"); pending.shift()!({ servers }); await listings.idle(); },
      asked: () => pending.length,
    };
  }

  test("a stored listing goes at the revoke, and a later hello fetches nothing", async () => {
    const r = rig();
    r.hello("studio");
    await r.answer();
    expect(r.listings.listing("blender", ["studio"])?.plugin).toBe("acme/blender");
    r.revoke("studio");
    expect(r.listings.listing("blender", ["studio"])).toBeUndefined();
    expect([...r.listings.servers()]).toEqual([]);
    r.hello("studio");
    await new Promise((res) => setTimeout(res, 50));
    expect(r.asked()).toBe(0);
  });

  test("a device paired again under the same id is heard again", async () => {
    const r = rig();
    r.hello("studio");
    await r.answer();
    r.revoke("studio");
    r.repair("studio");
    r.hello("studio");
    await r.answer();
    expect(r.listings.listing("blender", ["studio"])?.plugin).toBe("acme/blender");
  });

  test("a fetch in flight at the revoke keeps nothing", async () => {
    const r = rig();
    r.hello("studio");
    await r.fetching();
    r.revoke("studio");
    await r.answer();
    expect(r.listings.listing("blender", ["studio"])).toBeUndefined();
    expect([...r.listings.servers()]).toEqual([]);
  });

  test("a key two computers give different plugins is listed from neither", async () => {
    const r = rig();
    r.hello("studio");
    await r.answer();
    r.hello("mini");
    await r.answer([entry("blender", { plugin: "acme/other" })]);
    expect(r.listings.listing("blender", ["studio", "mini"])).toBeUndefined();
    expect(r.listings.listing("blender", ["mini"])).toBeUndefined();
  });
});

describe("a local server another computer runs", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("Laptop1's bots see Studio's server from Studio's listing, and the call runs on Studio; Laptop1's own listing wins once it runs it; an untick takes it off", async () => {
    const phone = await makePhone();
    const homes = { Studio: temp("lane-j-listing-studio-"), Laptop1: temp("lane-j-listing-laptop-") };
    for (const h of Object.values(homes)) new FileMcpTicks(mcpTicksPath(h));
    const ticks = { Studio: new FileMcpTicks(mcpTicksPath(homes.Studio)), Laptop1: new FileMcpTicks(mcpTicksPath(homes.Laptop1)) };
    ticks.Studio.installed("acme/blender");
    ticks.Studio.installed("acme/coder");
    ticks.Studio.installed("acme/quiet");
    let clash = false;
    const calls: string[] = [];
    // What each computer's host runs (and so places and lists): only what's ticked there.
    const runs = (name: "Studio" | "Laptop1") => (s: string) => ticks[name].ticked(s, s === "blender" ? "acme/blender" : "acme/coder");
    const listing = (name: "Studio" | "Laptop1"): McpListing[] => ([
      { server: "blender", plugin: "acme/blender", name: "blender", tools: [{ name: "Render", description: `Render on ${name}`, inputSchema: { type: "object" }, load: "preload" }], instructions: "Blender's notes", scope: "both" },
      { server: "coder", plugin: "acme/coder", name: "coder", tools: [{ name: "Fix", inputSchema: { type: "object" } }], scope: "agents" },
      // No scope: it serves no one elsewhere.
      { server: "quiet", plugin: "acme/quiet", name: "quiet", tools: [{ name: "Hush", inputSchema: { type: "object" } }] },
    ] satisfies McpListing[]).filter((l) => runs(name)(l.server));
    cluster = new Cluster();
    const opts = {
      answers: () => answersFor(phone),
      askUser: () => phone.ask,
      mcp: (name: string) => {
        const n = name as "Studio" | "Laptop1";
        return {
          placement: (s: string): McpServerPlacement | undefined => (runs(n)(s) ? { name: s, kind: "local", computers: [] } : undefined),
          fields: () => ({}),
          call: async (c: { server: string; tool: string; input: Record<string, unknown> }): Promise<McpResult> => { calls.push(`${name} ${c.server}.${c.tool} ${JSON.stringify(c.input)}`); return { content: [{ type: "text", text: name }] }; },
          scratch: () => `home/${name}`,
          // `clash`: a local server on Laptop1 gives blender's key to another plugin.
          localServers: () => [{ server: "blender", plugin: "acme/blender" }, { server: "coder", plugin: "acme/coder" }, { server: "quiet", plugin: "acme/quiet" }, ...(clash && n === "Laptop1" ? [{ server: "blender", plugin: "acme/fake" }] : [])],
          listing: () => listing(n),
          known: (plugin: string, name: string) => (plugin.startsWith("acme/") ? { server: name } : undefined),
          ticks: ticks[n],
        };
      },
    };
    const studio = await cluster.add("Studio", opts);
    const laptop = await cluster.add("Laptop1", opts);
    await studio.node.registry.setLevel("Studio", "automatic", { via: "terminal" });
    await laptop.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" });
    await cluster.join();
    await until(() => laptop.node.mcpRemoteServers("bot").length === 1, 5000, "Laptop1 to list Studio's blender");
    // A bot gets blender (scope both), not coder (agents only); an agent gets both. Studio lists neither from others.
    expect(laptop.node.mcpRemoteServers("bot")).toEqual([{
      server: "blender", plugin: "acme/blender", instructions: "Blender's notes", computers: ["Studio"], reachable: true,
      tools: [{ name: "Render", description: "Render on Studio", inputSchema: { type: "object" }, load: "on-demand" }],
    }]);
    expect(laptop.node.mcpRemoteServers("coding").map((s) => s.server).sort()).toEqual(["blender", "coder"]);
    expect(studio.node.mcpRemoteServers("bot")).toEqual([]);
    // The call from Laptop1 runs on Studio.
    const ctx = { session: "s_alpha", as: BOT, callId: "c1" };
    const r = await laptop.node.mcp!.run("blender", "Render", { scene: "a" }, ctx);
    expect(r.computer).toBe("Studio");
    expect(calls).toEqual(['Studio blender.Render {"scene":"a"}']);
    // A local server here giving the key to another plugin: refused, not resolved.
    clash = true;
    expect(laptop.node.mcpRemoteServers("bot")).toEqual([]);
    expect(await laptop.node.mcp!.run("blender", "Render", {}, { ...ctx, callId: "c0" }).then(() => "ok", (e: { code?: string }) => e.code)).toBe("not_installed");
    clash = false;
    // Mirror ticks it on Laptop1: its own host now runs it, so it's no longer filled from Studio; Studio sees Laptop1's.
    expect(await studio.node.mirror("blender", null, ["Laptop1"], "s_alpha")).toEqual({ installed: ["Laptop1"], failed: [] });
    expect(laptop.node.mcpRemoteServers("bot")).toEqual([]);
    await until(() => studio.node.mcpRemoteServers("bot").length === 0 && studio.node.mcpComputers("blender").join() === "Studio,Laptop1", 5000, "Studio to hear Laptop1 runs blender");
    // Unticked on Laptop1 and on Studio: it runs nowhere, and Laptop1 lists nothing of it.
    laptop.node.mcpTicks.set("blender", false);
    await until(() => laptop.node.mcpRemoteServers("bot").length === 1, 5000, "Laptop1 to list Studio's blender again");
    studio.node.mcpTicks.set("blender", false);
    await until(() => laptop.node.mcpRemoteServers("coding").map((s) => s.server).join() === "coder", 5000, "Laptop1 to drop blender");
    expect(laptop.node.mcpRemoteServers("bot")).toEqual([]);
    expect(await laptop.node.mcp!.run("blender", "Render", {}, { ...ctx, callId: "c2" }).then(() => "ok", (e: { code?: string }) => e.code)).toBe("not_installed");
  }, 30_000);

  test("on two computers: the computer field lists both and the router reads it", async () => {
    const phone = await makePhone();
    const homes = { Studio: temp("lane-j-listing-s-"), Laptop1: temp("lane-j-listing-l-"), Mini: temp("lane-j-listing-m-") };
    for (const h of Object.values(homes)) new FileMcpTicks(mcpTicksPath(h));
    const ticks = Object.fromEntries(Object.entries(homes).map(([k, h]) => [k, new FileMcpTicks(mcpTicksPath(h))])) as Record<string, FileMcpTicks>;
    ticks.Studio!.installed("acme/blender");
    ticks.Mini!.installed("acme/blender");
    const calls: string[] = [];
    cluster = new Cluster();
    const opts = {
      answers: () => answersFor(phone),
      askUser: () => phone.ask,
      mcp: (name: string) => ({
        placement: (s: string): McpServerPlacement | undefined => (ticks[name]!.ticked(s, "acme/blender") ? { name: s, kind: "local", computers: [] } : undefined),
        fields: () => ({}),
        call: async (c: { server: string; tool: string; input: Record<string, unknown> }): Promise<McpResult> => { calls.push(`${name} ${JSON.stringify(c.input)}`); return { content: [] }; },
        scratch: () => `home/${name}`,
        localServers: () => [{ server: "blender", plugin: "acme/blender" }],
        known: (_plugin: string, n: string) => ({ server: n }),
        listing: (): McpListing[] => (ticks[name]!.ticked("blender", "acme/blender") ? [{ server: "blender", plugin: "acme/blender", name: "blender", scope: "both", tools: [{ name: "Render", inputSchema: { type: "object", properties: { computer: { type: "string" } } } }] }] : []),
        ticks: ticks[name]!,
      }),
    };
    for (const n of ["Studio", "Laptop1", "Mini"]) {
      const c = await cluster.add(n, opts);
      await c.node.registry.setLevel(n, "automatic", { via: "terminal" });
    }
    await cluster.join();
    const laptop = cluster.computers.get("Laptop1")!;
    await until(() => laptop.node.mcpRemoteServers("bot")[0]?.computers?.length === 2, 5000, "Laptop1 to list blender on both");
    const s = laptop.node.mcpRemoteServers("bot")[0]!;
    // The tool has its own `computer` field, so the placement's is `cloverComputer`.
    expect((s.tools[0]!.inputSchema.properties as Record<string, { enum?: string[] }>).cloverComputer!.enum).toEqual([...s.computers!]);
    expect(s.tools[0]!.inputSchema.required).toEqual(["cloverComputer"]);
    const r = await laptop.node.mcp!.run("blender", "Render", { cloverComputer: "Mini", computer: "x" }, { session: "s_alpha", as: BOT, callId: "c1" });
    expect(r.computer).toBe("Mini");
    expect(calls).toEqual(['Mini {"computer":"x"}']);
  }, 30_000);
});
