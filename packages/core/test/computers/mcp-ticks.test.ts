// Which computers run a local MCP server (spec §9.1; the controller's ruling on J-M2's default): each computer ticks
// its own, never synced. The install flow ticks a plugin's servers where its OK card was answered; a synced copy
// elsewhere isn't ticked; Mirror ticks one server on another computer after that computer's card; the user unticks
// one here. The hello names what's ticked, and the `computer` field's list follows.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { FileMcpTicks, mcpTicksPath } from "../../src/computers/mcp-ticks";
import { placementFields, type McpResult, type McpServerPlacement } from "../../src/computers/mcp";
import { answersFor, makePhone } from "../tree/answer-support";
import { Cluster, until } from "../tree/cluster-support";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const BOT: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code ?? "ok";

describe("FileMcpTicks", () => {
  test("the run that creates the file ticks what it finds (the one-time migration); later runs tick only what they're told", () => {
    const path = mcpTicksPath(temp("lane-j-ticks-"));
    const first = new FileMcpTicks(path);
    expect(first.ticked("blender", "acme/blender")).toBe(true);
    const later = new FileMcpTicks(path);
    expect(later.ticked("blender", "acme/blender")).toBe(true);
    // A synced plugin's server arriving after the migration isn't ticked here.
    expect(later.ticked("figma-local", "acme/figma")).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the install flow ticks a plugin's servers; one server's untick wins; each change is told", () => {
    const path = mcpTicksPath(temp("lane-j-ticks-"));
    new FileMcpTicks(path);
    let changes = 0;
    const t = new FileMcpTicks(path, () => changes++);
    expect(t.ticked("render", "acme/tools")).toBe(false);
    t.installed("acme/tools");
    expect(t.ticked("render", "acme/tools")).toBe(true);
    expect(t.ticked("export", "acme/tools")).toBe(true);
    t.set("render", false);
    expect(t.ticked("render", "acme/tools")).toBe(false);
    expect(t.ticked("export", "acme/tools")).toBe(true);
    t.set("render", true);
    expect(changes).toBe(3);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ plugins: { "acme/tools": true }, servers: { render: true } });
    // The same again changes nothing.
    t.installed("acme/tools");
    t.set("render", true);
    expect(changes).toBe(3);
  });
});

describe("a bundled plugin's per-computer server (the controller's ruling, 2026-11-10)", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("runs here by rule on every start, with no OK and no migration; the user's untick sticks across restarts", async () => {
    const home = temp("lane-j-ticks-bundled-");
    // A run before: the file exists, so no one-time migration ticks anything.
    new FileMcpTicks(mcpTicksPath(home));
    const place: McpServerPlacement = { name: "browser", kind: "local", computers: [] };
    let told = 0;
    const opts = (ticks: FileMcpTicks) => ({
      mcp: () => ({
        // The host lists its servers again on every tick change (daemon.ts: PluginMcp.refresh), so an untick stops one.
        onTicksChanged: () => { told++; },
        placement: (s: string) => (s === "browser" || s === "blender" ? place : undefined),
        fields: () => ({}),
        call: async (): Promise<McpResult> => ({ content: [] }),
        scratch: () => "home/Studio",
        localServers: () => [{ server: "browser", plugin: "clover/browser", bundled: true }, { server: "blender", plugin: "acme/blender" }],
        ticks,
      }),
    });
    cluster = new Cluster();
    const first = await cluster.add("Studio", opts(new FileMcpTicks(mcpTicksPath(home))));
    // The bundled one by rule; a third party's, never OK'd or ticked here, not (fail closed).
    expect(first.node.mcpComputers("browser")).toEqual(["Studio"]);
    expect(first.node.mcpComputers("blender")).toEqual([]);
    first.node.mcpTicks.set("browser", false);
    expect(first.node.mcpComputers("browser")).toEqual([]);
    expect(told).toBe(1);
    first.node.mcpTicks.installed("acme/blender");
    expect(told).toBe(2);
    expect(first.node.mcpComputers("blender")).toEqual(["Studio"]);
    cluster.close();
    // A restart (an upgrade reads the same file): the untick holds; ticked again, it runs again.
    cluster = new Cluster();
    const again = await cluster.add("Studio", opts(new FileMcpTicks(mcpTicksPath(home))));
    expect(again.node.mcpComputers("browser")).toEqual([]);
    again.node.mcpTicks.set("browser", true);
    expect(again.node.mcpComputers("browser")).toEqual(["Studio"]);
    expect(JSON.parse(readFileSync(mcpTicksPath(home), "utf8")).servers).toEqual({ browser: true });
  }, 30_000);
});

