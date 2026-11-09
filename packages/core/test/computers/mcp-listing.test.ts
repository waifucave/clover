// Another computer's local MCP servers, listed here (`mcp-listing.ts`): a bot on a computer that doesn't run a server
// still sees its tools, from a computer that does, and its call goes there. This computer's own listing wins; a
// listing is kept only for what that computer's hello names, and within bounds.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { FileMcpTicks, mcpTicksPath } from "../../src/computers/mcp-ticks";
import { MCP_LIST_MAX_BYTES, MCP_LIST_MAX_TOOLS, MCP_LIST_SCHEMA_MAX_BYTES, parseMcpList, type McpListing } from "../../src/computers/mcp-listing";
import type { McpResult, McpServerPlacement } from "../../src/computers/mcp";
import { answersFor, makePhone } from "../tree/answer-support";
import { Cluster, until } from "../tree/cluster-support";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const BOT: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, inputSchema: { type: "object", properties: { scene: { type: "string" } } }, ...extra });

describe("parseMcpList", () => {
  test("keeps only the servers the hello names, each within bounds; a bad server or tool is left out, the rest stays", () => {
    const lines: string[] = [];
    const raw = {
      servers: [
        { server: "blender", plugin: "acme/blender", tools: [tool("Render", { load: "preload" }), tool("Render"), { name: "bad name!", inputSchema: { type: "object" } }, tool("Big", { inputSchema: { type: "object", x: "y".repeat(MCP_LIST_SCHEMA_MAX_BYTES) } }), tool("Arr", { inputSchema: [] })], scope: "bots" },
        { server: "unnamed", plugin: "acme/x", tools: [tool("A")] },
        { server: "../evil", plugin: "acme/x", tools: [] },
        { server: "many", plugin: "acme/x", tools: Array.from({ length: MCP_LIST_MAX_TOOLS + 1 }, (_, i) => tool(`T${i}`)) },
        { server: "blender", plugin: "acme/other", tools: [tool("Twice")] },
      ],
    };
    const out = parseMcpList(raw, ["blender", "../evil", "many"], (l) => lines.push(l));
    expect(out).toEqual([{ server: "blender", plugin: "acme/blender", scope: "bots", tools: [{ name: "Render", inputSchema: { type: "object", properties: { scene: { type: "string" } } }, load: "preload" }] }]);
    expect(lines.some((l) => l.includes("unnamed was left out"))).toBe(true);
    expect(lines.some((l) => l.includes("Render is listed twice"))).toBe(true);
  });

  test("an answer that isn't a listing, or is too large, lists nothing", () => {
    expect(parseMcpList(null, ["blender"])).toEqual([]);
    expect(parseMcpList({ servers: "blender" }, ["blender"])).toEqual([]);
    const huge = { servers: [{ server: "blender", plugin: "acme/blender", tools: [], instructions: "x".repeat(MCP_LIST_MAX_BYTES) }] };
    expect(parseMcpList(huge, ["blender"])).toEqual([]);
  });

  test("a schema's __proto__ key stays data: nothing's prototype changes", () => {
    const raw = JSON.parse('{"servers":[{"server":"blender","plugin":"acme/blender","tools":[{"name":"Render","inputSchema":{"type":"object","__proto__":{"polluted":true}}}]}]}');
    const out = parseMcpList(raw, ["blender"]);
    expect(out[0]!.tools[0]!.name).toBe("Render");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((out[0]!.tools[0]!.inputSchema as Record<string, unknown>).polluted).toBeUndefined();
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
    const calls: string[] = [];
    // What each computer's host runs (and so places and lists): only what's ticked there.
    const runs = (name: "Studio" | "Laptop1") => (s: string) => ticks[name].ticked(s, s === "blender" ? "acme/blender" : "acme/coder");
    const listing = (name: "Studio" | "Laptop1"): McpListing[] => ([
      { server: "blender", plugin: "acme/blender", tools: [{ name: "Render", description: `Render on ${name}`, inputSchema: { type: "object" }, load: "preload" }], instructions: "Blender's notes" },
      { server: "coder", plugin: "acme/coder", tools: [{ name: "Fix", inputSchema: { type: "object" } }], scope: "agents" },
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
          localServers: () => [{ server: "blender", plugin: "acme/blender" }, { server: "coder", plugin: "acme/coder" }],
          listing: () => listing(n),
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
      tools: [{ name: "Render", description: "Render on Studio", inputSchema: { type: "object" }, load: "preload" }],
    }]);
    expect(laptop.node.mcpRemoteServers("coding").map((s) => s.server).sort()).toEqual(["blender", "coder"]);
    expect(studio.node.mcpRemoteServers("bot")).toEqual([]);
    // The call from Laptop1 runs on Studio.
    const ctx = { session: "s_alpha", as: BOT, callId: "c1" };
    const r = await laptop.node.mcp!.run("blender", "Render", { scene: "a" }, ctx);
    expect(r.computer).toBe("Studio");
    expect(calls).toEqual(['Studio blender.Render {"scene":"a"}']);
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
        listing: (): McpListing[] => (ticks[name]!.ticked("blender", "acme/blender") ? [{ server: "blender", plugin: "acme/blender", tools: [{ name: "Render", inputSchema: { type: "object", properties: { computer: { type: "string" } } } }] }] : []),
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