describe("a local server across two computers", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("installed on Studio only; Mirror ticks it on Laptop1 with its card; the field's list follows; an untick takes it off", async () => {
    const phone = await makePhone();
    const homes = { Studio: temp("lane-j-ticks-studio-"), Laptop1: temp("lane-j-ticks-laptop-") };
    // Both computers ran before (no migration): the plugin is on both, synced, but installed only on Studio.
    for (const h of Object.values(homes)) new FileMcpTicks(mcpTicksPath(h));
    const ticks = { Studio: new FileMcpTicks(mcpTicksPath(homes.Studio)), Laptop1: new FileMcpTicks(mcpTicksPath(homes.Laptop1)) };
    ticks.Studio.installed("acme/blender");
    const calls: string[] = [];
    const place: McpServerPlacement = { name: "blender", kind: "local", computers: [] };
    cluster = new Cluster();
    const opts = {
      answers: () => answersFor(phone),
      askUser: () => phone.ask,
      mcp: (name: string) => ({
        placement: (s: string) => (s === "blender" ? place : undefined),
        fields: () => placementFields({ ...place, computers: ["a", "b"] }, [{ name: "Render", inputSchema: { type: "object" as const } }]).fields,
        call: async (c: { server: string; tool: string }): Promise<McpResult> => { calls.push(`${name} ${c.server}.${c.tool}`); return { content: [{ type: "text", text: name }] }; },
        scratch: () => `home/${name}`,
        localServers: () => [{ server: "blender", plugin: "acme/blender" }],
        ticks: ticks[name as "Studio" | "Laptop1"],
      }),
    };
    const studio = await cluster.add("Studio", opts);
    const laptop = await cluster.add("Laptop1", opts);
    await laptop.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" });
    await cluster.join();
    expect(studio.node.mcpComputers("blender")).toEqual(["Studio"]);
    await until(() => laptop.node.mcpComputers("blender").join() === "Studio", 5000, "Laptop1 to hear Studio runs blender");
    const ctx = { session: "s_alpha", as: BOT, callId: "c1" };
    // Not on Laptop1 yet: the field's live list refuses it.
    expect(await code(studio.node.mcp!.run("blender", "Render", { computer: "Laptop1" }, ctx))).toBe("invalid");
    // Mirror: Laptop1's own card, the phone's yes, and Laptop1 ticks it; Studio hears at once.
    expect(await studio.node.mirror("blender", null, ["Laptop1"], "s_alpha")).toEqual({ installed: ["Laptop1"], failed: [] });
    expect(phone.shown.map((n) => [n.computer, n.method])).toEqual([["Laptop1", "mcp.mirror"]]);
    await until(() => studio.node.mcpComputers("blender").join() === "Studio,Laptop1", 5000, "Studio to hear Laptop1 runs blender");
    const r = await studio.node.mcp!.run("blender", "Render", { computer: "Laptop1" }, { ...ctx, callId: "c2" });
    expect(r.computer).toBe("Laptop1");
    expect(calls).toEqual(["Laptop1 blender.Render"]);
    // The user unticks it on Laptop1: it comes off the list everywhere.
    laptop.node.mcpTicks.set("blender", false);
    await until(() => studio.node.mcpComputers("blender").join() === "Studio", 5000, "Studio to hear Laptop1 dropped blender");
    expect(await code(studio.node.mcp!.run("blender", "Render", { computer: "Laptop1" }, { ...ctx, callId: "c3" }))).toBe("invalid");
    // Mirror to a computer where the plugin hasn't synced: refused there, nothing ticked.
    const none = await studio.node.mirror("not-here", null, ["Laptop1"]);
    expect(none.failed[0]).toMatchObject({ computer: "Laptop1", code: "not_installed" });
  }, 30_000);
});
